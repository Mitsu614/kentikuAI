// OCRで読み取った書類（見積書・請求書）を、実績としてDBへ取り込む。
//
// なぜ main.ts から切り出したか:
//   ここは「実績が確定する瞬間」で、学習の入口そのもの。にもかかわらず IPC ハンドラの
//   内側にあり、Electron を起動しないと1行も動かせなかった。そのため
//   「既存工事に紐づけたときだけ actual_* を書いていない」という穴が、AIが金額を
//   外すまで誰にも見えなかった。関数にしてハーネスから直接叩けるようにする。
//   ★ここを直したら tools/harness-ocr-import を回すこと。
//
// この関数の責務は「DBへ書くこと」だけ。
//   現場写真のディスク退避・学習ループへの通知とクラウド送信・監査ログ・オーナー通知は、
//   Electron 側の都合なので呼び出し側（main.ts）に残してある。

import { queryAll, queryOne, runSql } from '../database/database';
import { dropSummaryRows } from './learning-context';

/** 確定した実績。学習ループへ流す形 */
export interface OcrActualFeedback {
  work_type: string;
  ai_material_cost: number;
  ai_labor_cost: number;
  ai_total: number;
  ai_markup_rate: number;
  actual_material_cost: number;
  actual_labor_cost: number;
  actual_selling_price: number;
  actual_markup_rate: number;
  accuracy_ratio: number | null;
}

export interface OcrImportDeps {
  /** 取り込み先のテナント */
  tenantId: number;
  /** 確定実績の通知・クラウド送信（隔離判定は呼び出し側の責任） */
  reportActuals?: (fb: OcrActualFeedback) => void;
  /** 現場写真をディスクへ退避して物件に紐づける */
  saveSiteImages?: (images: string[], propertyId: number) => void;
  /** JSTの現在時刻。テストで固定するため差し替えられる */
  now?: () => string;
}

export interface OcrImportResult {
  propertyId: number;
  constructionId: number;
  invoiceId: number;
  /** 既存工事に紐づけたか（＝AI見積の答え合わせか） */
  linked: boolean;
  materialTotal: number;
  laborCost: number;
  sellingPrice: number;
  markupRate: number;
  siteImages: string[];
}

