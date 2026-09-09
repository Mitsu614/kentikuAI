// テナント別「学習コンテキスト」の組み立て。
//
// ここは何か:
//   その会社の実績（修正履歴・確定実績アンカー・OCRで読み取った書類・現場メモ・チャットで
//   教わった好み）を、AI見積プロンプトに載せる文章に変える。学習ループの出口そのもの。
//
// なぜ main.ts から切り出したか:
//   この心臓部が 10,000行の main.ts の巨大関数の内側にあり、外から呼べなかった。
//   そのため「OCRで紐づけた実績が1件もプロンプトに載っていない」「アンカーが隔離テナントでしか
//   出ない」といった穴に、実際の見積が外れるまで気づけなかった。
//   関数にしてハーネス（tools/harness-learning-context）から直接叩けるようにする。
//   ★ここを直したらハーネスも回すこと。本番と同じ関数を測っているので、コピーのズレは起きない。

import { queryAll, queryOne } from '../database/database';

// OCRした見積書の「見出し行（工事名 1式 ◯◯円）」は、その下に並ぶ内訳と金額が重複する。
// これを明細として足すと原価が実際の2倍になり、掛率も売価/原価が1を割って学習を壊す。
// （実例: 森鉄筋 養老工場の見積書。明細合計¥1,002,000 に対し税抜総額は¥500,000）
// 明細合計が小計を明らかに超える場合、「他の全明細の合計とほぼ同額の行」を見出し行とみなして落とす。
export function dropSummaryRows(items: any[], subtotal: any): any[] {
  if (!Array.isArray(items) || items.length < 2) return items || [];
  const sub = Number(subtotal) || 0;
  const amountOf = (i: any) => Number(i?.amount) || (Number(i?.quantity) || 1) * (Number(i?.unitPrice) || 0);
  let rows = items.slice();
  for (let pass = 0; pass < 2; pass++) {
    const sum = rows.reduce((s, i) => s + amountOf(i), 0);
    if (sub <= 0 || sum <= sub * 1.05) break;
    // 自分を除いた残りの合計と2%以内で一致する行 ＝ 見出し行
    const idx = rows.findIndex(i => {
      const a = amountOf(i);
      const rest = sum - a;
      return a > 0 && rest > 0 && Math.abs(a - rest) <= rest * 0.02;
    });
    if (idx < 0) break;
    console.warn(`[OCR] 見出し行を明細から除外: ${rows[idx]?.name} ¥${amountOf(rows[idx]).toLocaleString()}（明細合計¥${sum.toLocaleString()} / 小計¥${sub.toLocaleString()}）`);
    rows = rows.filter((_, n) => n !== idx);
  }
  return rows;
}

export interface LearningContextOptions {
  /** 見積対象のテナント。管理者のテナント切替時は切替先が入る */
  estTid: number;
  /** 隔離学習テナント（相場が存在しない専門商材。自社実績が唯一の正解） */
  isolated: boolean;
  /** 遮熱シート業種（isolated の付け忘れ事故を防ぐため、業種でも必ずアンカーを出す） */
  heatshield: boolean;
}

export interface LearningContext {
  /** 修正履歴の元データ。売価の偏りの計算にも使う */
  feedbackRows: any[];
  /** 修正履歴＋実績価格アンカー＋OCR書類アンカー */
  feedbackSummary: string;
  /** 読み取った書類への現場メモ（紐づけコメント） */
  ocrCommentSummary: string;
  /** この会社の好み・掛率のクセ・売価の偏り */
  fitSummary: string;
}

export function buildLearningContext(opts: LearningContextOptions): LearningContext {
  const { estTid, isolated, heatshield } = opts;
    // 隔離テナント（特許遮熱シート等・相場が存在しない商材）は、自社実績が唯一の正解データ。
    // → 取り込む実績件数を大幅に増やして「テナント内でめっちゃ学習」させる。
    const feedbackLimit = isolated ? 200 : 50;

    // AI見積 vs 実際の編集結果のフィードバックデータを生成（学習ループ: 確定実績のみ使用）
    // constructions の fixed_selling_price / labor_cost や construction_materials の合計は使わない。
    // AI見積は自動で constructions に保存されるため、それを「修正後の実額」として拾うと
    // AI自身の出力を再学習して金額が暴走する（実績アンカー側と同じ理由で確定実績のみに限定）。
    const feedbackRows = queryAll(`
      SELECT el.work_type, el.building_age, el.structure,
        el.ai_material_cost, el.ai_labor_cost, el.ai_total, el.ai_markup_rate,
        el.actual_material_cost, el.actual_labor_cost, el.actual_markup_rate, el.actual_selling_price,
        el.ai_json, el.feedback_at
      FROM estimate_log el
      WHERE el.tenant_id = ? AND el.feedback_at IS NOT NULL
        AND (el.actual_material_cost > 0 OR el.actual_labor_cost > 0 OR el.actual_selling_price > 0)
      ORDER BY el.feedback_at DESC
      LIMIT ${feedbackLimit}
    `, [estTid]);

    let feedbackSummary = '';
    if (feedbackRows.length > 0) {
      const corrections: string[] = [];
      for (const fb of feedbackRows) {
        // 予実管理の入力欄は空欄を 0 として保存する（BudgetPage）。0 は「未入力」であって
        // 「0円に修正された」ではないので、両側が正の値の項目だけを修正履歴として扱う。
        const aiMat = Number(fb.ai_material_cost) || 0, aiLabor = Number(fb.ai_labor_cost) || 0;
        const aiTotal = Number(fb.ai_total) || 0;
        const actMat = Number(fb.actual_material_cost) || 0, actLabor = Number(fb.actual_labor_cost) || 0;
        const actTotal = Number(fb.actual_selling_price) || 0;
        const hasMat = aiMat > 0 && actMat > 0;
        const hasLabor = aiLabor > 0 && actLabor > 0;
        const hasTotal = aiTotal > 0 && actTotal > 0;
        const matDiff = actMat - aiMat, laborDiff = actLabor - aiLabor, totalDiff = actTotal - aiTotal;
        const matPct = hasMat ? Math.round((matDiff / aiMat) * 100) : 0;
        const laborPct = hasLabor ? Math.round((laborDiff / aiLabor) * 100) : 0;
        const totalPct = hasTotal ? Math.round((totalDiff / aiTotal) * 100) : 0;

        // 5%以上の差分がある場合フィードバック
        if (Math.abs(matPct) >= 5 || Math.abs(laborPct) >= 5 || Math.abs(totalPct) >= 5) {
          // 改修・修繕は同じ工事種別でも築年数で実額が大きく変わる。どの築年帯・構造の実績かを
          // 明示して、AIが「今回に近い築年帯の修正傾向」を優先できるようにする。
          const fbAge = Number(fb.building_age) || 0;
          const ageBand = fbAge > 0 ? `築${Math.floor(fbAge / 10) * 10}年台` : '';
          const cond = [fb.structure || '', ageBand].filter(Boolean).join('・');
          const parts: string[] = [cond ? `${fb.work_type}【${cond}】` : `${fb.work_type}`];
          if (Math.abs(matPct) >= 5) parts.push(`材料費: AI${aiMat.toLocaleString()}円→修正後${actMat.toLocaleString()}円(${matDiff > 0 ? '+' : ''}${matPct}%)`);
          if (Math.abs(laborPct) >= 5) parts.push(`人件費: AI${aiLabor.toLocaleString()}円→修正後${actLabor.toLocaleString()}円(${laborDiff > 0 ? '+' : ''}${laborPct}%)`);
          if (Math.abs(totalPct) >= 5) parts.push(`売価: AI${aiTotal.toLocaleString()}円→修正後${actTotal.toLocaleString()}円(${totalDiff > 0 ? '+' : ''}${totalPct}%)`);
          const aiMk = Number(fb.ai_markup_rate) || 0, actMk = Number(fb.actual_markup_rate) || 0;
          if (aiMk > 0 && actMk > 0 && actMk !== aiMk) parts.push(`掛率: AI${aiMk}→実際${actMk}`);

          // AI見積のbreakdownから削除・追加された項目を検出
          try {
            const aiResult = JSON.parse(fb.ai_json);
            const aiItems = (aiResult.breakdown || []).map((b: any) => b.item);
            const actualMats = queryAll(
              `SELECT m.name FROM construction_materials cm JOIN materials m ON m.id = cm.material_id WHERE cm.construction_id = (SELECT construction_id FROM estimate_log WHERE ai_json = ? LIMIT 1)`,
              [fb.ai_json]
            ).map((m: any) => m.name);
            const added = actualMats.filter((n: string) => !aiItems.some((ai: string) => n.includes(ai) || ai.includes(n)));
            const removed = aiItems.filter((ai: string) => !actualMats.some((n: string) => n.includes(ai) || ai.includes(n)));
            if (added.length > 0) parts.push(`追加された項目: ${added.slice(0, 3).join(', ')}`);
            if (removed.length > 0) parts.push(`削除された項目: ${removed.slice(0, 3).join(', ')}`);
          } catch (e) { console.error('Estimate feedback material diff failed:', e); }

          corrections.push(parts.join(' | '));
        }
      }
      if (corrections.length > 0) {
        feedbackSummary = `\n## ★★★ 過去のAI見積に対するユーザー修正履歴（最重要）★★★\n以下は過去のAI見積が実際にどう修正されたかの記録です。これはお客様が「正しい金額」として修正した実績データです。\n同じ種類の工事では、必ずこの修正傾向を反映して金額を調整してください。\n例: 過去に材料費が+20%修正されていたら、今回も同種の工事では材料費を20%高めに見積もること。
★【】内は「その実績の構造・築年帯」だ。改修・修繕・解体では、同じ工事種別でも築年帯で実額が大きく変わる。
　今回の物件と**同じ構造・最も近い築年帯**の履歴を最優先で当てはめろ（一般論の年数目安より、この自社実績が優先）。
　該当する築年帯の履歴が無い場合のみ、工事種別だけで平均した傾向を使え。\n${corrections.join('\n')}\n`;
      }
    }

    // 【隔離テナント／遮熱シート業種】自社実績の「実際の価格そのもの」を価格アンカーとして渡す。
    // 相場が無い特許商材（遮熱シート等）は、差分学習だけでなく“実際に成約した金額”を
    // 絶対基準にした方が精度が出る。差分の有無に関わらず全実績を工事タイプ別に列挙する。
    // ★isolatedフラグの付け忘れで実績が効かず高値へ暴走する事故を防ぐため、遮熱シート業種の
    //   テナントは isolated が未設定でも必ずアンカーを発火させる（あくまで tenant_id 単位＝他社へ漏れない）。
    // ── 自社の確定実績を「価格アンカー」としてプロンプトに載せる ──
    // 以前は隔離テナント（相場が存在しない専門商材）だけに出していた。だが通常テナントでも
    // 自社が実際に成約した金額は全国相場より確かな正解で、OCRで読み取った過去の見積書が
    // 1枚もプロンプトに載らないのは学習の穴だった。通常テナントにも出す。
    // ただし言い方と件数は変える:
    //   隔離・遮熱 … 相場が存在しない。実績が唯一の正解 → 「必ず合わせろ」
    //   通常       … 相場も使える。実績は最優先の参考値 → 「似た工事なら実績に寄せろ」
    const strongAnchor = isolated || heatshield;
    const anchorLimit = strongAnchor ? 200 : 60;
    const ocrAnchorLimit = strongAnchor ? 40 : 15;
    {
      try {
        // ★確定した実績(actual_*)だけをアンカーにする。fixed_selling_price や
        //   construction_materials の合計＝AIが自動生成した見積そのものなので、これをアンカーに
        //   使うと「自分の高い出力を実績として再学習」する悪循環になる。確定実績が無い工事は除外。
        const anchorRows = queryAll(`
          SELECT c.title as work_type,
            COALESCE(c.actual_material_cost, 0) as mat,
            COALESCE(c.actual_labor_cost, 0) as labor,
            COALESCE(c.actual_selling_price, 0) as sell,
            c.markup_rate, c.notes, c.construction_date
          FROM constructions c
          WHERE c.tenant_id = ?
          ORDER BY c.id DESC
          LIMIT ${anchorLimit}
        `, [estTid]);
        const anchors = anchorRows
          .filter((r: any) => (r.sell || 0) > 0 || (r.mat || 0) > 0)
          .map((r: any) => {
            const method = (r.notes || '').split('\n')[0] || '';
            const bits = [`${r.work_type || '工事'}`];
            if (method && !`${r.work_type}`.includes(method)) bits.push(`工法/メモ:${method}`);
            if (r.mat > 0) bits.push(`材料費¥${Math.round(r.mat).toLocaleString()}`);
            if (r.labor > 0) bits.push(`人件費¥${Math.round(r.labor).toLocaleString()}`);
            if (r.sell > 0) bits.push(`成約売価¥${Math.round(r.sell).toLocaleString()}`);
            return `- ${bits.join(' / ')}`;
          });
        if (anchors.length > 0) {
          feedbackSummary += strongAnchor
            ? `\n## ★★★ 自社の実績価格アンカー（この会社の唯一の正解データ・最優先で合わせろ）★★★\nこの会社は相場が存在しない専門商材を扱うため、全国相場や汎用単価は当てにならない。\n以下は実際に自社が成約・実施した価格そのもの。同じ工事・同じ工法では、必ずこの実績価格帯に金額を合わせること。\n相場データと矛盾する場合は、必ず下記の自社実績価格を優先せよ。\n実績が近いものが無い場合のみ、最も近い工法の自社実績から推定し、confidenceを下げること。\n${anchors.join('\n')}\n`
            : `\n## ★★★ 自社の確定実績の価格（全国相場より優先する参考値）★★★\n以下はこの会社が実際に成約・実施した金額そのもの。全国相場や一般単価より、まずこの実績に寄せて見積もること。\nただし工事の内容・規模が明らかに違うものへ無理に合わせないこと。似た実績が無ければ相場で積み、confidenceを下げよ。\n${anchors.join('\n')}\n`;
          console.log(`学習: 自社実績アンカー ${anchors.length}件をプロンプトに投入（${strongAnchor ? '隔離・最優先' : '通常・参考値'}）`);
        }
      } catch (e) { console.error('自社実績アンカー生成失敗:', e); }

      // 過去にAI-OCRで読み取った書類（見積書・請求書PDF/画像）も価格アンカーにする。
      // 山下さんの過去の遮熱シート見積書PDFを読み込むほど、その実際の金額・明細で学習が進む。
      try {
        const ocrRows = queryAll(
          `SELECT document_type, title, total, ocr_json, comment, created_at
           FROM ocr_log WHERE tenant_id = ? AND (total > 0 OR ocr_json IS NOT NULL)
           ORDER BY id DESC LIMIT ${ocrAnchorLimit}`,
          [estTid]
        );
        const ocrAnchors: string[] = [];
        const seenDocs = new Set<string>();
        for (const r of ocrRows) {
          const bits: string[] = [`[${r.document_type || '書類'}] ${r.title || '（件名なし）'}`];
          if (r.total > 0) bits.push(`合計¥${Math.round(r.total).toLocaleString()}`);
          // 明細から単価付き項目を抽出。遮熱/特許/シート（＝この会社の唯一の正解データ）は
          // 打ち切らず必ず全項目残し、その他項目のみ上限を設ける（過去PDFの実単価を厚く学習）。
          try {
            const oj = JSON.parse(r.ocr_json || '{}');
            // 見出し行（工事名 1式 ◯◯円）は内訳と金額が重複する。アンカーに載せると
            // AIが「本体は◯◯円/式」と誤学習するので、ここでも必ず落とす。
            const items = dropSummaryRows(Array.isArray(oj.items) ? oj.items : [], oj.subtotal);
            const priced = items.filter((it: any) => it && it.name && (it.unitPrice > 0 || it.amount > 0));

            // 同じ書類を複数回取り込んでいると、同じ単価が何度もアンカーに並んで重み付けが狂う。
            // 件名で照合していたが、OCRが工法名を読み違えると（スカイ工法／スカイエ法／スカイエ工法）
            // 別書類とみなされ、森鉄筋様の1枚が3回並んでいた。金額の並びで同一性を判定する。
            const docKey = `${Math.round(r.total || 0)}|${priced.map((it: any) => Math.round(it.amount || it.unitPrice || 0)).join(',')}`;
            if (seenDocs.has(docKey)) continue;
            seenDocs.add(docKey);
            const isCore = (it: any) => /(遮熱|特許|シート|工法|カバー|葺|内張|外張|吹付)/.test(it.name || '');
            // ★数量は単価があるときも必ず載せる。
            // 以前は単価があると数量を落としていた。その結果、森鉄筋様の実績が
            //   「スカイ工法施工 折板屋根用 足場面積 33.8m(折板屋根面積×1.4) ¥6,500/㎡（金額¥312,000）」
            // としてAIに渡り、見積数量の 48㎡ がどこにも現れなかった。AIに見える面積は
            // 品名の中の 33.8 だけなので「6,500円/㎡ × 屋根面積」と読むしかない。
            // 実際、早川鉄筋様の見積で屋根面積725.8㎡にそのまま単価を掛け、展開係数1.4を落とした。
            const fmt = (it: any) => {
              const u = it.unitPrice > 0 ? `¥${Math.round(it.unitPrice).toLocaleString()}${it.unit ? '/' + it.unit : ''}` : '';
              const qty = it.quantity > 0 ? `数量${it.quantity}${it.unit || ''}` : '';
              const amt = it.amount > 0 ? `金額¥${Math.round(it.amount).toLocaleString()}` : '';
              const tail = [qty, u, amt].filter(Boolean).join(' × ').replace(' × 金額', ' ＝ 金額');
              return `${it.name}${tail ? ' ' + tail : ''}`;
            };
            const core = priced.filter(isCore);          // 遮熱シート本体系は全部残す（打ち切らない）
            const others = priced.filter((it: any) => !isCore(it)).slice(0, 12); // その他は最大12件
            const detail = [...core.map(fmt), ...others.map(fmt)];
            if (detail.length > 0) bits.push(`明細(${core.length}件が遮熱系/計${priced.length}件): ${detail.join(' / ')}`);
          } catch (_) {}
          if (r.comment) bits.push(`メモ: ${r.comment}`);
          ocrAnchors.push(`- ${bits.join(' | ')}`);
        }
        if (ocrAnchors.length > 0) {
          feedbackSummary += strongAnchor
            ? `\n## ★★★ 過去に読み取った自社書類（見積書・請求書）の実額（最優先アンカー）★★★\n以下はこの会社が実際に発行した見積書・請求書をOCRで読み取った実データ。金額・単価・明細はすべて実際に使われた正解値。\n同じ工種・同じ工法では、必ずこの実額・実単価に合わせて見積もること。全国相場より必ずこちらを優先せよ。\n${ocrAnchors.join('\n')}\n`
            : `\n## ★★★ 過去に読み取った自社書類（見積書・請求書）の実額 ★★★\n以下はこの会社が実際に発行した見積書・請求書をOCRで読み取った実データ。金額・単価・明細は実際に使われた値。\n同じ工種・同じ工法があれば、全国相場よりこの実単価を優先して見積もること。\n${ocrAnchors.join('\n')}\n`;
          console.log(`学習: 過去OCR書類アンカー ${ocrAnchors.length}件をプロンプトに投入（${strongAnchor ? '隔離・最優先' : '通常・参考値'}）`);
        }
      } catch (e) { console.error('OCR書類アンカー生成失敗:', e); }
    }

    // 過去の読み取り書類へのコメント（現場メモ＝紐づけ情報）をプロンプトに反映 → 学習
    let ocrCommentSummary = '';
    try {
      const commentRows = queryAll(
        `SELECT title, document_type, total, comment, created_at FROM ocr_log
         WHERE tenant_id = ? AND comment IS NOT NULL AND comment != ''
         ORDER BY created_at DESC LIMIT 30`,
        [estTid]   // ★getCurrentTenant() だと管理者のテナント切替時に別テナントのメモが混ざる
      );
      if (commentRows.length > 0) {
        const lines = commentRows.map((r: any) =>
          `- ${r.title || r.document_type || '書類'}${r.total ? `（¥${Math.round(r.total).toLocaleString()}）` : ''}: ${r.comment}`
        ).join('\n');
        ocrCommentSummary = `\n## ★ 過去の実績書類への現場メモ（担当者コメント・最重要の補足）★\n以下は読み取った過去の見積書・請求書に対して、この会社の担当者が付けたメモです。金額の根拠・工法・特殊事情が書かれています。同種の工事ではこのメモの内容を必ず反映して見積もってください。\n${lines}\n`;
      }
    } catch (e) { console.error('OCRコメント取得失敗:', e); }

  const fitSummary = (() => {
  // ── テナント別「クセ・好み」フィット（先方の値付け・好みにめっちゃ合わせる）──
  const lines: string[] = [];
  try {
    // 1) 明示的な好み（チャット/実績から学習・確信度の高い順）
    const chatMemos = queryAll('SELECT category, key, value, confidence FROM chat_learnings WHERE tenant_id = ? ORDER BY confidence DESC, category', [estTid]);
    if (chatMemos.length > 0) {
      lines.push('【この会社が明示した好み・ルール（必ず守れ）】');
      for (const m of chatMemos) {
        const strong = (m.confidence || 0) >= 0.5 ? '★繰り返し確認済み・特に厳守: ' : '';
        lines.push(`- ${strong}[${m.category}] ${m.key}: ${m.value}`);
      }
    }
  } catch (_) {}
  try {
    // 2) 習慣的な掛率（この会社の値付けのクセ）
    const mk = queryOne('SELECT AVG(markup_rate) as avg_mk, COUNT(*) as cnt FROM constructions WHERE tenant_id = ? AND markup_rate > 0', [estTid]);
    if (mk && mk.cnt >= 3 && mk.avg_mk > 0) {
      lines.push(`【値付けのクセ】この会社は過去${mk.cnt}件で掛率が平均 約${Math.round(mk.avg_mk * 100)}%。粗利率ルールより、まずこの会社の実掛率に寄せて売価を出すこと。`);
    }
  } catch (_) {}
  try {
    // 3) AI見積に対する系統的な偏り（毎回いくらか高め/低めに直す傾向）
    let sum = 0, n = 0;
    for (const fb of feedbackRows) {
      if (fb.ai_total > 0 && fb.actual_selling_price > 0) {
        sum += ((fb.actual_selling_price - fb.ai_total) / fb.ai_total) * 100; n++;
      }
    }
    if (n >= 3) {
      const bias = Math.round(sum / n);
      if (Math.abs(bias) >= 4) {
        lines.push(`【売価の偏り】この会社は過去${n}件でAI見積を平均${bias > 0 ? '+' : ''}${bias}%に修正している。今回も同傾向を見込み、売価を${bias > 0 ? '高め' : '低め'}(約${bias > 0 ? '+' : ''}${bias}%)に寄せること。`);
      }
    }
  } catch (_) {}
  if (lines.length === 0) return '';
  return '\n## ★★★ この会社にフィットさせる（最優先・相場より優先）★★★\n以下はこの会社（テナント）固有の好み・値付けのクセ。全国相場や一般ルールより、まずこの会社の傾向に必ず合わせること。\n' +
    lines.join('\n') + '\n';
  })();
  return { feedbackRows, feedbackSummary, ocrCommentSummary, fitSummary };
}