export function importOcrResultCore(data: any, deps: OcrImportDeps): OcrImportResult {
  const nowJst = deps.now || (() => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace('T', ' '));
    const today = new Date().toISOString().split('T')[0];
    const tid = deps.tenantId;
    const linkConstructionId = data._linkConstructionId || null;

    // ★紐づけ絶対★
    // 既存工事に紐づけないOCR取り込みは「新規案件」になる。新規案件は現場写真が無いと、
    // どの建物の・どの屋根の金額なのかが永久に分からなくなり、実績として使えない。
    // 画面側でも止めているが、ここでも必ず弾く（画面の実装漏れやIPC直叩きを許さない）。
    const siteImages: string[] = Array.isArray(data._siteImages) ? data._siteImages.filter((s: any) => typeof s === 'string' && s.length > 100) : [];
    if (!linkConstructionId && siteImages.length === 0) {
      throw new Error('ERROR: 既存の工事に紐づけるか、新規案件として現場写真を1枚以上添付してください。写真の無い新規案件は登録できません。');
    }

    // 金額計算（税抜に統一）
    const taxRate = data.taxRate || 0.1;
    let laborCost = 0;
    let materialTotal = 0;
    const items = dropSummaryRows(data.items, data.subtotal);
    for (const item of items) {
      const amt = item.amount || (item.quantity || 1) * (item.unitPrice || 0);
      if (item.name && (item.name.includes('人件費') || item.name.includes('施工費') || item.name.includes('労務費'))) {
        laborCost += amt;
      } else {
        materialTotal += amt;
      }
    }
    const totalCost = materialTotal + laborCost;
    // subtotalがあればそれは税抜、totalしかなければ税抜に変換
    const sellingPrice = data.subtotal || (data.total ? Math.round(data.total / (1 + taxRate)) : totalCost);
    const markupRate = totalCost > 0 ? Math.round((sellingPrice / totalCost) * 100) / 100 : 1.3;

    let propertyId: number;
    let conId: number;
    // ★紐づけたときの「AI側の金額」。estimate_log に答え合わせとして残すためブロックの外に置く。
    let linkedAiMaterial = 0, linkedAiLabor = 0, linkedAiTotal = 0, linkedAiMarkup = 1.3, linkedWorkType = '';

    if (linkConstructionId) {
      // 既存の施工に紐づける場合
      const existing = queryAll('SELECT * FROM constructions WHERE id = ?', [linkConstructionId])[0];
      if (!existing) throw new Error('指定された施工履歴が見つかりません');
      conId = linkConstructionId;
      propertyId = existing.property_id;

      // 既存施工のAI見積データを取得（学習ループ用）
      const aiMaterials = queryAll('SELECT SUM(quantity * unit_price) as total FROM construction_materials WHERE construction_id = ?', [conId]);
      const aiMaterialCost = aiMaterials[0]?.total || 0;
      const aiLaborCost = existing.labor_cost || 0;
      const aiTotal = aiMaterialCost + aiLaborCost;
      linkedAiMaterial = aiMaterialCost; linkedAiLabor = aiLaborCost; linkedAiTotal = aiTotal;
      linkedAiMarkup = existing.markup_rate || 1.3; linkedWorkType = existing.title || 'その他';

      // 実績データとして学習ループに送信
      const workType = existing.title || 'その他';
      const feedbackData = {
        work_type: workType,
        ai_material_cost: aiMaterialCost,
        ai_labor_cost: aiLaborCost,
        ai_total: aiTotal,
        ai_markup_rate: existing.markup_rate || 1.3,
        actual_material_cost: materialTotal,
        actual_labor_cost: laborCost,
        actual_selling_price: sellingPrice,
        actual_markup_rate: markupRate,
        accuracy_ratio: aiTotal > 0 ? Math.round((sellingPrice / aiTotal) * 100) / 100 : null,
      };

      // 学習ループへの通知・送信は呼び出し側（main.ts）に任せる。
      // 隔離判定もクラウド送信もElectron側の都合で、DBへ書くこととは別の話。
      deps.reportActuals?.(feedbackData);

      // ★読み取った書類の金額は「実際に出した金額」＝確定実績。actual_* に必ず書く。
      //   ここが抜けていたため、既存工事に紐づけたPDFは自社の実績価格アンカー
      //   （learning-context.ts が constructions.actual_* から作る）に一件も載らなかった。
      //   新規取込のほうは actual_* を書いていたので、紐づけだけが穴だった。
      runSql("UPDATE constructions SET actual_material_cost = ?, actual_labor_cost = ?, actual_selling_price = ? WHERE id = ?",
        [materialTotal, laborCost, sellingPrice, conId]);

      // 施工のnotesに実績紐付けを記録
      runSql('UPDATE constructions SET notes = COALESCE(notes, \'\') || ? WHERE id = ?',
        [`\n\n【実績紐付け済み】${data.documentType}: ${data.issuerName || ''}\n実績金額: ¥${sellingPrice.toLocaleString()}`, conId]);

    } else {
      // 新規作成（従来の動作）
      propertyId = runSql('INSERT INTO properties (name, address, notes, tenant_id) VALUES (?,?,?,?)',
        [data.title || '読み取り書類', data.clientAddress || null, `OCR取り込み: ${data.documentType}\n発行元: ${data.issuerName || ''}`, tid]);

      // ★OCRで読み取った書類は「実際に出した金額」そのもの＝確定実績。actual_* に必ず書く。
      //   確定実績アンカー(analyzeImageCore)は actual_* しか読まないため、ここを空にすると
      //   PDFを何件取り込んでもアンカーが発火せず、AIが相場に引っ張られて金額を外す。
      conId = runSql(
        'INSERT INTO constructions (property_id, title, construction_date, labor_cost, markup_rate, notes, tenant_id, actual_material_cost, actual_labor_cost, actual_selling_price) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [propertyId, data.title || 'OCR取り込み工事', data.issueDate || today, laborCost, markupRate,
         `OCR取り込み\n発行元: ${data.issuerName || ''}`, tid, materialTotal, laborCost, sellingPrice]
      );

      // 現場写真のディスク退避も呼び出し側へ（保存先はElectronのuserDataなので）
      deps.saveSiteImages?.(siteImages, propertyId);

      // 材料明細（見出し行を除いた明細を使う。見出し行を入れると原価が2倍になる）
      for (const item of items) {
        if (item.name && (item.name.includes('人件費') || item.name.includes('施工費') || item.name.includes('労務費'))) continue;
        const matId = runSql('INSERT INTO materials (name, category, unit, unit_price, notes, tenant_id) VALUES (?,?,?,?,?,?)',
          [item.name || '（品名不明）', item.category || 'その他', item.unit || '式', item.unitPrice || item.amount || 0, 'OCR取り込み', tid]);
        runSql('INSERT INTO construction_materials (construction_id, material_id, quantity, unit_price) VALUES (?,?,?,?)',
          [conId, matId, item.quantity || 1, item.unitPrice || item.amount || 0]);
      }

      // 新規OCR取込も「実績が確定した」扱い。通知・送信は呼び出し側へ。
      if (materialTotal > 0 || laborCost > 0) {
        deps.reportActuals?.({
          work_type: data.title || 'OCR取込',
          ai_material_cost: materialTotal,
          ai_labor_cost: laborCost,
          ai_total: sellingPrice,
          ai_markup_rate: markupRate,
          actual_material_cost: materialTotal,
          actual_labor_cost: laborCost,
          actual_selling_price: sellingPrice,
          actual_markup_rate: markupRate,
          accuracy_ratio: 1.0,
        });
      }
    }

    // 請求書（どちらの場合も作成）
    const dueDate = data.dueDate || null;
    const invId = runSql('INSERT INTO invoices (construction_id, client_name, client_address, issue_date, due_date, amount, tax_rate, notes, status, tenant_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [conId, data.clientName || '（読み取り）', data.clientAddress || null, data.issueDate || today, dueDate, sellingPrice, data.taxRate || 0.1, `OCR取り込み\n${data.notes || ''}`, 'draft', tid]);

    // estimate_logにOCR取込の結果を記録
    try {
      const jstNow = nowJst();
      if (linkConstructionId) {
        // ★既存工事への紐づけ＝「AIの見積は実際いくらだったのか」の答え合わせそのもの。
        //   修正履歴の抽出条件は feedback_at IS NOT NULL かつ actual_* > 0（learning-context.ts）。
        //   ここで actual_* と feedback_at を書いていなかったため、PDFを何枚紐づけても
        //   修正履歴にも売価の偏りにも一件も入らず、次の見積に何も効いていなかった。
        const prevLog = queryOne('SELECT id FROM estimate_log WHERE construction_id = ? ORDER BY id DESC LIMIT 1', [conId]);
        if (prevLog) {
          runSql(
            'UPDATE estimate_log SET actual_material_cost=?, actual_labor_cost=?, actual_selling_price=?, actual_markup_rate=?, feedback_at=? WHERE id=?',
            [materialTotal, laborCost, sellingPrice, markupRate, jstNow, prevLog.id]
          );
        } else {
          // AI見積を経由せず作られた工事に紐づけた場合。AI側は施工に入っている金額を使う。
          runSql(
            'INSERT INTO estimate_log (tenant_id, construction_id, work_type, ai_material_cost, ai_labor_cost, ai_total, ai_markup_rate, actual_material_cost, actual_labor_cost, actual_selling_price, actual_markup_rate, ai_json, feedback_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [tid, conId, linkedWorkType || data.title || 'OCR取込', linkedAiMaterial, linkedAiLabor, linkedAiTotal, linkedAiMarkup,
             materialTotal, laborCost, sellingPrice, markupRate, JSON.stringify(data), jstNow, jstNow]
          );
        }
      } else {
        // 新規取込は「AIの見積」が存在しない（書類がそのまま実額）。ここで actual_* を入れて
        // feedback_at を立てると、差0%の対が売価の偏りの平均を薄めるだけなので入れない。
        // 新規分の実額は constructions.actual_* に入っており、実績価格アンカーはそちらを見る。
        runSql(
          'INSERT INTO estimate_log (tenant_id, construction_id, work_type, ai_material_cost, ai_labor_cost, ai_total, ai_markup_rate, ai_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [tid, conId, data.title || 'OCR取込', materialTotal, laborCost, sellingPrice, markupRate, JSON.stringify(data), jstNow]
        );
      }
    } catch (e) { console.error('OCR estimate_log記録失敗:', e); }

    // OCRログに取り込み結果・コメント（紐づけメモ）を反映
    try {
      if (data._ocrLogId) {
        runSql(
          'UPDATE ocr_log SET imported = 1, construction_id = ?, comment = COALESCE(NULLIF(?, \'\'), comment) WHERE id = ? AND tenant_id = ?',
          [conId, data._comment || '', data._ocrLogId, tid]
        );
      }
    } catch (e) { console.error('ocr_log更新失敗:', e); }
  return {
    propertyId,
    constructionId: conId,
    invoiceId: invId,
    linked: !!linkConstructionId,
    materialTotal,
    laborCost,
    sellingPrice,
    markupRate,
    siteImages,
  };
}
