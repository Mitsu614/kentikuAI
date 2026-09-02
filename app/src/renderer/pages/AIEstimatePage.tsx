import React, { useState, useEffect, useRef } from 'react';
import { PageGuide } from '../components/PageGuide';
import { startBusy, updateBusy, endBusy, etaText } from '../components/BusyPop';
import CustomerSchedule from '../components/CustomerSchedule';

// 消費税率。AIが出す金額はすべて税抜（原価・粗利の計算がしやすいため）。表示のときだけ税込を併記する。
const TAX_RATE = 0.1;

// 待ち時間の初期目安（秒）。実測が2回貯まれば BusyPop がそのPCの実測値に自動で切り替える。
const ESTIMATE_SEC = 60;    // AI見積の作成
const AREA_SEC = 15;        // 写真からの面積読み取り
const IMAGE_SEC = 40;       // 完成イメージ生成
const AUTOCREATE_SEC = 12;  // 物件・施工・請求書の自動登録
const TAKEOFF_SEC = 45;     // 図面からの数量拾い出し（PDFはページ数ぶん重い）
const TRAINING_SEC = 150;   // 研修モード（実測: 内訳6行の屋根工事で約143秒。考えさせるぶん見積より長い）

// 待っている間に出す「いま何をしているか」の一言。固定POPと画面内カードで同じ文言を使う。
const analyzeStep = (sec: number) =>
  sec < 10 ? '画像を解析しています' :
  sec < 20 ? '建物の種類・規模を特定中' :
  sec < 32 ? '相場データベースと照合中' :
  sec < 44 ? '材料費・人件費を積算中' :
  sec < 56 ? '粗利率・追加提案を計算中' :
  'もう少しで完了します';

// 金額・人数などの数値入力欄。
// ・クリック（フォーカス）で中身を全選択 → そのまま打てば丸ごと置き換わる
// ・入力中は空欄にもできる（0 に強制で戻さない）。空欄は 0 として親へ渡す
// ・確定（blur）時に数値へ丸める
function NumInput({ value, onValue, style, min }: {
  value: number;
  onValue: (n: number) => void;
  style?: React.CSSProperties;
  min?: number;
}) {
  const [text, setText] = useState<string | null>(null);
  const display = text !== null ? text : String(Math.round(value || 0));
  return (
    <input
      type="number"
      min={min}
      value={display}
      onFocus={e => e.currentTarget.select()}
      onChange={e => {
        setText(e.target.value);
        onValue(e.target.value === '' ? 0 : Number(e.target.value) || 0);
      }}
      onBlur={() => setText(null)}
      style={style}
    />
  );
}

export default function AIEstimatePage({ onNavigateToConstruction }: { onNavigateToConstruction?: (id: number) => void }) {
  const [imageData, setImageData] = useState<string | null>(null);
  // 追加の写真（1枚目は imageData。面積推定・完成イメージ・サムネは従来どおり1枚目を使う）
  const [extraImages, setExtraImages] = useState<string[]>([]);
  const MAX_IMAGES = 6;
  const isPdfData = (x: any) => typeof x === 'string' && x.startsWith('data:application/pdf');

  // ── 業種の確認（初回のみ） ──
  // 業種で積算の中身が丸ごと変わる。設定しないまま使うと、内装屋さんに建物まるごとの
  // 金額が出るような事故になる。ライセンスには業種が乗らないので、送って入れてもらう運用だと
  // 誰も設定しないまま使い始めてしまう。そこで「最初の見積の前に1度だけ」必ず選んでもらう。
  const INDUSTRIES: { v: string; label: string; hint: string }[] = [
    { v: 'interior',   label: '内装仕上工事業', hint: 'クロス・床・軽天ボード・幅木。ゼネコンの下請け' },
    { v: 'general',    label: '総合建設業',     hint: '工務店・リフォーム。迷ったらこれ' },
    { v: 'building',   label: '建築一式工事業', hint: '新築・増改築を元請で。建物まるごとを科目別に積算' },
    { v: 'equipment',  label: '設備工事業',     hint: '水道・電気・空調。器具や数量ベース' },
    { v: 'painting',   label: '塗装工事業',     hint: '塗装面積・塗料グレード・足場' },
    { v: 'exterior',   label: '外構・エクステリア業', hint: '駐車場・フェンス・門扉・植栽' },
    { v: 'demolition', label: '解体工事業',     hint: '解体坪単価・産廃処理・重機回送' },
    { v: 'plant',      label: 'プラント設備工事業', hint: '配管・機器据付・計装。工場やプラント' },
    { v: 'lease',      label: '仮設工事リース業', hint: '足場・仮設のリース。日数×日額で積算' },
  ];
  const [askIndustry, setAskIndustry] = useState(false);
  const [industryChoice, setIndustryChoice] = useState('');
  const [industrySaving, setIndustrySaving] = useState(false);
  const pendingAnalyze = useRef<null | (() => void)>(null);

  // 業種が未確認なら true。確認済みなら false（一度選べば二度と聞かない）
  const needsIndustry = async () => {
    try {
      const c = await (window as any).api.loadConfig();
      return !c?.industryConfirmed;
    } catch (_) { return false; }   // 読めないときは邪魔しない
  };
  const saveIndustry = async () => {
    if (!industryChoice || industrySaving) return;
    setIndustrySaving(true);
    try {
      const c = await (window as any).api.loadConfig();
      await (window as any).api.saveConfig({ ...c, industryType: industryChoice, industryConfirmed: true });
      setAskIndustry(false);
      const go = pendingAnalyze.current; pendingAnalyze.current = null;
      if (go) go();
    } catch (e: any) {
      setError(e?.message || '業種の保存に失敗しました');
    } finally { setIndustrySaving(false); }
  };
  const [beforeImage, setBeforeImage] = useState<string | null>(null);
  const [afterImage, setAfterImage] = useState<string | null>(null);
  const [mode, setMode] = useState<'single' | 'beforeafter' | 'chat'>('single');
  const [dragTarget, setDragTarget] = useState<null | 'single' | 'before' | 'after'>(null);
  const [location, setLocation] = useState('');
  const [comment, setComment] = useState('');
  const [area, setArea] = useState(''); // 面積・数量の実測値（AIの推定より優先させる）
  // ── 図面からの数量拾い出し（Takeoff）──
  // PDF図面を読ませて「計算式つきの数量」を先に確定させる。見積はこの数量を確定値として使う。
  const [takeoffFiles, setTakeoffFiles] = useState<{ type: string; data: string; name: string }[]>([]);
  const [takeoff, setTakeoff] = useState<any>(null);
  const [takeoffLoading, setTakeoffLoading] = useState(false);
  const [takeoffTargets, setTakeoffTargets] = useState(''); // 拾ってほしい対象（任意）
  const [takeoffScale, setTakeoffScale] = useState('');     // 縮尺の指定（図面に表記が無い/違うとき）
  const [takeoffOpen, setTakeoffOpen] = useState(false);
  const [takeoffDragging, setTakeoffDragging] = useState(false);
  // ── 原価の修正（人件費など）──
  // AIが最初に出した見積を原本として持っておく。人が直しても、いつでもここへ戻せる。
  const [baseline, setBaseline] = useState<any>(null);
  const [costEdited, setCostEdited] = useState<any>(null);   // DBに保存済みの修正（過去ログを開いたとき用）
  const [savingCost, setSavingCost] = useState(false);

  // ⚡スピード優先 — お客様向けの工事時間説明と松竹梅プランを省いて、生成する文章量を減らす。
  // 金額・内訳・人工の精度には触らない（削るのは提案の付録だけ）。
  const [fastMode, setFastMode] = useState(false);
  const [roofType, setRoofType] = useState(''); // 屋根種別（お客様確認）→ 展開係数をAIに強制する
  const [structure, setStructure] = useState(''); // 建物構造（木造/鉄骨/RC/SRC）。未選択ならAIが推察する
  const [buildingAge, setBuildingAge] = useState(''); // 築年数（年）。改修・解体時のコストに反映させる
  // 現場条件 — 足場・搬入・アクセス・居ながら施工。写真では分からないが金額を直撃する。未選択ならAIが写真から推察。
  const [siteAccess, setSiteAccess] = useState(''); // 前面道路・重機搬入
  const [siteAdjacency, setSiteAdjacency] = useState(''); // 隣地との距離・足場の組みやすさ
  const [siteOccupied, setSiteOccupied] = useState(''); // 居ながら施工か空き家か
  const [siteStories, setSiteStories] = useState(''); // 階数・高さ（足場㎡・危険手当）
  const [desiredDeadline, setDesiredDeadline] = useState(''); // 希望納期/工期。推定工期より短ければAIが短縮提案・相談する
  // お客様(施主)の情報 — 提案(recommendations)のパーソナライズにのみ使う。金額には影響させない。
  const [clientName, setClientName] = useState('');
  const [clientJob, setClientJob] = useState('');
  const [clientHobby, setClientHobby] = useState('');
  const [clientAge, setClientAge] = useState('');
  const [clientPriorities, setClientPriorities] = useState<string[]>([]);
  const [profileLoaded, setProfileLoaded] = useState(''); // 直近に自動読込した顧客名（UI表示用）

  // 顧客名を確定したら、保存済みの職業・趣味を自動で読み込む
  const loadCustomerProfile = async () => {
    const nm = clientName.trim();
    if (!nm) return;
    try {
      const p = await (window as any).api.findCustomerByName(nm);
      if (p && (p.job || p.hobby)) {
        if (p.job) setClientJob(p.job);
        if (p.hobby) setClientHobby(p.hobby);
        setProfileLoaded(nm);
      }
    } catch (_) {}
  };
  const [reArea, setReArea] = useState(''); // 結果画面での「AIが前提にした面積」修正→再計算用
  const [analyzing, setAnalyzing] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<any>(null);
  const elapsedRef = useRef(0);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [autoCreated, setAutoCreated] = useState<any>(null);
  const [creating, setCreating] = useState(false);
  const [applyingFix, setApplyingFix] = useState(false);
  // 研修モード（THINKING）— 次世代への技術継承。見積を教材に「なぜこの材料が何個要るのか」を解説する
  const [training, setTraining] = useState<any>(null);
  // どの見積に対する解説かを覚えておく（再解析したら自動で消える＝古い解説が残らない）
  const [trainingSrc, setTrainingSrc] = useState<any>(null);
  const [trainingLoading, setTrainingLoading] = useState(false);
  const [trainingLevel, setTrainingLevel] = useState('新人');
  const [trainingErr, setTrainingErr] = useState('');
  // 解説を出してよいのは「いま画面に出ている見積に対して作った解説」だけ。
  // 再解析したら参照が変わるので自動で引っ込む（古い現場の解説が残ると事故になる）。
  const trainingShown = !!training && trainingSrc === result;
  const [estimateLog, setEstimateLog] = useState<any[]>([]);
  const [selectedLog, setSelectedLog] = useState<number | null>(null);
  const [logPO, setLogPO] = useState<any>(null);
  const [poLoading, setPOLoading] = useState(false);
  const [logInvoice, setLogInvoice] = useState<any>(null);
  const [invoiceLoading, setInvoiceLoading] = useState(false);
  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  // チャットは固定POPを出すと会話のたびに邪魔になるので、吹き出しの中に経過秒だけ出す
  const [chatElapsed, setChatElapsed] = useState(0);
  const [chatEstimate, setChatEstimate] = useState<any>(null);
  const [chatSessionId, setChatSessionId] = useState<number | null>(null);
  const [chatSessions, setChatSessions] = useState<any[]>([]);
  // 「後からの相談」= 既存見積についてのチャットのとき、元見積ログ/施工に紐づける（別ログを chat_followup として残す）
  const [chatSourceLogId, setChatSourceLogId] = useState<number | null>(null);
  const [chatConstructionId, setChatConstructionId] = useState<number | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const trainingRef = useRef<HTMLDivElement>(null);

  // DB からログ読み込み
  useEffect(() => {
    (window as any).api.getEstimateLog?.().then((logs: any[]) => {
      if (logs && logs.length > 0) {
        setEstimateLog(logs.map((l: any) => {
          let parsed = null;
          try { parsed = JSON.parse(l.ai_json); } catch (_) {}
          return {
            id: l.id,
            time: l.created_at?.split(' ')[1]?.substring(0, 5) || '',
            date: l.created_at?.split(' ')[0] || '',
            workType: l.work_type || '不明',
            // 金額を直して保存してあれば、その金額を出す（ai_total はAIの原案として残す）
            total: (Number(l.edited_total) || Number(l.ai_total) || 0),
            aiTotal: Number(l.ai_total) || 0,
            edited: !!l.edited_at,
            result: parsed,
            image: l.generated_image || null,
            uploadedImage: l.uploaded_image || null,
            constructionId: l.construction_id || null,
            source: l.source || 'photo',
            sourceLogId: l.source_log_id || null,
          };
        }));
      }
    }).catch(() => {});
    // チャットセッション一覧を読み込み
    (window as any).api.listChatSessions?.().then((sessions: any[]) => {
      if (sessions) setChatSessions(sessions);
    }).catch(() => {});
  }, []);

  // チャットメッセージが更新されたら自動保存（ユーザー送信時 or AI応答時）
  useEffect(() => {
    if (chatMessages.length <= 1) return; // 初期メッセージのみはスキップ
    const hasUserMsg = chatMessages.some((m: any) => m.role === 'user');
    if (!hasUserMsg) return; // ユーザーが何も打っていない場合はスキップ
    const timer = setTimeout(async () => {
      try {
        const title = chatMessages.find((m: any) => m.role === 'user')?.content?.substring(0, 30) || 'チャット相談';
        const id = await (window as any).api.saveChatSession({
          id: chatSessionId || undefined,
          title,
          messages: chatMessages,
          constructionId: autoCreated?.constructionId || undefined,
          estimateLogId: selectedLog || undefined,
        });
        if (!chatSessionId) setChatSessionId(id);
        const sessions = await (window as any).api.listChatSessions();
        if (sessions) setChatSessions(sessions);
      } catch (_) {}
    }, 3000);
    return () => clearTimeout(timer);
  }, [chatMessages]);

  // Electron既定ではウィンドウにファイルをドロップすると開こうとして画面が壊れる。
  // ドロップゾーン外に落とした場合の事故を防ぐため、既定動作を無効化する。
  useEffect(() => {
    const prevent = (e: DragEvent) => { e.preventDefault(); };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  const selectImage = async () => {
    // PDF（ゼネコンから来る図面はたいていPDF）も選べるようにする。
    // selectPdf は PDF・JPG・PNG のどれでも data URL で返す。
    const picked = await (window as any).api.selectPdf();
    const img = Array.isArray(picked) && picked[0] ? picked[0].data : null;
    if (img) {
      setImageData(img);
      setExtraImages([]);   // 現場を変えたときに前の追加写真が残らないようにする
      setResult(null);
      setGeneratedImage(null);
      setError('');
      setAutoCreated(null);
    }
  };

  // 写真を追加する（外壁4面・屋根・室内など、1枚に収まらない現場向け）
  const addExtraImage = async () => {
    if (!imageData) { await selectImage(); return; }
    if (1 + extraImages.length >= MAX_IMAGES) { setError(`写真は${MAX_IMAGES}枚までです`); return; }
    const picked = await (window as any).api.selectPdf();
    const img = Array.isArray(picked) && picked[0] ? picked[0].data : null;
    if (img) { setExtraImages(list => [...list, img]); setResult(null); setError(''); setAutoCreated(null); }
  };
  const removeExtraImage = (i: number) => {
    setExtraImages(list => list.filter((_, idx) => idx !== i));
    setResult(null); setAutoCreated(null);
  };

  const selectBeforeImage = async () => {
    const img = await window.api.selectImage();
    if (img) { setBeforeImage(img); setResult(null); setError(''); setAutoCreated(null); }
  };

  const selectAfterImage = async () => {
    const img = await window.api.selectImage();
    if (img) { setAfterImage(img); setResult(null); setError(''); setAutoCreated(null); }
  };

  // ── ドラッグ&ドロップで画像を取り込む ──
  const readFileAsDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
    reader.readAsDataURL(file);
  });

  const applyDroppedImage = (dataUrl: string, target: 'single' | 'before' | 'after') => {
    if (target === 'single') { setImageData(dataUrl); setGeneratedImage(null); }
    else if (target === 'before') setBeforeImage(dataUrl);
    else setAfterImage(dataUrl);
    setResult(null);
    setError('');
    setAutoCreated(null);
  };

  const handleDrop = async (e: React.DragEvent, target: 'single' | 'before' | 'after') => {
    e.preventDefault();
    setDragTarget(null);
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/') && file.type !== 'application/pdf') { setError('画像（JPG/PNG等）またはPDFをドロップしてください'); return; }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      applyDroppedImage(dataUrl, target);
    } catch (err: any) {
      setError(err?.message || '画像の読み込みに失敗しました');
    }
  };

  // ドロップゾーンに付与する共通プロップ（onDragOver/Leave/Drop）
  const dropZoneProps = (target: 'single' | 'before' | 'after') => ({
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); if (dragTarget !== target) setDragTarget(target); },
    onDragLeave: (e: React.DragEvent) => { e.preventDefault(); setDragTarget(t => (t === target ? null : t)); },
    onDrop: (e: React.DragEvent) => handleDrop(e, target),
  });

  // 図面から数量を拾ってあれば、写真もコメントも無しで見積を出せる（拾い出しが入力そのもの）
  const hasTakeoff = !!takeoff && (takeoff.items || []).length > 0;
  // 見積結果に紐づいた拾い出し（過去ログを開いたときは result 側に入っている）を name で引ける形にする
  const takeoffSource = (result && result.takeoff) || takeoff;
  const takeoffByName: Record<string, any> = {};
  ((takeoffSource && takeoffSource.items) || []).forEach((it: any) => {
    if (it && it.name) takeoffByName[String(it.name).trim()] = it;
  });
  // 費用内訳のどの行で「拾い出し根拠」を開いているか
  const [openBasis, setOpenBasis] = useState<number | null>(null);

  // ── 原価（材料費・人件費・経費）を直したら、掛率を保ったまま売価を引き直す ──
  // 「人件費を5万上げたのに請求金額が1円も変わらない」を起こさないため。
  // 掛率はAIの原案（baseline）の 売価÷原価合計 を使う＝粗利率が維持される。
  const baseMarkup = (() => {
    const src = baseline || result;
    if (!src) return 0;
    const cost = (Number(src.estimatedMaterialCost) || 0) + (Number(src.estimatedLaborCost) || 0) + (Number(src.estimatedExpenseCost) || 0);
    const total = Number(src.estimatedTotal) || 0;
    return cost > 0 && total > 0 ? total / cost : 0;
  })();

  const editCost = (field: 'estimatedMaterialCost' | 'estimatedLaborCost' | 'estimatedExpenseCost', n: number) => {
    if (!result) return;
    const next: any = { ...result, [field]: n };
    const cost = (Number(next.estimatedMaterialCost) || 0) + (Number(next.estimatedLaborCost) || 0) + (Number(next.estimatedExpenseCost) || 0);
    if (baseMarkup > 0 && cost > 0) next.estimatedTotal = Math.round(cost * baseMarkup);
    setResult(next);
  };

  // 見積ログ一覧を取り直す。金額を直したあと、一覧の金額をその場で追従させるために使う。
  const refreshEstimateLog = async () => {
    try {
      const logs = await (window as any).api.getEstimateLog();
      if (!logs) return;
      setEstimateLog(logs.map((l: any) => {
        let parsed = null;
        try { parsed = JSON.parse(l.ai_json); } catch (_) {}
        return {
          id: l.id,
          time: l.created_at?.split(' ')[1]?.substring(0, 5) || '',
          date: l.created_at?.split(' ')[0] || '',
          workType: l.work_type || '不明',
          total: (Number(l.edited_total) || Number(l.ai_total) || 0),
          aiTotal: Number(l.ai_total) || 0,
          edited: !!l.edited_at,
          result: parsed,
          image: l.generated_image || null,
          uploadedImage: l.uploaded_image || null,
          constructionId: l.construction_id || null,
          source: l.source || 'photo',
          sourceLogId: l.source_log_id || null,
        };
      }));
    } catch (_) {}
  };

  // 修正を上書き保存する。明細・売価・請求書金額まで一括で合わせ、AIの学習にも渡す。
  const saveCostEdit = async () => {
    if (!autoCreated?.constructionId || !result) return;
    setSavingCost(true);
    try {
      const res = await (window as any).api.saveCostEdit({
        constructionId: autoCreated.constructionId,
        materialCost: Number(result.estimatedMaterialCost) || 0,
        laborCost: Number(result.estimatedLaborCost) || 0,
        expenseCost: Number(result.estimatedExpenseCost) || 0,
        total: Number(result.estimatedTotal) || 0,
      });
      // 請求書カードを最新の金額で描き直す
      try {
        const inv = await (window as any).api.getInvoiceByConstruction(autoCreated.constructionId);
        setLogInvoice(inv);
      } catch (_) {}
      setCostEdited({
        edited_at: new Date().toLocaleString('ja-JP'),
        edited_labor_cost: Number(result.estimatedLaborCost) || 0,
        edited_total: Number(result.estimatedTotal) || 0,
      });
      await refreshEstimateLog();   // 見積ログ一覧の金額もその場で追従させる
      const tax = Math.round((res?.amount || 0) * (1 + (res?.taxRate || 0.1)));
      alert(`上書き保存しました。

請求金額: ¥${Math.round(res?.amount || 0).toLocaleString()}（税込 ¥${tax.toLocaleString()}）

人件費の修正はAIの学習にも反映されます。
「元に戻す」でいつでもAIの原案へ戻せます。`);
    } catch (e: any) {
      alert('保存に失敗しました: ' + String(e?.message || e).replace(/^ERROR: /, '').replace(/^Error: /, ''));
    } finally {
      setSavingCost(false);
    }
  };

  // AIが最初に出した金額へ戻す。ai_json は書き換えていないので、明細・請求書ごと復元できる。
  const revertCostEdit = async () => {
    if (!autoCreated?.constructionId) return;
    if (!confirm('AIが最初に出した金額に戻します。\n入力した修正（人件費・原価・売価）と、請求書の金額も元に戻ります。\n\nよろしいですか？')) return;
    setSavingCost(true);
    try {
      const res = await (window as any).api.revertCostEdit({ constructionId: autoCreated.constructionId });
      if (res?.original) {
        setResult({ ...res.original });
        setBaseline(JSON.parse(JSON.stringify(res.original)));
      } else if (baseline) {
        setResult(JSON.parse(JSON.stringify(baseline)));
      }
      setCostEdited(null);
      try {
        const inv = await (window as any).api.getInvoiceByConstruction(autoCreated.constructionId);
        setLogInvoice(inv);
      } catch (_) {}
      await refreshEstimateLog();
      alert(`AIの原案に戻しました。

請求金額: ¥${Math.round(res?.amount || 0).toLocaleString()}`);
    } catch (e: any) {
      alert('元に戻せませんでした: ' + String(e?.message || e).replace(/^ERROR: /, '').replace(/^Error: /, ''));
    } finally {
      setSavingCost(false);
    }
  };

  // 費用内訳の1行を直す。数量・単価・金額のどれを触っても、残りが矛盾しないよう引き直す。
  // ── 備考（単価の内訳）を、金額を直したあとの数字に追従させる ──
  // 備考には「コンクリート 4,500円/㎡…」と要素ごとの単価が並ぶ。金額だけ直すと
  // 内訳の合計と単価が合わなくなり、お客様に出したときに足し算が合わない書類になる。
  // 要素の単価は根拠のある実額なので勝手に按分せず、差額を「調整」として明示する。
  const restampNote = (note: string, opts: {
    oldCost: number; newCost: number; oldUnitPrice: number; newUnitPrice: number; unit: string;
  }): string => {
    const base = String(note || '');
    // 前回付けた注記は毎回消してから付け直す（編集のたびに積み上がらないように）
    const cleaned = base.split('\n').filter(l => !l.startsWith('※金額を修正')).join('\n').replace(/\n+$/, '');
    if (!(opts.newCost > 0) || Math.abs(opts.newCost - opts.oldCost) < 1) return cleaned;
    const yen = (v: number) => Math.round(v).toLocaleString();
    const u = opts.unit || '';
    // 備考に並んでいる要素単価（"4,500円/㎡" 等）を拾って合計する。合計が取れたら差額を調整として出す。
    const parts = cleaned.match(/([\d,]+)\s*円\s*\/\s*[^\s／/、（(]+/g) || [];
    let partSum = 0;
    for (const m of parts) {
      const v = Number(String(m).replace(/[^\d]/g, ''));
      if (v > 0) partSum += v;
    }
    let line = `※金額を修正: ${yen(opts.oldCost)}円 → ${yen(opts.newCost)}円`;
    if (opts.newUnitPrice > 0 && opts.oldUnitPrice > 0 && opts.oldUnitPrice !== opts.newUnitPrice) {
      line += `（単価 ${yen(opts.oldUnitPrice)} → ${yen(opts.newUnitPrice)}円/${u || '単位'}）`;
    }
    // partSum は「原価の要素単価の合計」。新しい単価が売価側なら比較しても意味が無いので、
    // 差が単価の5割以内に収まっているときだけ調整行として出す（誤検出を避ける）。
    if (partSum > 0 && opts.newUnitPrice > 0) {
      const diff = opts.newUnitPrice - partSum;
      if (Math.abs(diff) >= 1 && Math.abs(diff) <= partSum * 0.5) {
        const qty = opts.newCost / opts.newUnitPrice;
        line += `\n　内訳合計 ${yen(partSum)}円/${u || '単位'} との差 ${diff < 0 ? '▲' : '+'}${yen(Math.abs(diff))}円/${u || '単位'}`
          + `（${diff < 0 ? '値引き' : '追加'}調整 ${diff < 0 ? '▲' : '+'}${yen(Math.abs(diff) * qty)}円）。上の内訳は修正前の単価です`;
      }
    }
    return cleaned + (cleaned ? '\n' : '') + line;
  };

  const updateBreakdownRow = (i: number, field: 'quantity' | 'unitPrice' | 'cost', n: number) => {
    if (!result || !Array.isArray(result.breakdown)) return;
    const next = [...result.breakdown];
    const row = { ...next[i] };
    const qty = Number(row.quantity) || 0;
    const up = Number(row.unitPrice) || 0;
    if (field === 'quantity') {
      row.quantity = n;
      if (up > 0) row.cost = Math.round(n * up);
      else if (n > 0) row.unitPrice = Math.round((Number(row.cost) || 0) / n);
    } else if (field === 'unitPrice') {
      row.unitPrice = n;
      row.cost = Math.round((qty > 0 ? qty : 1) * n);
      if (!(qty > 0)) row.quantity = 1;
    } else {
      row.cost = n;
      if (qty > 0) row.unitPrice = Math.round(n / qty);
      else { row.quantity = 1; row.unitPrice = n; }
    }
    // 原価(costBase)は掛率を保ったまま追従させる。粗利が勝手に消えないようにする。
    const oldCost = Number(next[i].cost) || 0;
    const oldBase = Number(next[i].costBase) || 0;
    if (oldCost > 0 && oldBase > 0) row.costBase = Math.round(oldBase * ((Number(row.cost) || 0) / oldCost));
    // 備考の内訳と食い違ったままにしない（足し算の合わない見積書を出さないため）
    row.note = restampNote(row.note, {
      oldCost: Number(next[i].cost) || 0,
      newCost: Number(row.cost) || 0,
      oldUnitPrice: Number(next[i].unitPrice) || (Number(next[i].quantity) > 0 ? Math.round((Number(next[i].cost) || 0) / Number(next[i].quantity)) : 0),
      newUnitPrice: Number(row.unitPrice) || 0,
      unit: row.unit || next[i].unit || '',
    });
    next[i] = row;
    const sum = next.reduce((acc: number, r: any) => acc + (Number(r.cost) || 0), 0);
    setResult({ ...result, breakdown: next, estimatedTotal: sum });
  };

  const canAnalyze = mode === 'single'
    ? (!!imageData || comment.trim().length > 0 || hasTakeoff)
    : (!!beforeImage && !!afterImage) || comment.trim().length > 0;

  // 見積前の面積確認。面積を間違えたまま本見積を回すと「再計算」でクレジットを二重に使うため、
  // 実測値が未入力かつ写真がある場合だけ、先にAIの推定面積を提示して直してもらう。
  const [areaCheck, setAreaCheck] = useState<{
    assumedArea: string; basis: string; confidence: string;
    scaleRef?: string; roofAreaM2?: number; developFactor?: number; quantityM2?: number;
    coversWholeRoof?: boolean; missingPart?: string; needsDimension?: string;
    isEstimate?: boolean; rangeMinM2?: number; rangeMaxM2?: number;
    widthM?: number; lengthM?: number; slopeFactor?: number;
    rawM2?: number; calibration?: number; calibrationSamples?: number;
    target?: string; targetLabel?: string; unvalidated?: boolean;
    mode?: string; modeSource?: string; modeWarning?: string;
    readValues?: string[]; rangeBasis?: string;
  } | null>(null);
  // 読み取りモード。auto=AIに判定させる / drawing=図面として記載値を読む / photo=写真として概算
  const [readMode, setReadMode] = useState<'auto' | 'drawing' | 'photo'>('auto');
  // 住所から航空写真を引く経路。写真の目測よりスケールが確定するぶん確か
  const [siteAddress, setSiteAddress] = useState('');
  const [aerial, setAerial] = useState<any>(null);
  const [aerialLoading, setAerialLoading] = useState(false);
  // 測った範囲の四角。単位は画像のピクセル。
  // AIの読み取りを初期値にして、あとは人が動かす・大きさを変える。
  // 縮尺が確定しているので、人が合わせた四角の面積はそのまま実測に近い。
  // （AIに任せると同じ場所でも1.48倍ぶれる。人が輪郭を合わせるほうが確か）
  // 中心・幅・高さ・角度で持つ。左上基準だと、回転させたとき「反対側の角を固定して伸ばす」
  // 計算ができない（角の位置が回転に依存するため）。中心基準なら素直に書ける。
  const [aerialRect, setAerialRect] = useState<{ cx: number; cy: number; w: number; h: number; rot: number } | null>(null);
  const aerialDrag = useRef<any>(null);
  // 写真の表示位置（CSS px）。広めに読み込んだ画像の、どこを見せているか。
  // ★離すたびに取り直すとカクつくので、読み込んだ範囲の中は通信なしで滑らかに動かす。
  //   端に寄ったときだけ読み直す。
  const [aerialOff, setAerialOff] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  // 表示倍率（画像1px を画面何pxで見せるか）。2.42 で「窓いっぱい＝約124m四方」になる。
  // 倍率を変えるだけなら通信は要らないので、寄る・引くは何度やっても無料。
  const [aerialZoom, setAerialZoom] = useState(2.42);
  const [aerialGrabbing, setAerialGrabbing] = useState(false);
  const aerialPanRef = useRef<any>(null);
  const aerialViewRef = useRef<HTMLDivElement | null>(null);
  const AERIAL_VIEW = 620;   // 見せる窓の大きさ（CSS px）

  // 画像が窓より大きいときは端が窓から離れないよう留め、小さいときは真ん中に置く
  const clampOff = (o: { x: number; y: number }, world: number) => {
    if (world <= AERIAL_VIEW) { const c = (AERIAL_VIEW - world) / 2; return { x: c, y: c }; }
    const lo = AERIAL_VIEW - world;
    return { x: Math.max(lo, Math.min(0, o.x)), y: Math.max(lo, Math.min(0, o.y)) };
  };
  // いま窓の中心に来ている画像座標
  const aerialCenterPx = () => ({
    x: (AERIAL_VIEW / 2 - aerialOff.x) / aerialZoom,
    y: (AERIAL_VIEW / 2 - aerialOff.y) / aerialZoom,
  });
  // 倍率を変える。窓の中心（または指した点）がずれないように表示位置も直す
  const zoomAerialTo = (z: number, atX?: number, atY?: number) => {
    if (!aerial) return;
    const nz = Math.max(0.5, Math.min(6, z));
    const ax = atX ?? AERIAL_VIEW / 2, ay = atY ?? AERIAL_VIEW / 2;
    const ix = (ax - aerialOff.x) / aerialZoom, iy = (ay - aerialOff.y) / aerialZoom;
    setAerialZoom(nz);
    setAerialOff(clampOff({ x: ax - ix * nz, y: ay - iy * nz }, aerial.sizePx * nz));
  };

  // ── 航空写真測定は プロプラン以上の機能 ──
  // 本体（main.ts の AERIAL_PLANS）でも止めているので、ここは案内のための表示だけ。
  // 隠してしまうと「そんな機能があると知らないまま」になり売れないので、
  // 鍵付きで見せて、何ができる機能なのかを書く。
  const [myPlan, setMyPlan] = useState<string>('');
  const aerialAllowed = !myPlan || ['pro', 'enterprise', 'demo'].includes(myPlan);
  useEffect(() => {
    (window as any).api.getPlan()
      .then((p: any) => setMyPlan(p?.plan || ''))
      .catch(() => { /* 取れなくても見積は止めない。取れないうちは出しておく */ });
  }, []);

  // 写真を取り直したら、その中心を窓の真ん中に置き直す
  useEffect(() => {
    if (!aerial?.sizePx) return;
    const world = aerial.sizePx * aerialZoom;
    setAerialOff(clampOff({ x: (AERIAL_VIEW - world) / 2, y: (AERIAL_VIEW - world) / 2 }, world));
  }, [aerial]);

  // ホイールで寄る・引く。ブラウザ既定の拡大とぶつからないよう passive:false で自前で受ける
  useEffect(() => {
    const el = aerialViewRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAerialTo(aerialZoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [aerial, aerialZoom, aerialOff]);
  const [checkingArea, setCheckingArea] = useState(false);
  const [confirmArea, setConfirmArea] = useState('');
  const [learned, setLearned] = useState<{ calibration: number; samples: number } | null>(null);

  // 実測に直して見積もる。直した値はそのテナントの較正係数の学習に回す。
  const proceedWithArea = async () => {
    const m2 = Number(confirmArea);
    if (!(m2 > 0) || !areaCheck) return;
    const predicted = Number(areaCheck.quantityM2) || 0;
    // 触っていない（＝AIの値をそのまま承認）ときは学習しない。承認は「合っている」証拠として弱い
    const edited = predicted > 0 && Math.abs(m2 - predicted) / predicted > 0.02;
    if (edited && areaCheck.rawM2) {
      try {
        const r = await (window as any).api.recordAreaCorrection({
          rawM2: areaCheck.rawM2, predictedM2: predicted, correctedM2: m2,
          isEstimate: !!areaCheck.isEstimate,
          widthM: areaCheck.widthM, lengthM: areaCheck.lengthM,
          slopeFactor: areaCheck.slopeFactor, developFactor: areaCheck.developFactor,
          scaleRef: areaCheck.scaleRef, confidence: areaCheck.confidence, comment,
          target: areaCheck.target,
        });
        if (r?.recorded && r.usable) setLearned({ calibration: r.calibration, samples: r.samples });
      } catch (_) { /* 学習に失敗しても見積は止めない */ }
    }
    analyze(`${areaCheck.targetLabel || '屋根'} ${m2}㎡`);
  };

  // 管理者限定: 見積が参照する実績・業種プロンプトを他テナントのものに切り替える（検証用）。
  // 非管理者では isAdmin=false が返り、セレクタ自体が描画されない。
  const [estTenants, setEstTenants] = useState<{ id: number; name: string; industryType: string; isolated: boolean }[]>([]);
  const [estTenantId, setEstTenantId] = useState<number | ''>('');
  useEffect(() => {
    (async () => {
      try {
        const res = await (window as any).api.listEstimateTenants();
        if (res?.isAdmin) {
          setEstTenants(res.tenants || []);
          setEstTenantId(res.current || '');
        }
      } catch (_) { /* 旧ビルドでは未実装 */ }
    })();
  }, []);
  const changeEstTenant = async (v: string) => {
    const id = v ? Number(v) : null;
    const res = await (window as any).api.setEstimateTenant(id);
    if (res?.success) setEstTenantId(id || '');
    else setError(res?.error || 'テナントを切り替えられませんでした');
  };

  // ── 研修モード（THINKING）— 次世代への技術継承 ──
  // 見積に残るのは金額だけ。「なぜその材料が・何個・何のために要り、どう使うのか」は
  // ベテランの頭の中にしか無いので、この現場の見積をそのまま教材にして若手向けの文章にする。
  const makeTraining = async () => {
    if (!result || trainingLoading) return;
    setTrainingLoading(true);
    setTrainingErr('');
    startBusy({
      key: 'training',
      title: '研修モードで解説を作っています',
      etaSec: TRAINING_SEC,
      sub: trainingLevel + '向けに、材料の使い道と数量の根拠をまとめています',
      note: '1〜3分かかります。見積の数量をそのまま教材にします（数字は作り直しません）',
    });
    try {
      const g = await (window as any).api.trainingGuide({ result, comment, location, level: trainingLevel });
      setTraining(g);
      setTrainingSrc(result);
      endBusy();
      setTimeout(() => trainingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    } catch (e: any) {
      endBusy({ ok: false });
      setTrainingErr(String(e?.message || e).replace(/^Error invoking remote method '[^']+': /, '').replace(/^Error: /, '').replace(/^ERROR: /, ''));
    } finally {
      setTrainingLoading(false);
    }
  };

  // 画面の解説を、社内チャット・メールにそのまま貼れるテキストにする
  const trainingToText = (g: any) => {
    if (!g) return '';
    const L: string[] = [];
    L.push('【' + (g.title || '研修資料') + '】');
    if (g.workType) L.push('工事: ' + g.workType + (g.level ? '　対象: ' + g.level : ''));
    if (g.overview) L.push('\n' + g.overview);
    if ((g.flow || []).length > 0) {
      L.push('\n■ 工事の流れ');
      (g.flow || []).forEach((f: any) => {
        L.push('・' + (f.step || '') + ' … ' + (f.what || ''));
        if (f.why) L.push('　なぜこの順番: ' + f.why);
        if (f.watch) L.push('　見ておく所: ' + f.watch);
      });
    }
    L.push('\n■ 材料 — なぜ要るのか・何個要るのか・どう使うのか');
    (g.materials || []).forEach((m: any, i: number) => {
      L.push('\n' + (i + 1) + '. ' + (m.name || '') + '　【数量】' + (m.quantity || ''));
      if (m.role) L.push('　何に使う: ' + m.role);
      if (m.why) L.push('　なぜ必要: ' + m.why);
      if (m.howMany) L.push('　なぜこの数量: ' + m.howMany);
      if (m.howToUse) L.push('　どう使う:\n' + String(m.howToUse).split('\n').map((x: string) => '　　' + x).join('\n'));
      if (m.tools) L.push('　使う道具: ' + m.tools);
      if (m.mistakes) L.push('　よくある失敗: ' + m.mistakes);
      if (m.seniorTip) L.push('　先輩のコツ: ' + m.seniorTip);
    });
    if ((g.labor || []).length > 0) {
      L.push('\n■ 職人 — 誰が何をして、なぜその人数・日数か');
      (g.labor || []).forEach((l: any) => {
        L.push('・' + (l.trade || '') + '（' + (l.manDays || '') + '）: ' + (l.whatTheyDo || ''));
        if (l.whyThisManDays) L.push('　人工の根拠: ' + l.whyThisManDays);
      });
    }
    if ((g.safety || []).length > 0) {
      L.push('\n■ 安全');
      (g.safety || []).forEach((x: any) => L.push('・' + x));
    }
    if (g.costEducation) L.push('\n■ 原価の感覚\n' + g.costEducation);
    if ((g.quiz || []).length > 0) {
      L.push('\n■ 確認問題');
      (g.quiz || []).forEach((q: any, i: number) => { L.push('Q' + (i + 1) + '. ' + (q.q || '')); L.push('A. ' + (q.a || '')); });
    }
    if (g.closing) L.push('\n' + g.closing);
    return L.join('\n');
  };

  const startEstimate = async () => {
    if (!canAnalyze) return;
    const mainImage = mode === 'beforeafter' ? (afterImage || beforeImage) : imageData;
    // 実測値を入れてあるなら聞く必要はない。写真が無ければ読み取れない。
    if (area.trim() || !mainImage) { analyze(); return; }
    setCheckingArea(true);
    setError('');
    setLearned(null);
    startBusy({ key: 'area-check', title: '写真から面積を読み取っています', etaSec: AREA_SEC, sub: '読み取った面積は次の画面で修正できます' });
    try {
      const res = await (window as any).api.estimateArea({ imageBase64: mainImage, comment, mode: readMode });
      setAreaCheck(res);
      setConfirmArea(res?.quantityM2 ? String(Math.round(res.quantityM2)) : '');
      endBusy();
    } catch (e: any) {
      // 事前確認に失敗しても見積自体は止めない（上限到達・読み取り失敗など）
      endBusy({ ok: false });
      console.warn('面積の事前確認をスキップ:', e?.message || e);
      analyze();
    } finally {
      setCheckingArea(false);
    }
  };

  // 住所から航空写真を引いて面積を出す。
  // 写真の目測はスケールの推定で外れる（実測33回で平均誤差46%・同じ写真で3.7倍違う答え）。
  // 地理院タイルは縮尺が確定しているので、その工程がまるごと消える。
  // ① 写真を出すだけ。AIを呼ばないので費用はかからない。
  //    住所は号まで入れても街区の代表点が返ることが多く、建物の上に落ちない
  //    （実測: 都島本通五丁目８番１８号 の解決点は道路上だった）。
  //    だから建物の特定は住所に任せず、利用者に選んでもらう。
  const runAerial = async () => {
    const addr = siteAddress.trim();
    if (!addr) { setError('住所を入力してください'); return; }
    setAerialLoading(true);
    setError('');
    startBusy({ key: 'aerial', title: '航空写真を取得しています', etaSec: 8, sub: '住所を検索し、真上からの写真を取得中' });
    try {
      const res = await (window as any).api.areaFromAddress({ address: addr, comment, fetchOnly: true });
      endBusy();
      setAerial(res);
    } catch (e: any) {
      endBusy({ ok: false });
      setError((e?.message || '航空写真の取得に失敗しました').replace(/^Error: /, '').replace(/^ERROR: /, ''));
    } finally {
      setAerialLoading(false);
    }
  };

  // 写す範囲を切り替えて取り直す。AIは呼ばないので費用はかからない。
  // 目的の建物が枠の外にいると選びようがないので、広げられるようにしておく。
  const refetchAerial = async (grid: number) => {
    const addr = siteAddress.trim();
    if (!addr || aerialLoading) return;
    setAerialLoading(true);
    setError('');
    try {
      const res = await (window as any).api.areaFromAddress({ address: addr, comment, fetchOnly: true, grid });
      setAerial(res);
    } catch (e: any) {
      setError((e?.message || '航空写真の取得に失敗しました').replace(/^Error: /, '').replace(/^ERROR: /, ''));
    } finally {
      setAerialLoading(false);
    }
  };

  // 写真を掴んで動かす（地図と同じ操作）。
  //
  // ★ドラッグ中も、離したあとも、読み込み済みの範囲の中なら通信しない。
  //   以前は離すたびに写真を取り直していたので、そのつど読み込みが入って
  //   カクッと飛んでいた。いまは広めに読んだ画像の中を滑らかに動かすだけ。
  //   端まで来てさらに引っぱったときだけ、その先を継ぎ足しに行く。
  const startAerialPan = (ev: React.MouseEvent) => {
    if (!aerial || aerialLoading) return;
    ev.preventDefault();
    const world = aerial.sizePx * aerialZoom;
    // ★移動量も現在位置も ref に持つこと。
    //   mousedown の時点で作った関数は、その後の setState を見られない（古い値のまま）。
    //   state だけに入れると、離したときの処理が常に初期値を読んでしまう。
    aerialPanRef.current = {
      startX: ev.clientX, startY: ev.clientY, ox: aerialOff.x, oy: aerialOff.y,
      moved: 0, over: 0, world,
    };
    setAerialGrabbing(true);

    const onMove = (e: MouseEvent) => {
      const p = aerialPanRef.current;
      if (!p) return;
      const dx = e.clientX - p.startX, dy = e.clientY - p.startY;
      p.moved = Math.hypot(dx, dy);
      const want = { x: p.ox + dx, y: p.oy + dy };
      const c = clampOff(want, p.world);
      // 端で止まったあと、どれだけ余計に引っぱったか。継ぎ足すかの判断に使う
      p.over = Math.hypot(want.x - c.x, want.y - c.y);
      setAerialOff(c);
    };
    const onUp = async () => {
      const p = aerialPanRef.current;
      aerialPanRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setAerialGrabbing(false);
      // 端まで来て、さらに強く引っぱったときだけ その先を読みに行く。
      // 少し当たった程度で取り直すと、意図せず読み込みが走ってうるさい。
      if (!p || p.over < 70) return;
      const c = aerialCenterPx();
      setAerialLoading(true);
      try {
        const res = await (window as any).api.areaFromAddress({
          address: siteAddress.trim(), comment, fetchOnly: true, grid: aerial.grid,
          viewLat: aerial.viewLat, viewLon: aerial.viewLon, panTo: { x: c.x, y: c.y },
        });
        setAerial(res);
        setAerialRect(null);
      } catch (e: any) {
        setError((e?.message || '航空写真の取得に失敗しました').replace(/^ERROR: /, ''));
      } finally {
        setAerialLoading(false);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // 四角を動かす・大きさを変える。which='move' か 'nw'|'ne'|'sw'|'se'
  const startAerialDrag = (ev: React.MouseEvent, which: string) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!aerialRect || !aerial) return;
    const box = (ev.currentTarget as HTMLElement).closest('[data-aerial-box]') as HTMLElement;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const scale = aerial.sizePx / rect.width;   // 表示px → 画像px
    // 回転は「写真の左上からの絶対位置」で角度を出すので、枠の位置も控えておく
    aerialDrag.current = {
      which, startX: ev.clientX, startY: ev.clientY, base: { ...aerialRect }, scale,
      boxLeft: rect.left, boxTop: rect.top,
    };

    const onMove = (e: MouseEvent) => {
      const d = aerialDrag.current;
      if (!d) return;
      const dx = (e.clientX - d.startX) * d.scale;
      const dy = (e.clientY - d.startY) * d.scale;
      const b = d.base;
      const rad = (b.rot || 0) * Math.PI / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      let r = { ...b };

      if (d.which === 'move') {
        r.cx = b.cx + dx; r.cy = b.cy + dy;

      } else if (d.which === 'rot') {
        // 中心から見たマウスの向きが、そのまま角度になる。
        // 90度ずらすのは、つまみを上（-y方向）に置いているため。
        const mx = (e.clientX - d.boxLeft) * d.scale;
        const my = (e.clientY - d.boxTop) * d.scale;
        let deg = Math.atan2(my - b.cy, mx - b.cx) * 180 / Math.PI + 90;
        // Shiftを押している間は15度刻み。建物は直角が多いので合わせやすくなる
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        r.rot = deg;

      } else {
        // 角をつまんで伸縮。回転していても「反対側の角」は動かさない。
        // 画面のドラッグ量を四角のローカル座標へ回して考える。
        const lx = dx * cos + dy * sin;
        const ly = -dx * sin + dy * cos;
        const left = d.which.includes('w'), top = d.which.includes('n');
        let w = left ? b.w - lx : b.w + lx;
        let h = top ? b.h - ly : b.h + ly;
        w = Math.max(6, w); h = Math.max(6, h);
        // 固定したい角（つまんだ角の反対）をローカルで求め、そこが動かないよう中心を出し直す
        const sx = left ? 1 : -1, sy = top ? 1 : -1;      // 反対側の角の向き
        const fixLocalOld = { x: sx * b.w / 2, y: sy * b.h / 2 };
        const fixWorld = {
          x: b.cx + fixLocalOld.x * cos - fixLocalOld.y * sin,
          y: b.cy + fixLocalOld.x * sin + fixLocalOld.y * cos,
        };
        const fixLocalNew = { x: sx * w / 2, y: sy * h / 2 };
        r.w = w; r.h = h;
        r.cx = fixWorld.x - (fixLocalNew.x * cos - fixLocalNew.y * sin);
        r.cy = fixWorld.y - (fixLocalNew.x * sin + fixLocalNew.y * cos);
      }
      // 中心が画像の外へ出ないようにする（回転すると角ははみ出しうるが、それは許容）
      r.cx = Math.max(0, Math.min(r.cx, aerial.sizePx));
      r.cy = Math.max(0, Math.min(r.cy, aerial.sizePx));
      setAerialRect(r);
    };
    const onUp = () => {
      aerialDrag.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // 四角から面積を出す。縮尺は確定しているので掛けるだけ。
  //
  // 航空写真で読めるのは**水平投影面積**。そこから施工数量までは2段ある。
  //   水平投影 × 勾配補正 = 屋根面積（傾いているぶん）
  //   屋根面積 × 展開係数 = 施工数量（折板の山谷に沿って張るぶん）
  // 遮熱シートやカバー工法は材料が山谷に沿うので、展開係数を掛けないと
  // 折板88mmで4割、150mmなら7割足りない見積になる。
  const aerialRectArea = () => {
    if (!aerialRect || !aerial?.mPerPx) return null;
    const wM = aerialRect.w * aerial.mPerPx;
    const hM = aerialRect.h * aerial.mPerPx;
    const plan = wM * hM;
    const slope = Number(aerial.slopeFactor) > 0 ? Number(aerial.slopeFactor) : 1;
    const roof = plan * slope;
    // 画面で選んだ屋根種別が最優先。選んでいなければ航空写真からの判定を候補として使う
    const picked = roofType ? Number(roofType.split('|')[1]) || 1 : 0;
    const suggest = aerial.developSuggest?.factor || 0;
    const dev = picked || suggest || 1;
    return {
      wM, hM, plan, slope, roof, dev,
      area: roof * dev,
      devFrom: picked ? 'user' : suggest ? 'ai' : 'none',
    };
  };

  // ② ダブルクリックした場所へ移る。
  //    ★AIは呼ばない。無料・即時・回数無制限。
  //    どのみち四角は人が合わせるし、AIの読みは同じ場所でも1.48倍ぶれる。
  //    毎回AIを呼ぶと1日30回の上限をすぐ使い切ってしまう。
  const recenterAerialAt = async (ev: React.MouseEvent<HTMLImageElement>) => {
    if (!aerial || aerialLoading) return;
    const img = ev.currentTarget;
    const rect = img.getBoundingClientRect();
    const scale = (aerial.sizePx || 256) / rect.width;
    const x = Math.round((ev.clientX - rect.left) * scale);
    const y = Math.round((ev.clientY - rect.top) * scale);
    // いまの四角の大きさと角度を覚えておく。
    // 同じ区画の建物は向きも揃っていることが多いので、角度も引き継ぐと合わせ直しが減る
    const keep = aerialRect ? { w: aerialRect.w, h: aerialRect.h } : null;
    const keepRot = aerialRect?.rot ?? 0;
    setAerialLoading(true);
    setError('');
    try {
      const res = await (window as any).api.areaFromAddress({
        address: siteAddress.trim(), comment, fetchOnly: true,
        grid: 1,   // 測るときは寄る
        viewLat: aerial.viewLat, viewLon: aerial.viewLon, panTo: { x, y },
      });
      setAerial({ ...res, slopeFactor: aerial.slopeFactor || 1 });
      const size = res.sizePx || 256;
      const w = keep ? keep.w : Math.min(size * 0.35, 12 / (res.mPerPx || 0.5));
      const h = keep ? keep.h : w;
      setAerialRect({ cx: size / 2, cy: size / 2, w, h, rot: keepRot });
    } catch (e: any) {
      setError((e?.message || '航空写真の取得に失敗しました').replace(/^ERROR: /, ''));
    } finally {
      setAerialLoading(false);
    }
  };

  // 参考にAIへ測らせる（任意）。1日の上限を使うので、押したときだけ
  const measureAerialAt = async () => {
    if (!aerial || aerialLoading) return;
    // いま画面の中心にある建物を測らせる
    const x = Math.round((aerial.sizePx || 256) / 2);
    const y = x;
    setAerialLoading(true);
    setError('');
    startBusy({ key: 'aerial-measure', title: '指定された建物を測っています', etaSec: AREA_SEC, sub: '確定した縮尺で輪郭を換算中' });
    try {
      // ★いま見ている写真の中心を必ず渡す。
      //   渡さないと住所の位置を基準に換算され、寄ったあとのクリックが
      //   まったく別の場所を指す（何度押しても同じ建物が選ばれ続けた）。
      const res = await (window as any).api.areaFromAddress({
        address: siteAddress.trim(), comment, target: { x, y },
        grid: aerial.grid, viewLat: aerial.viewLat, viewLon: aerial.viewLon,
      });
      endBusy();
      // ★クリック座標をそのまま持ち越さないこと。
      //   測るときは「その建物を中心に据えて撮り直す」ので、返ってくる写真は別物
      //   （768px の広い写真 → 256px の寄った写真）。元の座標で印を描くと位置が合わない。
      //   測った位置は res.targetPx（＝撮り直した写真の中心）を使う。
      setAerial(res);
      // AIの読み取りを四角の初期値にする。あとは人が合わせる
      if (res?.widthM > 0 && res?.mPerPx > 0) {
        const w = res.widthM / res.mPerPx, h = res.lengthM / res.mPerPx;
        setAerialRect({ cx: res.targetPx.x, cy: res.targetPx.y, w, h, rot: aerialRect?.rot ?? 0 });
      } else {
        setAerialRect(null);
      }
      if (res?.quantityM2 > 0) setConfirmArea(String(Math.round(res.quantityM2)));
    } catch (e: any) {
      endBusy({ ok: false });
      setError((e?.message || '測定に失敗しました').replace(/^Error: /, '').replace(/^ERROR: /, ''));
    } finally {
      setAerialLoading(false);
    }
  };

  // ── 図面ファイルの追加（PDF・画像）。PDFはClaudeにそのまま渡すのでラスタ化しない ──
  const addTakeoffFile = async () => {
    try {
      const picked = await (window as any).api.selectPdf();
      if (!picked || picked.length === 0) return;
      const add = picked.map((f: any) => ({
        type: f.type || (String(f.data).startsWith('data:application/pdf') ? 'pdf' : 'image'),
        data: f.data,
        name: `図面${takeoffFiles.length + 1}`,
      }));
      setTakeoffFiles(prev => [...prev, ...add].slice(0, 6));
      setTakeoff(null);
    } catch (e: any) { setError(e?.message || '図面を開けませんでした'); }
  };

  const dropTakeoffFiles = async (e: React.DragEvent) => {
    e.preventDefault();
    setTakeoffDragging(false);
    const files = Array.from(e.dataTransfer?.files || []);
    const ok = files.filter(f => f.type === 'application/pdf' || f.type.startsWith('image/'));
    if (ok.length === 0) { setError('PDFまたは画像（図面・材料一覧表）をドロップしてください'); return; }
    try {
      const read = await Promise.all(ok.map(async f => ({
        type: f.type === 'application/pdf' ? 'pdf' : 'image',
        data: await readFileAsDataUrl(f),
        name: f.name,
      })));
      setTakeoffFiles(prev => [...prev, ...read].slice(0, 6));
      setTakeoff(null);
    } catch (err: any) { setError(err?.message || '図面の読み込みに失敗しました'); }
  };

  // 拾い出し実行。金額は出さない工程なので、失敗しても見積本体には影響させない。
  const runTakeoff = async () => {
    if (takeoffFiles.length === 0) return;
    setTakeoffLoading(true);
    setError('');
    startBusy({ key: 'takeoff', title: '図面から数量を拾っています', etaSec: TAKEOFF_SEC, sub: '寸法・縮尺を読み取り中', note: '図面の枚数が多いほど時間がかかります' });
    try {
      const res = await (window as any).api.takeoffDrawing({
        files: takeoffFiles.map(f => ({ type: f.type, data: f.data, name: f.name })),
        comment,
        scaleHint: takeoffScale,
        targets: takeoffTargets,
      });
      endBusy();
      setTakeoff(res);
      setTakeoffOpen(true);
      // 拾えた主要数量を「実測値」欄にも反映しておく（見積プロンプトの二重の保険）
      const sum = (res?.summary || []).map((x: any) => `${x.label} ${x.value}`).join(' / ');
      if (sum && !area.trim()) setArea(sum);
    } catch (e: any) {
      endBusy({ ok: false });
      setError((e?.message || '拾い出しに失敗しました').replace(/^Error: /, '').replace(/^ERROR: /, ''));
    } finally {
      setTakeoffLoading(false);
    }
  };

  // 拾い出し1行の数量を人が直す。直した値がそのまま見積の確定数量になる。
  const editTakeoffQty = (i: number, n: number) => {
    if (!takeoff) return;
    const items = [...(takeoff.items || [])];
    const loss = Number(items[i]?.lossRate) || 0;
    items[i] = {
      ...items[i],
      quantity: n,
      quantityWithLoss: Math.round(n * (1 + loss) * 100) / 100,
      confidence: '高',            // 人が確定させた数量は最上位の確度として扱う
      assumption: items[i]?.assumption,
      formula: `${items[i]?.formula || ''}${items[i]?.formula ? ' → ' : ''}手入力 ${n}${items[i]?.unit || ''}`,
    };
    setTakeoff({ ...takeoff, items });
  };

  const removeTakeoffItem = (i: number) => {
    if (!takeoff) return;
    setTakeoff({ ...takeoff, items: (takeoff.items || []).filter((_: any, j: number) => j !== i) });
  };

  // opts.forceFresh: 同じ入力でも前回の見積を再利用せず、AIで作り直す（ストックを消費する）
  const analyze = async (areaOverride?: string, opts?: { forceFresh?: boolean }) => {
    // 業種が未確認なら、先に選んでもらう（選んだらそのまま見積に進む）
    if (!opts?.forceFresh && await needsIndustry()) {
      const cfg = await (window as any).api.loadConfig().catch(() => ({}));
      setIndustryChoice(cfg?.industryType || '');
      pendingAnalyze.current = () => analyze(areaOverride, opts);
      setAskIndustry(true);
      return;
    }
    if (!canAnalyze) return;
    setAreaCheck(null);
    // 結果画面から「この面積で再計算」した場合は上書き値を使い、入力欄にも反映
    const areaVal = areaOverride !== undefined ? areaOverride : area;
    if (areaOverride !== undefined) setArea(areaOverride);
    setAnalyzing(true);
    setError('');
    setResult(null);
    setAutoCreated(null);
    setElapsed(0);
    elapsedRef.current = 0;
    if (timerRef.current) clearInterval(timerRef.current);
    // 実進捗（AIが実際に書いている内容）が届いたら、秒数から推測する固定メッセージはやめる。
    let liveStage = '';
    const unsubscribeProgress = (window as any).api.onAiProgress
      ? (window as any).api.onAiProgress((p: { stage: string }) => {
          if (!p?.stage) return;
          liveStage = p.stage;
          updateBusy({ sub: liveStage });
        })
      : null;
    timerRef.current = setInterval(() => {
      elapsedRef.current += 1;
      setElapsed(elapsedRef.current);
      if (!liveStage) updateBusy({ sub: analyzeStep(elapsedRef.current) });
    }, 1000);
    // 画面をスクロールしても残り時間が見えるように、固定POPでも出す
    startBusy({ key: 'ai-estimate', title: 'AIが見積もりを作成しています', sub: analyzeStep(0), etaSec: ESTIMATE_SEC, note: '完了までこの画面を開いたままにしてください' });
    setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    try {
      const clientAttrs = (clientJob || clientHobby || clientAge || clientPriorities.length > 0)
        ? { job: clientJob, hobby: clientHobby, age: clientAge, priorities: clientPriorities }
        : null;
      // 職業・趣味を入れてあれば顧客DBに登録（顧客名がキー。次回同じ名前で自動読込される）
      if (clientName.trim() && (clientJob.trim() || clientHobby.trim())) {
        try { await (window as any).api.upsertCustomerProfile({ name: clientName.trim(), job: clientJob, hobby: clientHobby }); } catch (_) {}
      }
      // 屋根種別（お客様確認）→ 展開係数をAIに強制するための構造化データ
      const roof = roofType ? { label: roofType.split('|')[0], developFactor: Number(roofType.split('|')[1]) || 0 } : null;
      // 現場条件（足場・搬入・アクセス・居ながら）→ 一つでも入っていれば構造化して渡す。未入力はAIが写真から推察。
      const site = { access: siteAccess, adjacency: siteAdjacency, occupied: siteOccupied, stories: siteStories };
      // 図面拾い出しがあれば確定数量として渡す（AIの目測推定より優先される）
      const takeoffPayload = takeoff && (takeoff.items || []).length > 0 ? takeoff : null;
      const payload = mode === 'beforeafter'
        ? { imageBase64: null, beforeImage, afterImage, comment, location, area: areaVal, clientAttrs, roofType: roof, structure, buildingAge, siteConditions: site, desiredDeadline, takeoff: takeoffPayload, fastMode }
        : { imageBase64: imageData || null, images: imageData ? [imageData, ...extraImages] : [], comment, location, area: areaVal, clientAttrs, roofType: roof, structure, buildingAge, siteConditions: site, desiredDeadline, takeoff: takeoffPayload, fastMode };
      if (opts?.forceFresh) (payload as any).forceFresh = true;
      const res = await (window as any).api.analyzeImage(payload);
      endBusy();
      setResult(res);
      setBaseline(JSON.parse(JSON.stringify(res)));  // AIの原案を原本として保持（元に戻す用）
      setCostEdited(null);
      setReArea(res?.assumedArea || ''); // 「AIが前提にした面積」を修正欄の初期値に
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);

      // 確認後、物件・施工・請求書・発注書を自動作成
      // confirm はJSを止めるので、待ち時間POPが「完了」に切り替わって描画されるのを1フレーム待つ
      await new Promise(r => setTimeout(r, 60));
      if (confirm('見積もり結果から物件・施工・請求書・発注書（下書き）を自動作成しますか？')) {
        setCreating(true);
        startBusy({ key: 'auto-create', title: '物件・施工・請求書を登録しています', etaSec: AUTOCREATE_SEC, note: '登録が終わるまでこの画面を開いたままにしてください' });
        try {
          const mainImage = mode === 'beforeafter' ? (afterImage || beforeImage) : imageData;
          const created = await (window as any).api.autoCreateFromEstimate({ result: res, imageBase64: mainImage, comment, location, area: areaVal });
          setAutoCreated(created);
          if (created.sellingPrice) {
            res.estimatedTotal = created.sellingPrice;
            setResult({ ...res });
          }
          // 発注書も自動作成
          if (created.constructionId) {
            try {
              await (window as any).api.createPOFromConstruction(created.constructionId);
            } catch (_) {}
          }
          endBusy();
        } catch (e: any) {
          endBusy({ ok: false });
          console.error('auto create error:', e);
        }
        setCreating(false);

        // 金額修正の確認 → あれば編集ガイドへスクロール
        const wantEdit = confirm('登録完了しました。金額に修正はありますか？\n\n「OK」→ 修正画面へ\n「キャンセル」→ そのまま確定');
        if (wantEdit) {
          setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth' }), 200);
        }
      }
      // ログに追加（DBから再読込）
      try {
        const logs = await (window as any).api.getEstimateLog();
        if (logs && logs.length > 0) {
          setEstimateLog(logs.map((l: any) => {
            let parsed = null;
            try { parsed = JSON.parse(l.ai_json); } catch (_) {}
            return { id: l.id, time: l.created_at?.split(' ')[1]?.substring(0, 5) || '', date: l.created_at?.split(' ')[0] || '', workType: l.work_type || '不明', total: (Number(l.edited_total) || Number(l.ai_total) || 0), aiTotal: Number(l.ai_total) || 0, edited: !!l.edited_at, result: parsed, image: l.generated_image || null, uploadedImage: l.uploaded_image || null, constructionId: l.construction_id || null, source: l.source || 'photo', sourceLogId: l.source_log_id || null };
          }));
          // 最新のログをselectedに
          setSelectedLog(logs[0].id);
        }
      } catch (_) {}
    } catch (e: any) {
      endBusy({ ok: false });
      setError(e.message || 'AI解析に失敗しました');
    }
    if (unsubscribeProgress) unsubscribeProgress();
    clearInterval(timerRef.current);
    setAnalyzing(false);
  };

  useEffect(() => {
    if (!chatLoading) { setChatElapsed(0); return; }
    const t0 = Date.now();
    const id = setInterval(() => setChatElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [chatLoading]);

  const [genElapsed, setGenElapsed] = useState(0);
  const genTimerRef = useRef<any>(null);
  const genElapsedRef = useRef(0);

  // 最新値をrefで保持（クロージャ問題回避）
  const autoCreatedRef = useRef(autoCreated);
  autoCreatedRef.current = autoCreated;
  const selectedLogRef = useRef(selectedLog);
  selectedLogRef.current = selectedLog;
  const estimateLogRef = useRef(estimateLog);
  estimateLogRef.current = estimateLog;

  const generateImage = async () => {
    if (!result?.imagePrompt) return;
    setGenerating(true);
    setError('');
    setGenElapsed(0);
    genElapsedRef.current = 0;
    genTimerRef.current = setInterval(() => { genElapsedRef.current++; setGenElapsed(genElapsedRef.current); }, 1000);
    startBusy({ key: 'image-gen', title: '完成イメージを生成しています', etaSec: IMAGE_SEC, sub: '見積もりの内容から仕上がりを描いています' });
    try {
      // 元画像がある場合は編集モード（95%維持）、ない場合は生成モード
      const sourceImg = mode === 'beforeafter' ? (afterImage || beforeImage) : imageData;
      const ac = autoCreatedRef.current;
      const sl = selectedLogRef.current;
      const el = estimateLogRef.current;
      const saveTargetLogId = ac?.estimateLogId || sl || (el.length > 0 ? el[0].id : undefined);
      const saveTargetConstructionId = ac?.constructionId || undefined;
      const url = await (window as any).api.generateImage(
        sourceImg
          ? { prompt: result.imagePrompt, sourceImage: sourceImg, targetLogId: saveTargetLogId, targetConstructionId: saveTargetConstructionId }
          : { prompt: result.imagePrompt, targetLogId: saveTargetLogId, targetConstructionId: saveTargetConstructionId }
      );
      endBusy();
      setGeneratedImage(url);
      // 施工写真として自動保存 + estimate_logにも保存
      if (url) {
        try {
          const ac = autoCreatedRef.current;
          const sl = selectedLogRef.current;
          const el = estimateLogRef.current;
          if (ac?.constructionId) {
            await (window as any).api.addConstructionPhoto({
              constructionId: ac.constructionId,
              photoData: url,
              label: 'after',
              notes: 'AI完成予想画像（自動保存）',
            });
          }
          const targetLogId = ac?.estimateLogId || sl || (el.length > 0 ? el[0].id : undefined);
          await (window as any).api.saveEstimateImage({
            logId: targetLogId,
            constructionId: ac?.constructionId,
            imageData: url,
          });
        } catch (e) { console.error('[saveEstimateImage] ERROR:', e); }
        // ログ再読込
        try {
          const logs = await (window as any).api.getEstimateLog();
          if (logs) {
            setEstimateLog(logs.map((l: any) => {
              let parsed = null;
              try { parsed = JSON.parse(l.ai_json); } catch (_) {}
              return { id: l.id, time: l.created_at?.split(' ')[1]?.substring(0, 5) || '', date: l.created_at?.split(' ')[0] || '', workType: l.work_type || '不明', total: (Number(l.edited_total) || Number(l.ai_total) || 0), aiTotal: Number(l.ai_total) || 0, edited: !!l.edited_at, result: parsed, image: l.generated_image || null, uploadedImage: l.uploaded_image || null, constructionId: l.construction_id || null, source: l.source || 'photo', sourceLogId: l.source_log_id || null };
            }));
          }
        } catch (_) {}
      }
    } catch (e: any) {
      endBusy({ ok: false });
      setError(e.message || '画像生成に失敗しました');
    }
    clearInterval(genTimerRef.current);
    setGenerating(false);
  };

  const fmt = (n: number) => '¥' + Math.round(n).toLocaleString();
  const confidenceColor: any = { '高': '#27ae60', '中': '#f39c12', '低': '#e74c3c' };

  const loadFromLog = async (logItem: any) => {
    const r = logItem.result ? { ...logItem.result } : null;
    // ai_json は「AIが最初に出した原案」。書き換えていないので、これが元に戻す先になる。
    setBaseline(logItem.result ? JSON.parse(JSON.stringify(logItem.result)) : null);
    setCostEdited(null);
    // ログの金額（実際の売価）で上書き
    if (r && logItem.total) r.estimatedTotal = logItem.total;
    setResult(r);
    setReArea(r?.assumedArea || '');
    setGeneratedImage(logItem.image || null);
    if (logItem.uploadedImage) setImageData(logItem.uploadedImage);
    setSelectedLog(logItem.id);
    setLogPO(null);
    setLogInvoice(null);
    // constructionIdがあれば金額編集・保存できるようにする
    if (logItem.constructionId) {
      setAutoCreated({ constructionId: logItem.constructionId, propertyId: null });
    } else {
      setAutoCreated(null);
    }
    setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    // 関連する発注書・請求書を取得
    if (logItem.constructionId) {
      setPOLoading(true);
      setInvoiceLoading(true);
      try {
        const [po, inv] = await Promise.all([
          (window as any).api.getPOByConstruction(logItem.constructionId),
          (window as any).api.getInvoiceByConstruction(logItem.constructionId),
        ]);
        setLogPO(po);
        setLogInvoice(inv);
        // ★画面の売上金額は「いま実際に請求している金額」に合わせる。
        //   ai_total（AIが最初に出した額）を出したままだと、明細・請求書とズレたまま
        //   「上書き保存」を押した瞬間に明細がその額へ引き直され、金額が勝手に下がる事故になる。
        //   AIの原案は baseline に残してあるので「元に戻す」は従来どおり効く。
        const liveAmount = Number(inv?.invoice?.amount) || 0;
        if (liveAmount > 0) {
          setResult((prev: any) => (prev ? { ...prev, estimatedTotal: liveAmount } : prev));
        }
        // 保存済みの原価修正があれば、その値で画面を出す（AIの原案ではなく「いまの見積」を見せる）
        try {
          const edit = await (window as any).api.getCostEdit(logItem.constructionId);
          if (edit) {
            setCostEdited(edit);
            setResult((prev: any) => prev ? {
              ...prev,
              estimatedMaterialCost: Number(edit.edited_material_cost) || prev.estimatedMaterialCost,
              estimatedLaborCost: Number(edit.edited_labor_cost) || prev.estimatedLaborCost,
              estimatedExpenseCost: Number(edit.edited_expense_cost) || prev.estimatedExpenseCost,
              estimatedTotal: Number(edit.edited_total) || prev.estimatedTotal,
            } : prev);
          }
        } catch (_) {}
      } catch (_) {}
      setPOLoading(false);
      setInvoiceLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: 16 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>AI 見積もり</h1>
        <PageGuide pageKey="ai-estimate" steps={[
          { icon: '📸', title: 'STEP 1：現場写真をアップロード', desc: '施工前の写真や図面を選択してください。テキストだけでの見積もりも可能です。', sub: 'ビフォーアフターモードで2枚の写真から見積もることもできます' },
          { icon: '🤖', title: 'STEP 2：AIが自動で見積作成', desc: 'AIが写真を解析し、材料・数量・単価・人件費を自動算出します。', sub: '過去の実績データを学習し、精度が向上していきます' },
          { icon: '📋', title: 'STEP 3：施工案件として登録', desc: '見積結果をワンクリックで施工案件に登録。請求書や発注書も自動生成できます。' },
          { icon: '🎓', title: 'STEP 4：研修モードで若手に残す', desc: '見積結果の下の「研修モード」で、なぜその材料が何個要るのか・どう使うのかを解説にできます。', sub: 'PDFにして新人に配れます（AIストック1／数量は見積の値をそのまま使います）' },
        ]} />
      </div>

      {/* モード切替 */}
      <div className="card" style={{ padding: '12px 20px' }}>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          <button
            className={`btn ${mode === 'single' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setMode('single')}
            style={{ padding: '8px 20px', fontSize: 13 }}
          >
            📷 写真・図面で見積
          </button>
          <button
            className={`btn ${mode === 'beforeafter' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setMode('beforeafter')}
            style={{ padding: '8px 20px', fontSize: 13 }}
          >
            🔄 ビフォーアフターで見積
          </button>
          <button
            className={`btn ${mode === 'chat' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => { setMode('chat'); if (chatMessages.length === 0) setChatMessages([{ role: 'assistant', content: 'こんにちは！建築見積のAIアシスタントです。\n\nどんな工事の見積もりをしたいですか？\n例：「キッチンリフォーム」「外壁塗装」「3階建てマンションの足場」\n\n写真があれば添付もできます。' }]); setTimeout(() => chatInputRef.current?.focus(), 100); }}
            style={{ padding: '8px 20px', fontSize: 13 }}
          >
            💬 チャットで見積
          </button>
        </div>
      </div>

      {/* チャットモード */}
      {mode === 'chat' && (
        <div className="card" style={{ marginTop: 12, display: 'flex', flexDirection: 'column', height: 'calc(100vh - 200px)', minHeight: 400, background: '#e8ecf1', padding: 0, overflow: 'hidden', position: 'relative' }}>
          {/* チャットセッション履歴バー */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', background: '#fff', borderBottom: '1px solid #e2e8f0', overflowX: 'auto', flexShrink: 0 }}>
            <button onClick={() => { setChatMessages([{ role: 'assistant', content: 'こんにちは！建築見積のAIアシスタントです。\n\nどんな工事の見積もりをしたいですか？' }]); setChatSessionId(null); setChatEstimate(null); setChatSourceLogId(null); setChatConstructionId(null); }} style={{ padding: '4px 10px', fontSize: 11, background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: 600 }}>+ 新規</button>
            {chatSessions.slice(0, 8).map((s: any) => (
              <button key={s.id} onClick={async () => {
                const session = await (window as any).api.getChatSession(s.id);
                if (session) {
                  setChatMessages(session.messages || []);
                  setChatSessionId(s.id);
                  setChatEstimate(null);
                  setChatConstructionId(session.construction_id || null);
                  setChatSourceLogId(session.estimate_log_id || null);
                  if (session.construction_id) setAutoCreated({ constructionId: session.construction_id, propertyId: null });
                }
              }} style={{
                padding: '4px 10px', fontSize: 11, border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer',
                background: chatSessionId === s.id ? '#dbeafe' : '#f8fafc', whiteSpace: 'nowrap', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis',
                fontWeight: chatSessionId === s.id ? 600 : 400, color: '#475569',
              }}>
                {s.construction_title ? '🔗' : ''}{s.title || 'チャット'}
              </button>
            ))}
          </div>
          {/* チャット履歴 */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {chatMessages.map((msg, i) => (
              <div key={i} style={{
                alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '75%',
                display: 'flex',
                flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
                alignItems: 'flex-end',
                gap: 8,
              }}>
                {msg.role !== 'user' && (
                  <div style={{
                    width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                    background: 'linear-gradient(135deg, #3a7bd5, #27ae60)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#fff', fontSize: 16, fontWeight: 'bold',
                  }}>AI</div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start', gap: 2 }}>
                  <div style={{
                    padding: '12px 16px',
                    borderRadius: msg.role === 'user' ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
                    background: msg.role === 'user' ? 'linear-gradient(135deg, #3a7bd5, #2a6bc5)' : '#fff',
                    color: msg.role === 'user' ? '#fff' : '#333',
                    fontSize: 15,
                    lineHeight: 1.7,
                    whiteSpace: 'pre-wrap',
                    boxShadow: msg.role === 'user' ? '0 2px 8px rgba(58,123,213,0.3)' : '0 1px 4px rgba(0,0,0,0.1)',
                    border: msg.role === 'user' ? 'none' : '1px solid #e8e8e8',
                  }}>
                    {msg.image && <img src={msg.image} style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 10, marginBottom: 8, display: 'block' }} alt="" />}
                    {msg.content}
                  </div>
                  <span style={{ fontSize: 11, color: '#aaa', padding: '0 4px' }}>
                    {new Date().getHours()}:{String(new Date().getMinutes()).padStart(2, '0')}
                  </span>
                </div>
              </div>
            ))}
            {chatLoading && (
              <div style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                  background: 'linear-gradient(135deg, #3a7bd5, #27ae60)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#fff', fontSize: 16, fontWeight: 'bold',
                }}>AI</div>
                <div style={{
                  padding: '14px 20px', borderRadius: '18px 18px 18px 4px',
                  background: '#fff', border: '1px solid #e8e8e8',
                  boxShadow: '0 1px 4px rgba(0,0,0,0.1)',
                  fontSize: 15, color: '#888',
                  display: 'flex', gap: 6, alignItems: 'center',
                }}>
                  <span style={{ animation: 'pulse 1.4s infinite', width: 8, height: 8, borderRadius: '50%', background: '#aaa', display: 'inline-block' }} />
                  <span style={{ animation: 'pulse 1.4s infinite 0.2s', width: 8, height: 8, borderRadius: '50%', background: '#aaa', display: 'inline-block' }} />
                  <span style={{ animation: 'pulse 1.4s infinite 0.4s', width: 8, height: 8, borderRadius: '50%', background: '#aaa', display: 'inline-block' }} />
                  <span style={{ fontSize: 12, color: '#aaa', marginLeft: 4 }}>
                    {chatElapsed >= 25 ? `もう少しかかります… ${chatElapsed}秒` : `ふつう10〜30秒で返信します（${chatElapsed}秒）`}
                  </span>
                </div>
              </div>
            )}
            {chatEstimate && (
              <div style={{ alignSelf: 'flex-start', maxWidth: '90%', padding: '12px 16px', borderRadius: 12, background: '#f0fff4', border: '2px solid #27ae60', fontSize: 13 }}>
                <div style={{ fontWeight: 'bold', color: '#27ae60', marginBottom: 6 }}>見積結果</div>
                <div style={{ fontSize: 11, marginBottom: 4 }}>工事種別: {chatEstimate.workType}</div>
                <div style={{ fontSize: 20, fontWeight: 'bold', color: '#27ae60', margin: '6px 0' }}>¥{Math.round(chatEstimate.estimatedTotal || 0).toLocaleString()}</div>
                {chatEstimate.breakdown && chatEstimate.breakdown.map((b: any, j: number) => (
                  <div key={j} style={{ fontSize: 11, display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #e0e0e0', padding: '2px 0' }}>
                    <span>{b.item}</span>
                    <span style={{ fontWeight: 'bold' }}>¥{Math.round(b.cost || 0).toLocaleString()}</span>
                  </div>
                ))}
                <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
                  <button className="btn btn-primary btn-sm" onClick={() => {
                    setResult(chatEstimate);
                    setMode('single');
                    setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
                  }} style={{ fontSize: 11 }}>見積詳細を見る</button>
                  <button className="btn btn-sm" style={{ fontSize: 11, background: '#27ae60', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 12px', cursor: 'pointer' }} onClick={async () => {
                    if (confirm('この見積から物件・施工・請求書・発注書を自動作成しますか？')) {
                      try {
                        const chatImage = [...chatMessages].reverse().find(m => m.image)?.image || null;
                        const created = await (window as any).api.autoCreateFromEstimate({ result: chatEstimate, imageBase64: chatImage });
                        setAutoCreated(created);
                        setResult(chatEstimate);
                        setMode('single');
                        const wantEdit = confirm('登録完了しました。金額に修正はありますか？\n\n「OK」→ 修正画面へ\n「キャンセル」→ そのまま確定');
                        if (wantEdit) {
                          setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth' }), 200);
                        }
                      } catch (e: any) { alert('エラー: ' + e.message); }
                    }
                  }}>一括登録</button>
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
          {/* 入力エリア */}
          <div style={{ borderTop: '2px solid #f0f0f0', padding: '12px 16px', display: 'flex', gap: 10, alignItems: 'flex-end', background: '#fafafa', flexShrink: 0, position: 'relative', zIndex: 10 }}>
            <button onClick={async () => {
              const img = await window.api.selectImage();
              if (img) {
                setChatMessages(prev => [...prev, { role: 'user', content: '写真を添付しました', image: img }]);
                setChatLoading(true);
                setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
                try {
                  const res = await (window as any).api.aiChat({ messages: [...chatMessages, { role: 'user', content: 'この写真を見て見積もりしてください', image: img }], constructionId: chatConstructionId || undefined, sourceLogId: chatSourceLogId || undefined });
                  setChatMessages(prev => [...prev, { role: 'assistant', content: res.text }]);
                  if (res.estimate) setChatEstimate(res.estimate);
                } catch (e: any) { setChatMessages(prev => [...prev, { role: 'assistant', content: 'エラー: ' + e.message }]); }
                setChatLoading(false);
                setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
              }
            }} style={{ fontSize: 20, padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', borderRadius: '50%', transition: 'background 0.2s' }}>📷</button>
            <textarea
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={async e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (!chatInput.trim() || chatLoading) return;
                  const userMsg = chatInput.trim();
                  setChatInput('');
                  setChatMessages(prev => [...prev, { role: 'user', content: userMsg }]);
                  setChatLoading(true);
                  setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
                  try {
                    const allMsgs = [...chatMessages, { role: 'user', content: userMsg }].filter(m => m.role !== 'system');
                    const res = await (window as any).api.aiChat({ messages: allMsgs, constructionId: chatConstructionId || undefined, sourceLogId: chatSourceLogId || undefined });
                    setChatMessages(prev => [...prev, { role: 'assistant', content: res.text }]);
                    if (res.estimate) setChatEstimate(res.estimate);
                  } catch (e: any) { setChatMessages(prev => [...prev, { role: 'assistant', content: 'エラー: ' + e.message }]); }
                  setChatLoading(false);
                  setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
                }
              }}
              ref={chatInputRef}
              placeholder="工事の内容を入力... (Enter で送信、Shift+Enter で改行)"
              style={{ flex: 1, minHeight: 48, maxHeight: 120, padding: '12px 16px', border: '2px solid #e2e8f0', borderRadius: 24, fontSize: 16, resize: 'none', fontFamily: 'inherit', lineHeight: 1.5, outline: 'none', transition: 'border-color 0.2s', color: '#1e293b', background: '#fff', WebkitUserSelect: 'text', userSelect: 'text' }}
              onFocus={e => { e.target.style.borderColor = '#3b82f6'; e.target.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.1)'; }}
              onBlur={e => { e.target.style.borderColor = '#e2e8f0'; e.target.style.boxShadow = 'none'; }}
            />
            <button className="btn btn-primary" disabled={chatLoading || !chatInput.trim()} onClick={async () => {
              if (!chatInput.trim() || chatLoading) return;
              const userMsg = chatInput.trim();
              setChatInput('');
              setChatMessages(prev => [...prev, { role: 'user', content: userMsg }]);
              setChatLoading(true);
              setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
              try {
                const allMsgs = [...chatMessages, { role: 'user', content: userMsg }].filter(m => m.role !== 'system');
                const res = await (window as any).api.aiChat({ messages: allMsgs });
                setChatMessages(prev => [...prev, { role: 'assistant', content: res.text }]);
                if (res.estimate) setChatEstimate(res.estimate);
              } catch (e: any) { setChatMessages(prev => [...prev, { role: 'assistant', content: 'エラー: ' + e.message }]); }
              setChatLoading(false);
              setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
            }} style={{ padding: '12px 24px', fontSize: 16, borderRadius: 24, minHeight: 48 }}>送信</button>
          </div>
        </div>
      )}

      {/* ── 業種の確認（初回の見積の前に1度だけ） ── */}
      {askIndustry && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(20,28,40,.62)', zIndex: 4000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        }}>
          <div className="card" style={{ maxWidth: 620, width: '100%', maxHeight: '88vh', overflowY: 'auto', padding: '22px 26px' }}>
            <h3 style={{ margin: '0 0 6px', color: '#1a2b4a', fontSize: 19 }}>はじめに、御社の業種を教えてください</h3>
            <div style={{ fontSize: 13, color: '#5a6675', lineHeight: 1.8, marginBottom: 14 }}>
              <b>この設定で、見積の中身が変わります。</b>
              たとえば内装仕上工事業を選ぶと、躯体・外装・設備は金額に入りません。<br />
              一度だけの確認です。<b>あとから設定画面でいつでも変更できます。</b>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {INDUSTRIES.map(o => (
                <label key={o.v}
                  onClick={() => setIndustryChoice(o.v)}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer',
                    border: `2px solid ${industryChoice === o.v ? '#3a7bd5' : '#e0e6ee'}`,
                    background: industryChoice === o.v ? '#eef4fc' : '#fff',
                    borderRadius: 8, padding: '10px 13px',
                  }}>
                  <input type="radio" name="industry" checked={industryChoice === o.v}
                    onChange={() => setIndustryChoice(o.v)} style={{ marginTop: 4 }} />
                  <span>
                    <span style={{ fontWeight: 'bold', fontSize: 14.5, color: '#1a2b4a' }}>{o.label}</span>
                    <span style={{ display: 'block', fontSize: 12, color: '#6b7787', marginTop: 2 }}>{o.hint}</span>
                  </span>
                </label>
              ))}
            </div>
            <div style={{ marginTop: 16, textAlign: 'right' }}>
              <button className="btn btn-primary" onClick={saveIndustry}
                disabled={!industryChoice || industrySaving}>
                {industrySaving ? '保存中…' : 'この業種で見積もる'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 画像アップロードエリア（チャットモード以外） */}
      {mode !== 'chat' && (mode === 'single' ? (
        <div className="card" style={{ textAlign: 'center', marginTop: 12 }}>
          {!imageData ? (
            <div
              onClick={selectImage}
              {...dropZoneProps('single')}
              style={{
                border: `3px dashed ${dragTarget === 'single' ? '#3a7bd5' : '#ccc'}`, borderRadius: 12, padding: '60px 20px',
                cursor: 'pointer', color: dragTarget === 'single' ? '#3a7bd5' : '#aaa', transition: 'all 0.2s',
                background: dragTarget === 'single' ? '#eef4fc' : 'transparent',
              }}
              onMouseOver={e => { if (dragTarget) return; (e.currentTarget as HTMLElement).style.borderColor = '#3a7bd5'; (e.currentTarget as HTMLElement).style.color = '#3a7bd5'; }}
              onMouseOut={e => { if (dragTarget) return; (e.currentTarget as HTMLElement).style.borderColor = '#ccc'; (e.currentTarget as HTMLElement).style.color = '#aaa'; }}
            >
              <div style={{ fontSize: 48, marginBottom: 12 }}>{dragTarget === 'single' ? '📥' : '📷'}</div>
              <div style={{ fontSize: 18, fontWeight: 'bold' }}>{dragTarget === 'single' ? 'ここにドロップ' : '写真・図面（PDF可）をドラッグ&ドロップ'}</div>
              <div style={{ fontSize: 13, marginTop: 8, color: '#666' }}>現場写真 / 間取り図 / 平面図 / 設計図 / 立面図 OK（PDFのまま入れられます）</div>
              <div style={{ fontSize: 12, marginTop: 4 }}>ドラッグ&ドロップ、またはクリックして選択（なくてもコメントだけで見積可能）</div>
            </div>
          ) : (
            <div {...dropZoneProps('single')} style={{ borderRadius: 8, outline: dragTarget === 'single' ? '3px dashed #3a7bd5' : 'none', outlineOffset: 4 }}>
              {isPdfData(imageData) ? (
                <div style={{
                  border: '2px solid #c62828', background: '#fdf3f2', borderRadius: 10,
                  padding: '26px 20px', maxWidth: 420, margin: '0 auto',
                }}>
                  <div style={{ fontSize: 40 }}>📄</div>
                  <div style={{ fontSize: 16, fontWeight: 'bold', color: '#a5342f', marginTop: 6 }}>PDFを読み込みました</div>
                  <div style={{ fontSize: 12, color: '#7b241c', marginTop: 6, lineHeight: 1.7 }}>
                    図面PDFはそのままAIが読みます（画像に変換する必要はありません）。<br />
                    ページ数が多いPDFは、必要なページだけに分けて入れると精度が上がります。
                  </div>
                </div>
              ) : (
                <img src={imageData} style={{ maxWidth: '100%', maxHeight: 350, borderRadius: 8, border: '1px solid #ddd' }} alt="uploaded" />
              )}
              {/* 追加写真のサムネイル（外壁4面・屋根・室内など、1枚に収まらない現場向け） */}
              {extraImages.length > 0 && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 10 }}>
                  {extraImages.map((img, i) => (
                    <div key={i} style={{ position: 'relative' }}>
                      {isPdfData(img) ? (
                        <div style={{
                          width: 104, height: 78, borderRadius: 6, border: '1px solid #e0b4b0', background: '#fdf3f2',
                          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#a5342f',
                        }}>
                          <div style={{ fontSize: 22 }}>📄</div>
                          <div style={{ fontSize: 10, fontWeight: 'bold' }}>PDF</div>
                        </div>
                      ) : (
                        <img src={img} alt={`追加資料${i + 2}`}
                          style={{ width: 104, height: 78, objectFit: 'cover', borderRadius: 6, border: '1px solid #ddd' }} />
                      )}
                      <span style={{
                        position: 'absolute', left: 4, bottom: 4, background: 'rgba(0,0,0,.62)', color: '#fff',
                        fontSize: 10, padding: '1px 6px', borderRadius: 8,
                      }}>{i + 2}枚目</span>
                      <button
                        onClick={() => removeExtraImage(i)}
                        title="この写真を外す"
                        style={{
                          position: 'absolute', top: -7, right: -7, width: 21, height: 21, borderRadius: '50%',
                          border: 'none', background: '#c0392b', color: '#fff', fontSize: 12, cursor: 'pointer', lineHeight: '21px', padding: 0,
                        }}
                      >×</button>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ marginTop: 12 }}>
                <button className="btn btn-secondary btn-sm" onClick={selectImage}>1枚目を選び直す</button>
                <button className="btn btn-primary btn-sm" onClick={addExtraImage} style={{ marginLeft: 6 }}
                  disabled={1 + extraImages.length >= MAX_IMAGES}>
                  ＋ 写真を追加（{1 + extraImages.length}/{MAX_IMAGES}）
                </button>
                <div style={{ fontSize: 11, color: '#888', marginTop: 6 }}>
                  外壁4面・屋根・室内など、<strong>1枚に収まらない現場は複数枚入れてください。</strong>
                  面積の読み取りと完成イメージには1枚目を使います。1枚目を選び直すと追加分は消えます。
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="card" style={{ marginTop: 12 }}>
          <h3 style={{ marginBottom: 12, textAlign: 'center' }}>🔄 ビフォー・アフター写真から工事内容を判定</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {/* Before */}
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 'bold', color: '#e74c3c', marginBottom: 8 }}>Before（施工前）</div>
              {!beforeImage ? (
                <div
                  onClick={selectBeforeImage}
                  {...dropZoneProps('before')}
                  style={{
                    border: '2px dashed #e74c3c', borderRadius: 8, padding: '40px 12px',
                    cursor: 'pointer', color: '#e74c3c', transition: 'all 0.2s',
                    background: dragTarget === 'before' ? '#fcdcd8' : '#fef5f5',
                  }}
                >
                  <div style={{ fontSize: 32 }}>{dragTarget === 'before' ? '📥' : '📷'}</div>
                  <div style={{ fontSize: 12, marginTop: 4 }}>{dragTarget === 'before' ? 'ここにドロップ' : 'ドラッグ&ドロップ / クリックで選択'}</div>
                </div>
              ) : (
                <div {...dropZoneProps('before')} style={{ borderRadius: 8, outline: dragTarget === 'before' ? '3px dashed #e74c3c' : 'none', outlineOffset: 3 }}>
                  <img src={beforeImage} style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 8, border: '2px solid #e74c3c' }} alt="before" />
                  <div style={{ marginTop: 8 }}>
                    <button className="btn btn-secondary btn-sm" onClick={selectBeforeImage} style={{ fontSize: 11 }}>変更</button>
                  </div>
                </div>
              )}
            </div>
            {/* After */}
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 'bold', color: '#27ae60', marginBottom: 8 }}>After（施工後）</div>
              {!afterImage ? (
                <div
                  onClick={selectAfterImage}
                  {...dropZoneProps('after')}
                  style={{
                    border: '2px dashed #27ae60', borderRadius: 8, padding: '40px 12px',
                    cursor: 'pointer', color: '#27ae60', transition: 'all 0.2s',
                    background: dragTarget === 'after' ? '#d6f5e0' : '#f0fff4',
                  }}
                >
                  <div style={{ fontSize: 32 }}>{dragTarget === 'after' ? '📥' : '📷'}</div>
                  <div style={{ fontSize: 12, marginTop: 4 }}>{dragTarget === 'after' ? 'ここにドロップ' : 'ドラッグ&ドロップ / クリックで選択'}</div>
                </div>
              ) : (
                <div {...dropZoneProps('after')} style={{ borderRadius: 8, outline: dragTarget === 'after' ? '3px dashed #27ae60' : 'none', outlineOffset: 3 }}>
                  <img src={afterImage} style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 8, border: '2px solid #27ae60' }} alt="after" />
                  <div style={{ marginTop: 8 }}>
                    <button className="btn btn-secondary btn-sm" onClick={selectAfterImage} style={{ fontSize: 11 }}>変更</button>
                  </div>
                </div>
              )}
            </div>
          </div>
          <p style={{ textAlign: 'center', fontSize: 12, color: '#888', marginTop: 12 }}>
            2枚の写真の差分からAIが工事内容を判定し、同様の工事の見積もりを算出します
          </p>
        </div>
      ))}

      {/* コメント欄 + 場所 + 解析ボタン（チャットモード以外） */}
      {mode !== 'chat' && !result && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3 style={{ marginBottom: 10 }}>📝 工事内容・補足情報</h3>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 'bold', color: '#555', display: 'block', marginBottom: 4 }}>📍 場所（現場住所・物件名）</label>
            <input
              type="text"
              value={location}
              onChange={e => setLocation(e.target.value)}
              placeholder="例: 大阪市北区梅田1-2-3 / ○○マンション302号室"
              style={{
                width: '100%', padding: '10px 12px', border: '1px solid #ddd',
                borderRadius: 8, fontSize: 14, fontFamily: 'inherit',
              }}
            />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 'bold', color: '#555', display: 'block', marginBottom: 4 }}>📐 面積・数量（実測値／わかる範囲でOK）</label>
            <input
              type="text"
              value={area}
              onChange={e => setArea(e.target.value)}
              placeholder="例: 屋根 450㎡（実測） / 外壁 320㎡ / 床 80㎡ ・ 20坪"
              style={{
                width: '100%', padding: '10px 12px', border: '1px solid #ddd',
                borderRadius: 8, fontSize: 14, fontFamily: 'inherit',
              }}
            />
            <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>実測値を入れると、写真・航空写真からの推定を使わず正確に計算します（信頼度アップ）。</div>
          </div>

          {/* ── 図面からの数量拾い出し ──
              見積の数量を「AIの目測」から「図面の寸法＋計算式」に変える工程。
              ここで拾った数量は、見積側で確定値として扱われる（推定で上書きされない）。 */}
          <div style={{ marginBottom: 12, border: '1px solid #d9e2ec', borderRadius: 10, overflow: 'hidden' }}>
            <div
              onClick={() => setTakeoffOpen(o => !o)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer',
                padding: '10px 12px', background: hasTakeoff ? '#eaf6ee' : '#f4f7fa',
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 'bold', color: '#37474f' }}>
                📐 図面・材料一覧表から数量を拾う（PDF・画像）
                {hasTakeoff && (
                  <span style={{ marginLeft: 8, fontSize: 11, color: '#2e7d32', fontWeight: 'bold' }}>
                    ✓ {(takeoff.items || []).length}項目を拾い出し済み
                  </span>
                )}
              </div>
              <span style={{ fontSize: 12, color: '#78909c' }}>{takeoffOpen ? '▲ 閉じる' : '▼ 開く'}</span>
            </div>

            {takeoffOpen && (
              <div style={{ padding: 12 }}>
                <div style={{ fontSize: 11, color: '#607d8b', marginBottom: 8, lineHeight: 1.6 }}>
<strong>図面</strong>（平面図・立面図・屋根伏図・建具表など）を入れると、寸法から<strong>計算式つきの数量</strong>を拾います。<br />
                  <strong>すでに数量が書かれた表</strong>（材料一覧表・数量拾い表・内訳書・Excelの画面を撮ったもの）でもOK。その場合は<strong>書いてある数字をそのまま使います</strong>（勝手に換算・ロス上乗せはしません。小計行は除きます）。<br />
                  拾った数量は見積の確定値になります（写真からの推定で上書きされません）。読めない部分は推測せず「拾えなかった項目」として出します。
                </div>

                <div
                  onDragOver={e => { e.preventDefault(); if (!takeoffDragging) setTakeoffDragging(true); }}
                  onDragLeave={e => { e.preventDefault(); setTakeoffDragging(false); }}
                  onDrop={dropTakeoffFiles}
                  style={{
                    border: `2px dashed ${takeoffDragging ? '#3498db' : '#cfd8dc'}`,
                    background: takeoffDragging ? '#eaf4fc' : '#fafbfc',
                    borderRadius: 8, padding: 14, textAlign: 'center', marginBottom: 10,
                  }}
                >
                  <div style={{ fontSize: 13, color: '#546e7a', marginBottom: 8 }}>
                    ここに図面・材料一覧表をドラッグ&ドロップ（PDF・JPG・PNG／6ファイルまで）
                  </div>
                  <button className="btn btn-secondary btn-sm" type="button" onClick={addTakeoffFile} disabled={takeoffLoading}>
                    📄 図面・表を選ぶ
                  </button>
                </div>

                {takeoffFiles.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                    {takeoffFiles.map((f, i) => (
                      <span key={i} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6, background: '#eceff1',
                        borderRadius: 14, padding: '4px 10px', fontSize: 11, color: '#455a64',
                      }}>
                        {f.type === 'pdf' ? '📄' : '🖼'} {f.name}
                        <button
                          type="button"
                          onClick={() => { setTakeoffFiles(prev => prev.filter((_, j) => j !== i)); setTakeoff(null); }}
                          style={{ border: 'none', background: 'none', color: '#90a4ae', cursor: 'pointer', fontSize: 13, padding: 0 }}
                        >×</button>
                      </span>
                    ))}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    value={takeoffTargets}
                    onChange={e => setTakeoffTargets(e.target.value)}
                    placeholder="拾ってほしい対象（任意）例: 屋根と外壁だけ / 建具の数量"
                    style={{ flex: '2 1 220px', padding: '8px 10px', border: '1px solid #ddd', borderRadius: 8, fontSize: 13, fontFamily: 'inherit' }}
                  />
                  <input
                    type="text"
                    value={takeoffScale}
                    onChange={e => setTakeoffScale(e.target.value)}
                    placeholder="縮尺の指定（任意）例: 1/100"
                    style={{ flex: '1 1 130px', padding: '8px 10px', border: '1px solid #ddd', borderRadius: 8, fontSize: 13, fontFamily: 'inherit' }}
                  />
                </div>

                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={runTakeoff}
                  disabled={takeoffFiles.length === 0 || takeoffLoading}
                  style={{ width: '100%' }}
                >
                  {takeoffLoading ? '📐 図面を読み取っています…' : '📐 この図面から数量を拾う（AIストック2）'}
                </button>

                {hasTakeoff && (
                  <div style={{ marginTop: 14 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
                      <div style={{ fontSize: 12, color: '#37474f' }}>
                        <strong>拾い出し結果</strong>
                        {takeoff.scale && <span style={{ marginLeft: 8, color: '#607d8b' }}>縮尺 {takeoff.scale}（{takeoff.scaleSource || '根拠不明'}）</span>}
                        {takeoff.overallConfidence && (
                          <span style={{
                            marginLeft: 8, fontWeight: 'bold',
                            color: takeoff.overallConfidence === '高' ? '#2e7d32' : takeoff.overallConfidence === '中' ? '#ef6c00' : '#c62828',
                          }}>総合確度 {takeoff.overallConfidence}</span>
                        )}
                      </div>
                      <button
                        className="btn btn-secondary btn-sm"
                        type="button"
                        onClick={async () => {
                          try {
                            await (window as any).api.generateTakeoffPDF({
                              takeoff, title: takeoff.title || comment.slice(0, 30), clientName,
                            });
                          } catch (e: any) { alert('PDF生成に失敗: ' + (e.message || e)); }
                        }}
                      >📄 拾い出し明細をPDFで出す</button>
                    </div>

                    {(takeoff.summary || []).length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                        {(takeoff.summary || []).map((sm: any, i: number) => (
                          <span key={i} style={{ background: '#e8f0fe', border: '1px solid #d0e0f5', borderRadius: 6, padding: '4px 10px', fontSize: 11, color: '#33475b' }}>
                            <strong>{sm.label}</strong>: {sm.value}
                          </span>
                        ))}
                      </div>
                    )}

                    <div style={{ overflowX: 'auto' }}>
                      <table className="data-table" style={{ fontSize: 12 }}>
                        <thead>
                          <tr>
                            <th style={{ width: 60 }}>部位</th>
                            <th>材料・工種</th>
                            <th style={{ width: 170 }}>計算式（根拠）</th>
                            <th style={{ width: 90, textAlign: 'right' }}>数量</th>
                            <th style={{ width: 44 }}>単位</th>
                            <th style={{ width: 110 }}>出典</th>
                            <th style={{ width: 44, textAlign: 'center' }}>確度</th>
                            <th style={{ width: 30 }}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {(takeoff.items || []).map((it: any, i: number) => (
                            <tr key={i}>
                              <td style={{ color: '#607d8b' }}>{it.part || '—'}</td>
                              <td>
                                <div>
                                  {it.name}
                                  {Number(it.unitPrice) > 0 && (
                                    <span style={{
                                      marginLeft: 6, background: '#e7f6ec', border: '1px solid #a8d8ba', color: '#14603a',
                                      fontSize: 10, fontWeight: 'bold', padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap',
                                    }} title={it.priceSource || '資料に記載された単価'}>
                                      資料の単価 {Math.round(Number(it.unitPrice)).toLocaleString()}円/{it.unit || ''}
                                    </span>
                                  )}
                                </div>
                                {(it.dimensions || it.deduction || it.assumption || Number(it.lossRate) > 0) && (
                                  <div style={{ fontSize: 10, color: '#90a4ae', marginTop: 2 }}>
                                    {it.dimensions ? `寸法 ${it.dimensions}` : ''}
                                    {it.deduction ? `${it.dimensions ? ' / ' : ''}${it.deduction}` : ''}
                                    {Number(it.lossRate) > 0 ? ` / ロス${Math.round(Number(it.lossRate) * 100)}%込 ${it.quantityWithLoss}${it.unit || ''}` : ''}
                                    {it.assumption ? ` / 仮定: ${it.assumption}` : ''}
                                  </div>
                                )}
                              </td>
                              <td style={{ fontFamily: 'monospace', fontSize: 11, color: '#546e7a' }}>{it.formula || '—'}</td>
                              <td style={{ textAlign: 'right' }}>
                                <NumInput
                                  value={Number(it.quantity) || 0}
                                  onValue={n => editTakeoffQty(i, n)}
                                  style={{ width: 80, padding: '4px 6px', textAlign: 'right', border: '1px solid #ddd', borderRadius: 6, fontSize: 12, fontFamily: 'inherit' }}
                                />
                              </td>
                              <td>{it.unit}</td>
                              <td style={{ fontSize: 10, color: '#78909c' }}>{it.source || '—'}</td>
                              <td style={{
                                textAlign: 'center', fontWeight: 'bold',
                                color: it.confidence === '高' ? '#2e7d32' : it.confidence === '中' ? '#ef6c00' : '#c62828',
                              }}>{it.confidence || '—'}</td>
                              <td>
                                <button
                                  type="button"
                                  title="この行を消す"
                                  onClick={() => removeTakeoffItem(i)}
                                  style={{ border: 'none', background: 'none', color: '#b0bec5', cursor: 'pointer', fontSize: 14 }}
                                >×</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                      数量は直接直せます。直した行は「人が確定させた数量」として扱われ、見積はその値で積算します。
                    </div>

                    {(takeoff.unreadable || []).length > 0 && (
                      <div style={{ marginTop: 10, background: '#fff8e1', border: '1px solid #f0dfa8', borderRadius: 8, padding: '8px 12px' }}>
                        <div style={{ fontSize: 12, fontWeight: 'bold', color: '#8d6e00', marginBottom: 4 }}>⚠ 図面から拾えなかった項目</div>
                        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: '#795548', lineHeight: 1.7 }}>
                          {(takeoff.unreadable || []).map((u: string, i: number) => <li key={i}>{u}</li>)}
                        </ul>
                        <div style={{ fontSize: 10, color: '#a1887f', marginTop: 4 }}>
                          ここは推測で数量を作っていません。該当の図面を追加するか、実測値を上の欄に入れてください。
                        </div>
                      </div>
                    )}

                    {(takeoff.warnings || []).length > 0 && (
                      <div style={{ marginTop: 8, background: '#f4f6f8', border: '1px solid #dde3e8', borderRadius: 8, padding: '8px 12px' }}>
                        <div style={{ fontSize: 12, fontWeight: 'bold', color: '#546e7a', marginBottom: 4 }}>図面上の注意点</div>
                        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: '#607d8b', lineHeight: 1.7 }}>
                          {(takeoff.warnings || []).map((w: string, i: number) => <li key={i}>{w}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 屋根種別 — 展開係数（材料面積÷屋根面積）は種別で変わる。お客様に聞いて選べば、AIの写真判定より確実。 */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 'bold', color: '#555', display: 'block', marginBottom: 4 }}>🏠 屋根種別（折板・波板の材料工事のとき — お客様に確認）</label>
            <select
              value={roofType}
              onChange={e => setRoofType(e.target.value)}
              style={{ width: '100%', padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, fontFamily: 'inherit', background: '#fff' }}
            >
              <option value="">自動（AIが写真から判定）</option>
              <option value="折板88mm|1.41">折板 88mm（一般）… 展開係数 ×1.41</option>
              <option value="折板150mm|1.69">折板 150mm（大スパン）… 展開係数 ×1.69</option>
              <option value="スレート大波|1.1">スレート大波 … 展開係数 ×1.1</option>
              <option value="平葺き・瓦・シングル|1.0">平葺き・瓦・シングル … 補正なし ×1.0</option>
            </select>
            <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
              折板は山谷のぶん材料面積が増えます。<strong>お客様に屋根種別を聞いて選ぶと、AIの判定より確実に展開係数が当たります。</strong>（塗装・葺き替えなど材料が波形に沿わない工事は「自動」でOK）
            </div>
          </div>

          {/* 建物構造＋築年数 — 解体・撤去の手間、下地・躯体、耐震・石綿の前提が変わる。
              未選択でもAIが写真・図面・内外装の年代感から推察して逆算する。 */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 'bold', color: '#555', display: 'block', marginBottom: 4 }}>🏗️ 建物構造・築年数（改修・解体のとき — わかれば選ぶと精度アップ）</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <select
                value={structure}
                onChange={e => setStructure(e.target.value)}
                style={{ flex: 1, padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, fontFamily: 'inherit', background: '#fff' }}
              >
                <option value="">構造：AIが推察（未選択）</option>
                <option value="木造">木造（W造）</option>
                <option value="鉄骨造">鉄骨造（S造）</option>
                <option value="鉄筋コンクリート造">鉄筋コンクリート造（RC造）</option>
                <option value="鉄骨鉄筋コンクリート造">鉄骨鉄筋コンクリート造（SRC造）</option>
              </select>
              <input
                type="number"
                min={0}
                value={buildingAge}
                onChange={e => setBuildingAge(e.target.value)}
                placeholder="築年数（例: 30）"
                style={{ width: 150, padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, fontFamily: 'inherit' }}
              />
            </div>
            <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
              未選択・未入力でもOK。<strong>写真・図面・内外装の年代感（サッシ・外壁材・タイル・設備の意匠）から築年帯を推察して逆算します。</strong>改修・解体では築年数が古いほど既存撤去・下地補修・石綿調査・基礎点検の余裕を織り込みます（新築工事では無視）。
            </div>
          </div>

          {/* 現場条件 — 足場・搬入・アクセス・居ながら。写真に写らないが足場代・運搬・段取り・危険手当を直撃する。
              未選択でもAIが写真から推察するが、わかれば選ぶと精度が大きく上がる。 */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 'bold', color: '#555', display: 'block', marginBottom: 4 }}>🚧 現場条件（足場・搬入・居ながら — 写真に写らないが金額を左右）</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <select
                value={siteAccess}
                onChange={e => setSiteAccess(e.target.value)}
                style={{ padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, fontFamily: 'inherit', background: '#fff' }}
              >
                <option value="">搬入・道路：AIが推察（未選択）</option>
                <option value="前面道路が広く重機・トラック横付け可">重機・トラック横付け可（搬入良好）</option>
                <option value="前面道路が狭くトラックは可だが重機は不可">道路狭め（トラック可／重機不可）</option>
                <option value="車両進入困難で人力小運搬が必要（旗竿地・狭小・階段等）">車両進入困難・人力小運搬（旗竿地/狭小）</option>
              </select>
              <select
                value={siteAdjacency}
                onChange={e => setSiteAdjacency(e.target.value)}
                style={{ padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, fontFamily: 'inherit', background: '#fff' }}
              >
                <option value="">隣地・足場：AIが推察（未選択）</option>
                <option value="四周に余裕があり足場は組みやすい">四周に余裕あり（足場組みやすい）</option>
                <option value="隣地が近く足場・養生に制約あり（狭あい）">隣地が近い（足場・養生に制約）</option>
                <option value="越境・借地・特殊足場が必要な近接状況">越境/借地/特殊足場が必要</option>
              </select>
              <select
                value={siteOccupied}
                onChange={e => setSiteOccupied(e.target.value)}
                style={{ padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, fontFamily: 'inherit', background: '#fff' }}
              >
                <option value="">居住状況：AIが推察（未選択）</option>
                <option value="空き家・無人で施工の制約が少ない">空き家・無人（制約少）</option>
                <option value="居ながら施工。養生・時間帯配慮・近隣対応で手間増">居ながら施工（養生・時間帯・近隣配慮）</option>
                <option value="店舗・施設の営業中施工で夜間・区画割りが必要">営業中施工（夜間/区画割り）</option>
              </select>
              <select
                value={siteStories}
                onChange={e => setSiteStories(e.target.value)}
                style={{ padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, fontFamily: 'inherit', background: '#fff' }}
              >
                <option value="">階数・高さ：AIが推察（未選択）</option>
                <option value="平屋">平屋</option>
                <option value="2階建て">2階建て</option>
                <option value="3階建て">3階建て</option>
                <option value="4階建て以上（高所・危険手当・特殊足場）">4階建て以上（高所・危険手当）</option>
              </select>
            </div>
            <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
              未選択でもOK。<strong>写真・地図・図面から現場条件を推察して足場・小運搬・養生・危険手当を積算します。</strong>選んでおくと「写真に写らない現場の手間」がブレずに金額へ反映されます（過剰計上はしません）。
            </div>
          </div>

          {/* 希望納期/工期 — 推定工期より短い時にAIが「増員・残業・応援で詰める案＋割増費用」or「最短◯日を推奨」を提案・相談する。 */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 'bold', color: '#555', display: 'block', marginBottom: 4 }}>⏱️ 希望納期・工期（急ぎのとき — AIが短縮案を提案）</label>
            <input
              type="text"
              value={desiredDeadline}
              onChange={e => setDesiredDeadline(e.target.value)}
              placeholder="例: 1日で / 3日以内 / 今週末まで / ◯月◯日まで"
              style={{ width: '100%', padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, fontFamily: 'inherit' }}
            />
            <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
              未入力でOK。<strong>希望が推定工期より短いと、AIが「増員・残業・応援でこう詰められます（割増費用◯円）」or「最短◯日を推奨（無理な短縮は品質・安全リスク）」を提案・相談します。</strong>金額（本体）は変えず、短縮に伴う割増だけ別提案します。
            </div>
          </div>

          {/* お客様(施主)の情報 — 提案のパーソナライズ専用。金額には一切影響させない。 */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 'bold', color: '#555', display: 'block', marginBottom: 4 }}>
              👤 お客様の情報（任意 — 提案の精度が上がります）
            </label>
            {/* 顧客名: 職業・趣味を入れて見積すると顧客DBに保存。次回同じ名前で自動読込。 */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              <input
                type="text"
                value={clientName}
                onChange={e => { setClientName(e.target.value); setProfileLoaded(''); }}
                onBlur={loadCustomerProfile}
                placeholder="顧客名（例: 中野工務店 様）"
                style={{ flex: 1, padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, fontFamily: 'inherit' }}
              />
              <input
                type="text"
                value={clientHobby}
                onChange={e => setClientHobby(e.target.value)}
                placeholder="趣味（例: ゴルフ・車・ガーデニング）"
                style={{ flex: 1, padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, fontFamily: 'inherit' }}
              />
            </div>
            {profileLoaded && (
              <div style={{ fontSize: 11, color: '#2563eb', marginBottom: 8 }}>
                ✓「{profileLoaded}」様の登録済みプロフィールを読み込みました
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <select
                value={clientJob}
                onChange={e => setClientJob(e.target.value)}
                style={{ flex: 1, padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, fontFamily: 'inherit', background: '#fff' }}
              >
                <option value="">職業・立場（未選択）</option>
                {['会社経営者', '個人事業主', '会社員', '公務員', '医師・士業', '農林業・漁業', '不動産オーナー', '法人（管理会社）', '退職・年金生活', 'その他'].map(j => (
                  <option key={j} value={j}>{j}</option>
                ))}
              </select>
              <select
                value={clientAge}
                onChange={e => setClientAge(e.target.value)}
                style={{ flex: 1, padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, fontFamily: 'inherit', background: '#fff' }}
              >
                <option value="">年代（未選択）</option>
                {['20〜30代', '40代', '50代', '60代', '70代以上'].map(a => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {['価格重視', '見た目・デザイン', '耐久性・長持ち', '光熱費・省エネ', '工期の短さ', '近隣への配慮', '補助金を使いたい'].map(p => {
                const on = clientPriorities.includes(p);
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setClientPriorities(prev => on ? prev.filter(x => x !== p) : [...prev, p])}
                    style={{
                      padding: '6px 12px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
                      border: on ? '1px solid #2563eb' : '1px solid #ddd',
                      background: on ? '#eff6ff' : '#fff',
                      color: on ? '#1d4ed8' : '#555',
                      fontWeight: on ? 'bold' : 'normal',
                    }}
                  >{on ? '✓ ' : ''}{p}</button>
                );
              })}
            </div>
            <div style={{ fontSize: 11, color: '#888', marginTop: 6 }}>
              提案（💡欄）のパーソナライズにのみ使います。<strong>見積金額には一切影響しません。</strong><br />
              顧客名＋職業/趣味を入れて見積すると顧客DBに保存され、次回同じ顧客名で自動的に読み込まれます。
            </div>
          </div>

          <label style={{ fontSize: 13, fontWeight: 'bold', color: '#555', display: 'block', marginBottom: 4 }}>🔨 工事内容</label>
          <textarea
            value={comment}
            onChange={e => setComment(e.target.value)}
            placeholder="例:&#10;・キッチンとお風呂のリフォーム希望&#10;・築30年の木造2階建て&#10;・耐震補強も検討中&#10;・予算は500万円くらい&#10;・2階の洋室を和室に変更したい"
            style={{
              width: '100%', minHeight: 120, padding: 12, border: '1px solid #e2e8f0',
              borderRadius: 8, fontSize: 14, lineHeight: 1.7, resize: 'vertical',
              fontFamily: 'inherit', color: '#1e293b', background: '#fff',
              WebkitUserSelect: 'text', userSelect: 'text',
            }}
          />
          {/* 面積の事前確認。ここで直せば、見積後の「再計算」でクレジットを二重に使わずに済む */}
          {areaCheck && (
            <div className="card" style={{ marginTop: 12, background: '#eff6ff', border: '1px solid #93c5fd', padding: '14px 16px' }}>
              <div style={{ fontSize: 13, fontWeight: 'bold', color: areaCheck.isEstimate ? '#b45309' : '#1e40af', marginBottom: 6 }}>
                {areaCheck.mode === 'drawing' && !areaCheck.isEstimate
                  ? `📐 図面に書かれた数値から計算した${areaCheck.targetLabel || ''}の面積です。合っていますか？`
                  : areaCheck.isEstimate
                    ? `📐 写真からの概算です。${areaCheck.targetLabel || '対象'}の面積はまだ確定していません`
                    : `📐 読み取った${areaCheck.targetLabel || ''}の面積です。合っていますか？（信頼度: ${areaCheck.confidence}）`}
              </div>
              {/* 図面モードで実際に読めた記載値。何を根拠にしたかを隠さない */}
              {areaCheck.mode === 'drawing' && !!(areaCheck.readValues || []).length && (
                <div style={{ fontSize: 12, color: '#065f46', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 4, padding: '6px 8px', marginBottom: 8 }}>
                  <div style={{ fontWeight: 'bold', marginBottom: 2 }}>図面から読み取った値</div>
                  {(areaCheck.readValues || []).map((v, i) => <div key={i}>・{v}</div>)}
                </div>
              )}
              {!!areaCheck.modeWarning && (
                <div style={{ fontSize: 12, color: '#7f1d1d', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 4, padding: '6px 8px', marginBottom: 8 }}>
                  {areaCheck.modeWarning}
                </div>
              )}
              {areaCheck.unvalidated && (
                <div style={{ fontSize: 12, color: '#78350f', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 4, padding: '6px 8px', marginBottom: 8 }}>
                  {areaCheck.targetLabel}の推定は検証データが少ないため、屋根より精度が落ちます。実測に直してください。
                  直した値を学習して、次回から御社の写真に合わせて寄っていきます。
                </div>
              )}
              {areaCheck.isEstimate && (
                <div style={{ fontSize: 12, color: '#78350f', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 4, padding: '6px 8px', marginBottom: 8 }}>
                  {!!areaCheck.rangeMinM2 && !!areaCheck.rangeMaxM2 && (
                    <div style={{ marginBottom: 4 }}>
                      想定レンジ: <strong>{areaCheck.rangeMinM2}〜{areaCheck.rangeMaxM2}㎡</strong>
                      <span style={{ opacity: .8 }}>（写真だけでは寸法の基準が無いため、この幅は縮みません{areaCheck.rangeBasis ? `／${areaCheck.rangeBasis}` : ''}）</span>
                    </div>
                  )}
                  {areaCheck.needsDimension && (
                    <div><strong>{areaCheck.needsDimension}</strong> が分かれば正確に計算できます。</div>
                  )}
                  {areaCheck.missingPart && <div style={{ marginTop: 4 }}>写っていない部分: {areaCheck.missingPart}</div>}
                  <div style={{ marginTop: 4 }}>このまま進めても構いません。分かる範囲で下の欄を直してください。</div>
                </div>
              )}
              <div style={{ fontSize: 12, color: '#475569', marginBottom: 4 }}>根拠: {areaCheck.basis}</div>
              {areaCheck.scaleRef && (
                <div style={{ fontSize: 12, color: '#475569', marginBottom: 4 }}>基準にした寸法: {areaCheck.scaleRef}</div>
              )}
              {/* 折板屋根は山谷があるぶん、実際に張る面積が屋根面積より大きい（展開係数） */}
              {!!areaCheck.roofAreaM2 && !!areaCheck.developFactor && areaCheck.developFactor > 1 && (
                <div style={{ fontSize: 12, color: '#1e40af', marginBottom: 8, background: '#dbeafe', padding: '4px 8px', borderRadius: 4 }}>
                  屋根面積 {areaCheck.roofAreaM2}㎡ × 展開係数 {areaCheck.developFactor}（山谷の凹凸ぶん）＝ 見積数量 {areaCheck.quantityM2}㎡
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={{ fontSize: 13, color: '#334155', whiteSpace: 'nowrap' }}>見積数量</label>
                <input
                  type="number"
                  min={0}
                  step="0.1"
                  value={confirmArea}
                  onFocus={e => e.currentTarget.select()}
                  onChange={e => setConfirmArea(e.target.value)}
                  style={{ width: 110, padding: '8px 12px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 15, fontWeight: 600, textAlign: 'right', fontFamily: 'inherit' }}
                />
                <span style={{ fontSize: 14, color: '#334155' }}>㎡</span>
                {!!areaCheck.quantityM2 && Number(confirmArea) !== Math.round(areaCheck.quantityM2) && (
                  <span style={{ fontSize: 11, color: '#64748b' }}>AIの推定 {Math.round(areaCheck.quantityM2)}㎡</span>
                )}
                <button className="btn btn-primary" disabled={analyzing || !(Number(confirmArea) > 0)} onClick={proceedWithArea} style={{ whiteSpace: 'nowrap' }}>
                  この面積で見積もる
                </button>
                <button className="btn" disabled={analyzing} onClick={() => analyze()} style={{ whiteSpace: 'nowrap' }}>
                  面積を指定せず見積もる
                </button>
              </div>
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>
                実測値に直してから見積もると、金額が正確になります。ここでの確認はクレジットを消費しません。
                {!areaCheck.isEstimate && <>直した値は<strong>次回以降の面積推定の精度に反映されます</strong>。</>}
              </div>
              {!!areaCheck.calibrationSamples && (
                <div style={{ fontSize: 11, color: '#1e40af', marginTop: 4 }}>
                  実測 {areaCheck.calibrationSamples} 件を学習済み（補正係数 ×{areaCheck.calibration}）
                </div>
              )}
              {learned && (
                <div style={{ fontSize: 12, color: '#065f46', background: '#d1fae5', border: '1px solid #6ee7b7', borderRadius: 4, padding: '6px 8px', marginTop: 6 }}>
                  ✓ 実測値を学習しました。実測 {learned.samples} 件・補正係数 ×{learned.calibration} で、次回からの推定が寄ります。
                </div>
              )}
            </div>
          )}

          {estTenants.length > 0 && (
            <div style={{ marginTop: 12, padding: 10, border: '1px dashed #94a3b8', borderRadius: 6, background: '#f8fafc' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#334155', marginBottom: 6 }}>
                🔧 検証対象のテナント（管理者のみ表示）
              </div>
              <select value={estTenantId} onChange={e => changeEstTenant(e.target.value)} style={{ padding: '6px 10px', fontSize: 13, minWidth: 280 }}>
                <option value="">管理者（自分）</option>
                {estTenants.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.name}（{t.industryType}{t.isolated ? '・隔離' : ''}）
                  </option>
                ))}
              </select>
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>
                選んだテナントの実績・業種プロンプトで見積もります。作成した物件・見積ログは管理者テナントに保存され、
                そのテナントの学習データは書き換わりません。
              </div>
            </div>
          )}

          {/* 読み取りモード。実測を入れてあるときは面積確認そのものを飛ばすので出さない。
              写真からの面積は、どれだけ良く写っていても概算にしかならない（実測11件で平均誤差35%、
              屋根全体が写っていても差が無かった）。図面に数値が書いてあるならそちらを読むほうが速くて正確。 */}
          {!area.trim() && (imageData || afterImage || beforeImage) && (
            <div style={{ marginTop: 12, padding: '10px 12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 'bold', color: '#334155', marginBottom: 6 }}>この画像の読み取り方</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {([
                  ['auto', 'おまかせ', '図面か写真かをAIが判定します'],
                  ['drawing', '図面として読む', '寸法値・面積表をそのまま読んで計算します'],
                  ['photo', '写真として概算', '幅つきの目安を出します'],
                ] as const).map(([v, label, hint]) => (
                  <label key={v} style={{
                    display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer',
                    padding: '7px 11px', borderRadius: 6, fontSize: 13, lineHeight: 1.5,
                    border: readMode === v ? '1.5px solid #2563eb' : '1.5px solid #cbd5e1',
                    background: readMode === v ? '#eff6ff' : '#fff',
                  }}>
                    <input type="radio" name="readMode" checked={readMode === v}
                      onChange={() => setReadMode(v)} style={{ marginTop: 3 }} />
                    <span>
                      <strong>{label}</strong>
                      <span style={{ display: 'block', fontSize: 11, color: '#64748b' }}>{hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* ── 面積をより確かに出すための2つの道 ──
              実測で分かっていること（app/tools/harness-area）:
                斜め・航空写真からの目測  平均誤差 52.6%
                屋根の上から撮った写真    平均誤差 18.1%
              撮り方を変えるだけで誤差が1/3になる。住所から地理院の航空写真を引けば
              縮尺が確定するので、スケールを推定する工程そのものが消える。 */}
          {!area.trim() && (
            <div style={{ marginTop: 12, padding: '12px 14px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 'bold', color: '#166534', marginBottom: 8 }}>
                面積の精度を上げるには
              </div>

              <div style={{ fontSize: 12, color: '#14532d', lineHeight: 1.8, marginBottom: 10 }}>
                <div><strong>① 屋根の上・真上から近づいて撮る</strong>　斜めや航空写真だと誤差が3倍になります（実測 52.6% → 18.1%）</div>
                <div><strong>② 寸法が分かるものを一緒に写す</strong>　A4の紙・メジャー・1mの棒を屋根に置いて撮ると、それを物差しにできます</div>
              </div>

              <div style={{ borderTop: '1px solid #bbf7d0', paddingTop: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 'bold', color: '#166534', marginBottom: 6 }}>
                  {aerialAllowed ? '③ 住所から航空写真で測る（写真より確か）' : '③ 住所から航空写真で測る　🔒 プロプラン'}
                </div>
                {aerialAllowed ? (
                  <>
                    <div style={{ fontSize: 11, color: '#15803d', marginBottom: 6 }}>
                      国土地理院の航空写真は縮尺が確定しているので、AIがスケールを推測する必要がありません。<br />
                      <strong>何丁目何番何号まで入れてください。</strong>丁目までだと数百m四方の中心が返るので、別の建物を測ってしまいます。
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        type="text"
                        value={siteAddress}
                        onChange={(e) => setSiteAddress(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && siteAddress.trim() && !aerialLoading) runAerial(); }}
                        placeholder="例: 大阪府大阪市都島区中野町1-2-3"
                        style={{ flex: 1, padding: '8px 10px', fontSize: 13, border: '1px solid #86efac', borderRadius: 4 }}
                      />
                      <button className="btn" onClick={runAerial} disabled={aerialLoading || !siteAddress.trim()}
                        style={{ fontSize: 13, padding: '8px 16px', whiteSpace: 'nowrap' }}>
                        {aerialLoading ? '取得中...' : '航空写真で測る'}
                      </button>
                    </div>
                  </>
                ) : (
                  /* 使えないお客様にも「何ができる機能なのか」は見せる。
                     隠すと知られないまま終わり、上位プランを選ぶ理由にならない。 */
                  <div style={{
                    border: '1px dashed #86efac', borderRadius: 6, padding: '10px 12px',
                    background: '#f0fdf4', fontSize: 11, color: '#166534', lineHeight: 1.7,
                  }}>
                    <div style={{ marginBottom: 6 }}>
                      現場の住所を入れると、<strong>国土地理院の航空写真</strong>を真上から呼び出して、
                      画面上で建物の範囲を囲うだけで面積が出ます。
                    </div>
                    <div style={{ marginBottom: 6 }}>
                      写真からの目測は<strong>同じ屋根でも答えが1.5倍ぶれます</strong>が、
                      航空写真は縮尺が確定しているのでぶれません。
                      拾い出しの前に、屋根の数量を現地に行かずに押さえられます。
                    </div>
                    <div style={{ color: '#15803d' }}>
                      ご利用は<strong>「プロ」プラン以上</strong>です。
                      設定画面の「プラン」からお申し込みいただけます。
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 航空写真の結果 */}
          {aerial && (
            <div className="card" style={{ marginTop: 12, background: '#eff6ff', border: '1px solid #93c5fd', padding: '14px 16px' }}>
              <div style={{ fontSize: 13, fontWeight: 'bold', color: aerial.step === 'pick' ? '#1e40af' : aerial.isEstimate ? '#b45309' : '#1e40af', marginBottom: 6 }}>
                {aerial.step === 'pick'
                  ? '🛰 航空写真を取得しました'
                  : aerial.isEstimate
                    ? '🛰 指定された建物を測れませんでした'
                    : `🛰 航空写真から読み取った屋根の面積です。合っていますか？（信頼度: ${aerial.confidence}）`}
              </div>
              <div style={{ fontSize: 12, color: '#1e3a8a', marginBottom: 6 }}>
                {aerial.address}
                {aerial.addressLevelLabel && <span style={{ color: aerial.addressPrecise ? '#15803d' : '#b91c1c' }}>（{aerial.addressLevelLabel}）</span>}
                　／　<strong>1ピクセル = {aerial.mPerPx} m</strong>（{aerial.viewWidthM}m四方・ズーム{aerial.zoom}）
              </div>
              {/* 住所が粗いと、区・丁目の中心にあった無関係な建物を測ってしまう。
                  数字は出るので、言われないと気づけない。いちばん目立つ場所に出す。 */}
              {!!aerial.addressWarning && (
                <div style={{ fontSize: 12, color: '#7f1d1d', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 4, padding: '8px 10px', marginBottom: 8, lineHeight: 1.7 }}>
                  <strong>⚠ この結果は使えません</strong><br />
                  {aerial.addressWarning.split('**').map((s: string, i: number) => i % 2 ? <strong key={i}>{s}</strong> : s)}
                </div>
              )}
              {/* 住所の解決点は建物の上に落ちないことが多い。人に選んでもらう。 */}
              {aerial.step === 'pick' && (
                <div style={{ fontSize: 13, fontWeight: 'bold', color: '#1e40af', background: '#dbeafe', border: '1px solid #93c5fd', borderRadius: 4, padding: '8px 10px', marginBottom: 6 }}>
                  👇 測りたい建物を<span style={{ textDecoration: 'underline' }}>ダブルクリック</span>してください（何度でも変えられます）
                  <div style={{ fontSize: 11, fontWeight: 'normal', color: '#1e3a8a', marginTop: 3, lineHeight: 1.7 }}>
                    写真は<strong>押しっぱなしで動かせます</strong>（上下左右）。目的の建物を画面に入れてから、ダブルクリックしてください。<br />
                    住所だけでは建物を特定できません（番地まで入れても街区の代表点が返るため）。
                    青い十字が住所の位置です。ずれていても問題ありません。
                  </div>
                </div>
              )}
              {!!aerial.aerialImage && (
                <>
                  {/* 広さの切り替え。1タイル=124m四方 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5, fontSize: 11, color: '#1e3a8a' }}>
                    <span>写す範囲:</span>
                    {[1, 3, 5, 7].map(g => (
                      <button key={g} onClick={() => refetchAerial(g)} disabled={aerialLoading}
                        style={{
                          padding: '3px 9px', fontSize: 11, borderRadius: 4, cursor: aerialLoading ? 'wait' : 'pointer',
                          border: aerial.grid === g ? '1.5px solid #2563eb' : '1px solid #cbd5e1',
                          background: aerial.grid === g ? '#dbeafe' : '#fff',
                          fontWeight: aerial.grid === g ? 'bold' : 'normal',
                        }}>
                        {Math.round(124 * g)}m
                      </button>
                    ))}
                    <span style={{ color: '#64748b' }}>四方</span>
                    {/* 倍率は読み込み済みの画像を拡大縮小するだけ。通信しないので何度でも押せる */}
                    <span style={{ marginLeft: 10, color: '#64748b' }}>表示:</span>
                    {[['－', 1 / 1.4], ['＋', 1.4]].map(([label, f]) => (
                      <button key={label as string} onClick={() => zoomAerialTo(aerialZoom * (f as number))}
                        style={{
                          width: 26, padding: '3px 0', fontSize: 12, borderRadius: 4, cursor: 'pointer',
                          border: '1px solid #cbd5e1', background: '#fff', fontWeight: 'bold',
                        }}>{label as string}</button>
                    ))}
                    <button onClick={() => zoomAerialTo(AERIAL_VIEW / (aerial.sizePx || 256))}
                      style={{
                        padding: '3px 9px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
                        border: '1px solid #cbd5e1', background: '#fff',
                      }}>全体</button>
                    <span style={{ color: '#94a3b8' }}>
                      画面の幅 約{Math.round(AERIAL_VIEW / aerialZoom * (aerial.mPerPx || 0.5))}m
                    </span>
                  </div>
                  {/* 外側＝のぞき窓。ここからはみ出したぶんは隠す。
                      内側＝写真の世界。画像も赤枠も同じ入れ物に入れて丸ごと動かすので、
                      写真を動かしても目印が写真からずれない。 */}
                  <div ref={aerialViewRef}
                    style={{
                      position: 'relative', width: '100%', maxWidth: AERIAL_VIEW, height: AERIAL_VIEW,
                      marginBottom: 6, overflow: 'hidden', borderRadius: 4,
                      border: '1px solid #93c5fd', background: '#0f172a',
                      cursor: aerialLoading ? 'wait' : aerialGrabbing ? 'grabbing' : 'grab',
                    }}>
                    <div data-aerial-box
                      style={{
                        position: 'absolute', left: 0, top: 0,
                        width: aerial.sizePx * aerialZoom, height: aerial.sizePx * aerialZoom,
                        transform: `translate(${aerialOff.x}px, ${aerialOff.y}px)`,
                        willChange: 'transform',
                      }}>
                    {/* 押しっぱなしで動かす、ダブルクリックで決定。地図と同じ操作。
                        1クリックで測ってしまうと、見回そうとしただけで測定が走ってしまう。 */}
                    <img src={aerial.aerialImage} alt="航空写真"
                      onMouseDown={startAerialPan}
                      onDoubleClick={recenterAerialAt}
                      draggable={false}
                      style={{
                        width: '100%', height: '100%', display: 'block',
                        userSelect: 'none', pointerEvents: 'auto',
                      }} />
                    {/* 住所の解決点＝青い十字。太く、白フチ付きで航空写真の上でも見えるように。
                        ★寄ったあと（step='result'）は出さない。寄った写真は選ばれた建物が中心なので、
                          青い十字と赤丸が同じ位置に重なって、どちらも見分けられなくなる。
                          「住所の位置」は建物を探す段階でしか意味がない。 */}
                    {aerial.step === 'pick' && !!aerial.centerPx && (() => {
                      const p = `${aerial.centerPx / aerial.sizePx * 100}%`;
                      const line = (horiz: boolean) => ({
                        position: 'absolute' as const, left: p, top: p, pointerEvents: 'none' as const,
                        width: horiz ? 46 : 6, height: horiz ? 6 : 46,
                        marginLeft: horiz ? -23 : -3, marginTop: horiz ? -3 : -23,
                        background: '#2563eb', border: '1.5px solid #fff', borderRadius: 2,
                        boxShadow: '0 0 4px rgba(0,0,0,.5)',
                      });
                      return <><div style={line(true)} /><div style={line(false)} /></>;
                    })()}
                    {/* ★測った範囲そのものを四角で重ねる。
                        点の印だけだと「どの建物を、どこまで測ったのか」が分からない。
                        間口×桁行を実寸で描けば、別の建物を測っていないか・隣家まで
                        巻き込んでいないかが一目で分かる。 */}
                    {aerialRect && (() => {
                      const a = aerialRectArea();
                      const R = aerialRect;
                      const pc = (v: number) => `${v / aerial.sizePx * 100}%`;
                      const handle = (which: string, cx: string, cy: string, cur: string) => (
                        <div key={which} onMouseDown={(e) => startAerialDrag(e, which)}
                          style={{
                            position: 'absolute', left: cx, top: cy, width: 16, height: 16,
                            marginLeft: -8, marginTop: -8, cursor: cur, zIndex: 3,
                            background: '#fff', border: '3px solid #dc2626', borderRadius: 3,
                            boxShadow: '0 1px 3px rgba(0,0,0,.5)',
                          }} />
                      );
                      return (
                        <div style={{
                          position: 'absolute',
                          left: pc(R.cx - R.w / 2), top: pc(R.cy - R.h / 2),
                          width: pc(R.w), height: pc(R.h),
                          transform: `rotate(${R.rot || 0}deg)`, transformOrigin: '50% 50%',
                          border: '3px solid #dc2626',
                          boxShadow: '0 0 0 1px #fff, inset 0 0 0 1px #fff',
                          background: 'rgba(220,38,38,.14)',
                          cursor: 'grab',
                        }}
                          onMouseDown={(e) => startAerialDrag(e, 'move')}>
                          {/* 寸法と面積。四角と一緒に回ると読みにくいので、回転を打ち消す */}
                          <span style={{
                            position: 'absolute', left: '50%', top: -26,
                            transform: `translateX(-50%) rotate(${-(R.rot || 0)}deg)`,
                            background: '#dc2626', color: '#fff', fontSize: 11, fontWeight: 'bold',
                            padding: '2px 7px', borderRadius: 3, whiteSpace: 'nowrap',
                            boxShadow: '0 1px 3px rgba(0,0,0,.4)', pointerEvents: 'none',
                          }}>
                            {a ? `${a.wM.toFixed(1)}×${a.hM.toFixed(1)}m` : ''}
                            {a && a.dev !== 1 ? ` ×${a.dev} → ${a.area.toFixed(1)}㎡` : a ? ` → ${a.area.toFixed(1)}㎡` : ''}
                            {!!R.rot && ` / ${Math.round(((R.rot % 360) + 360) % 360)}°`}
                          </span>
                          {/* 中心のつまみ。ここを持てば、角の伸縮と混ざらずに動かせる */}
                          <div onMouseDown={(e) => startAerialDrag(e, 'move')}
                            style={{
                              position: 'absolute', left: '50%', top: '50%', width: 20, height: 20,
                              marginLeft: -10, marginTop: -10, cursor: 'move', zIndex: 3,
                              borderRadius: '50%', background: 'rgba(255,255,255,.9)',
                              border: '3px solid #dc2626', boxShadow: '0 1px 3px rgba(0,0,0,.5)',
                            }}>
                            <div style={{
                              position: 'absolute', left: '50%', top: '50%', width: 4, height: 4,
                              marginLeft: -2, marginTop: -2, background: '#dc2626', borderRadius: '50%',
                            }} />
                          </div>
                          {/* 回転のつまみ。上に飛び出させる */}
                          <div onMouseDown={(e) => startAerialDrag(e, 'rot')}
                            style={{
                              position: 'absolute', left: '50%', top: -34, width: 20, height: 20,
                              marginLeft: -10, cursor: 'crosshair', zIndex: 3,
                              borderRadius: '50%', background: '#2563eb',
                              border: '3px solid #fff', boxShadow: '0 1px 4px rgba(0,0,0,.6)',
                            }} title="ドラッグで回転（Shiftを押しながらで15度ずつ）" />
                          <div style={{
                            position: 'absolute', left: '50%', top: -24, width: 2, height: 24,
                            marginLeft: -1, background: '#2563eb', pointerEvents: 'none',
                            boxShadow: '0 0 0 1px rgba(255,255,255,.7)',
                          }} />
                          {handle('nw', '0%', '0%', 'nwse-resize')}
                          {handle('ne', '100%', '0%', 'nesw-resize')}
                          {handle('sw', '0%', '100%', 'nesw-resize')}
                          {handle('se', '100%', '100%', 'nwse-resize')}
                        </div>
                      );
                    })()}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 14, fontSize: 11, color: '#475569', marginBottom: 6 }}>
                    {aerial.step === 'pick' && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ display: 'inline-block', width: 14, height: 4, background: '#2563eb', border: '1px solid #fff', boxShadow: '0 0 2px rgba(0,0,0,.4)' }} />
                        住所の位置（ずれていて構いません）
                      </span>
                    )}
                    {aerial.step === 'result' && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: '50%', border: '3px solid #dc2626', boxShadow: '0 0 0 1px #fff' }} />
                        測った建物（写真の中心に据えてあります）
                      </span>
                    )}
                  </div>
                </>
              )}
              {aerialRect && (
                <div style={{ fontSize: 12, color: '#166534', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 4, padding: '7px 9px', marginBottom: 6, lineHeight: 1.7 }}>
                  <strong>赤い四角を、建物の輪郭に合わせてください。</strong><br />
                  中をドラッグすると動きます。<strong>四隅の白い四角</strong>をつまむと大きさを変えられます。
                  合わせた四角の面積がそのまま使えます（縮尺は確定しているので、合わせた分だけ正確になります）。<br />
                  <span style={{ color: '#475569' }}>
                    別の建物へは<strong>ダブルクリック</strong>で何度でも移れます（AIを使わないので無料・無制限）。
                    写真は押しっぱなしで動かせます。
                  </span>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <button className="btn" onClick={() => refetchAerial(aerial.searchGrid || 3)} disabled={aerialLoading}
                  style={{ fontSize: 12, padding: '6px 12px' }}>
                  ← 広い範囲に戻す
                </button>
                {/* AIの推定は任意。1日の上限を使うので、押したときだけ走らせる */}
                {aerialRect && (
                  <button className="btn" onClick={measureAerialAt} disabled={aerialLoading}
                    style={{ fontSize: 12, padding: '6px 12px' }}
                    title="画面中央の建物の大きさをAIに推定させます。1日の面積確認の回数を1回使います">
                    🤖 中央の建物の大きさをAIに推定させる
                  </button>
                )}
              </div>
              {!aerial.isEstimate && (
                <div style={{ fontSize: 13, color: '#1e3a8a', marginBottom: 4 }}>
                  間口 {aerial.widthM}m × 桁行 {aerial.lengthM}m（{aerial.shape}）
                  {aerial.slopeFactor > 1 && ` × 勾配${aerial.slopeFactor}`}
                  　→ <strong>{aerial.quantityM2}㎡</strong>
                  {!!aerial.rangeMinM2 && (
                    <span style={{ color: '#475569' }}>　（{aerial.rangeMinM2}〜{aerial.rangeMaxM2}㎡）</span>
                  )}
                </div>
              )}
              {!!aerial.rangeBasis && (
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>幅の根拠: {aerial.rangeBasis}</div>
              )}
              {/* 小さい建物は画素数が足りない。細かい数字が出ると精密に見えるので、限界を明示する */}
              {!!aerial.resolutionNote && (
                <div style={{ fontSize: 12, color: '#78350f', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 4, padding: '6px 8px', margin: '6px 0', lineHeight: 1.7 }}>
                  {aerial.resolutionNote}
                </div>
              )}
              {!!aerial.pixelReading && <div style={{ fontSize: 12, color: '#475569' }}>換算: {aerial.pixelReading}</div>}
              {!!aerial.basis && <div style={{ fontSize: 12, color: '#475569' }}>根拠: {aerial.basis}</div>}
              {!!aerial.needsDimension && (
                <div style={{ fontSize: 12, color: '#78350f', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 4, padding: '6px 8px', marginTop: 6 }}>
                  <strong>{aerial.needsDimension}</strong> が分かれば正確に計算できます。
                </div>
              )}
              {/* 測れたら、そのまま見積へ。
                  航空写真は縮尺が確定しているので、写真の目測と違い実測値と同じ扱いにしてよい。
                  面積は編集できるようにしておく（勾配や下屋の有無で調整したいことがある）。 */}
              {aerialRect && (
                <div style={{ borderTop: '1px solid #93c5fd', marginTop: 10, paddingTop: 10 }}>
                  {(() => {
                    const a = aerialRectArea();
                    if (!a) return null;
                    const sug = aerial.developSuggest;
                    return (
                      <div style={{ marginBottom: 8 }}>
                        {/* 航空写真からの屋根種別。1px≈0.5mでは山ピッチまで見えないので、あくまで候補 */}
                        {aerial.roofType && aerial.roofType !== '不明' && (
                          <div style={{ fontSize: 12, color: '#78350f', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 4, padding: '6px 9px', marginBottom: 6, lineHeight: 1.7 }}>
                            航空写真からの見立て: <strong>{aerial.roofType}</strong>
                            {sug && <>（{sug.label} … 展開係数 <strong>×{sug.factor}</strong>）</>}
                            {aerial.roofTypeReason && <div style={{ color: '#92400e' }}>根拠: {aerial.roofTypeReason}</div>}
                            {sug?.note && <div style={{ color: '#b45309' }}>※ {sug.note}</div>}
                            {a.devFrom === 'ai' && (
                              <div style={{ marginTop: 3 }}>
                                上の「🏠 屋根種別」でお客様に確認した種別を選ぶと、そちらが優先されます。
                              </div>
                            )}
                          </div>
                        )}
                        {/* 水平投影 → 屋根面積 → 施工数量。遮熱シートはここが本体 */}
                        <div style={{ fontSize: 13, color: '#1e3a8a', lineHeight: 1.9 }}>
                          <div>水平投影: <strong>{a.wM.toFixed(1)}m × {a.hM.toFixed(1)}m = {a.plan.toFixed(1)}㎡</strong></div>
                          {a.slope !== 1 && <div>× 勾配補正 {a.slope} → 屋根面積 <strong>{a.roof.toFixed(1)}㎡</strong></div>}
                          {a.dev !== 1 && (
                            <div style={{ color: '#b91c1c' }}>
                              × 展開係数 <strong>{a.dev}</strong>
                              <span style={{ fontSize: 11 }}>（{a.devFrom === 'user' ? 'お客様確認済み' : '写真からの見立て'}／山谷に沿って張るぶん）</span>
                              → <strong>{a.area.toFixed(1)}㎡</strong>
                            </div>
                          )}
                          <div style={{ marginTop: 4 }}>
                            見積に使う数量: <strong style={{ fontSize: 18 }}>{a.area.toFixed(1)}㎡</strong>
                            <button className="btn" onClick={() => setConfirmArea(String(Math.round(a.area * 10) / 10))}
                              style={{ fontSize: 11, padding: '3px 10px', marginLeft: 10 }}>
                              この値を使う
                            </button>
                          </div>
                        </div>
                        {a.dev === 1 && aerial.roofType === '折板' && (
                          <div style={{ fontSize: 12, color: '#7f1d1d', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 4, padding: '6px 9px', marginTop: 6 }}>
                            ⚠ 折板と見立てていますが、展開係数が掛かっていません。遮熱シートやカバー工法など
                            <strong>材料が山谷に沿う工事では、このままだと4割ほど足りません。</strong>
                            上の「🏠 屋根種別」で選んでください。
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, color: '#1e3a8a' }}>この面積で見積もる:</span>
                    <input
                      type="number"
                      value={confirmArea}
                      onChange={(e) => setConfirmArea(e.target.value)}
                      style={{ width: 100, padding: '7px 9px', fontSize: 14, border: '1px solid #93c5fd', borderRadius: 4, textAlign: 'right' }}
                    />
                    <span style={{ fontSize: 13, color: '#1e3a8a' }}>㎡</span>
                    <button className="btn btn-primary" disabled={analyzing || !(Number(confirmArea) > 0)}
                      onClick={() => {
                        const m2 = Number(confirmArea);
                        if (!(m2 > 0)) return;
                        // 航空写真は縮尺が確定しているので、実測値と同じ「確定値」として渡す
                        setArea(`屋根 ${m2}㎡`);
                        analyze(`屋根 ${m2}㎡`);
                      }}
                      style={{ fontSize: 14, padding: '8px 20px' }}>
                      🤖 この面積で見積もる
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: '#475569', marginTop: 5, lineHeight: 1.7 }}>
                    勾配や下屋の分を足し引きしたいときは、数字を直してから押してください。<br />
                    {/* 実測: 同じ場所を3回測ると131.8/161.7/194.7㎡（1.48倍）動いた。
                        写真の目測(3.7倍)よりは良いが、実測値の代わりにはならない。 */}
                    <span style={{ color: '#b45309' }}>
                      航空写真は縮尺が確定しているので写真の目測より確かですが、屋根の境目の読み方で
                      <strong>2〜3割動くことがあります</strong>。金額が大きい案件では、間口と桁行を実測して直してください。
                    </span>
                  </div>
                </div>
              )}
              {/* 地理院タイルは出典の明示が利用規約で求められている */}
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 8 }}>出典: {aerial.attribution}</div>
            </div>
          )}

          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
            <button className="btn btn-primary" onClick={startEstimate} disabled={analyzing || checkingArea || !canAnalyze} style={{ fontSize: 16, padding: '12px 32px' }}>
              {analyzing ? '🔄 AI が解析中...' : checkingArea ? '📐 面積を読み取り中...' : '🤖 AI で見積もりを解析'}
            </button>
            {/* 押す前に待ち時間を先出しする */}
            {!analyzing && !checkingArea && (
              <span style={{ fontSize: 13, color: '#666', background: '#f1f5f9', padding: '6px 12px', borderRadius: 999, whiteSpace: 'nowrap' }}>
                ⏱ {etaText('ai-estimate', fastMode ? Math.round(ESTIMATE_SEC * 0.7) : ESTIMATE_SEC)}
              </span>
            )}
            {/* ⚡スピード優先。AIに書かせる文章量を減らして待ち時間を縮める。金額の精度は変えない。 */}
            <label
              title="お客様向けの「工事の所要時間・生活への影響」と松竹梅プランを省きます。金額・内訳・人工の計算は変わりません。"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer',
                color: fastMode ? '#b45309' : '#64748b', background: fastMode ? '#fef3c7' : '#f8fafc',
                border: `1px solid ${fastMode ? '#fcd34d' : '#e2e8f0'}`, borderRadius: 999, padding: '6px 12px', whiteSpace: 'nowrap',
              }}
            >
              <input type="checkbox" checked={fastMode} onChange={e => setFastMode(e.target.checked)} style={{ margin: 0 }} />
              ⚡ スピード優先（約3割はやい）
            </label>
            <span style={{ fontSize: 12, color: '#888' }}>
              {mode === 'beforeafter' ? 'ビフォーアフター写真から工事内容を判定します' :
               imageData ? '画像 + コメントからAIが見積もりを自動作成します' : 'コメントだけでもAI見積もりできます（画像は任意）'}
            </span>
          </div>
        </div>
      )}

      {/* エラー表示 */}
      {error && (
        <div style={{ background: '#fdecea', color: '#c0392b', padding: '12px 16px', borderRadius: 8, marginTop: 16 }}>
          {error}
        </div>
      )}

      {/* 解析中 */}
      {analyzing && (
        <div ref={resultRef} className="card" style={{ textAlign: 'center', padding: 40 }}>
          {/* 回転する¥マーク */}
          <div style={{ fontSize: 56, marginBottom: 16, display: 'inline-block', animation: 'spin 1.5s linear infinite' }}>¥</div>
          <style>{`@keyframes spin { 0% { transform: rotateY(0deg); } 100% { transform: rotateY(360deg); } }`}</style>
          <div style={{ fontSize: 18, fontWeight: 'bold', color: '#1a2332', marginBottom: 8 }}>AI が見積もりを算出中...</div>
          <div style={{ fontSize: 14, color: '#666', marginBottom: 12 }}>
            {analyzeStep(elapsed)}
          </div>
          {/* プログレスバー（目安60秒） */}
          <div style={{ width: 300, height: 6, background: '#eee', borderRadius: 3, margin: '0 auto 12px', overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: 3,
              background: 'linear-gradient(90deg, #3a7bd5, #27ae60)',
              width: `${Math.min(95, elapsed / 60 * 95)}%`,
              transition: 'width 1s ease',
            }} />
          </div>
          <div style={{ fontSize: 24, fontWeight: 'bold', color: '#3a7bd5' }}>
            {elapsed}秒
            <span style={{ fontSize: 13, fontWeight: 'normal', color: '#aaa', marginLeft: 8 }}>
              / 目安 {elapsed < 45 ? '約60秒' : elapsed < 60 ? '残り約' + (60 - elapsed) + '秒' : 'もうすぐ完了します…'}
            </span>
          </div>
        </div>
      )}

      {/* 解析結果 */}
      {result && (
        <div ref={resultRef} style={{ marginTop: 16 }}>

          {/* 自動登録完了バナー */}
          {autoCreated && (
            <div style={{
              background: 'linear-gradient(135deg, #27ae60, #2ecc71)', color: '#fff',
              padding: '14px 20px', borderRadius: 10, marginBottom: 16,
              boxShadow: '0 3px 12px rgba(39,174,96,0.3)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <strong>✅ 自動登録完了!</strong>
                  <span style={{ marginLeft: 12, fontSize: 13, opacity: 0.9 }}>
                    物件・施工・材料明細・請求書・発注書（下書き）をまとめて作成しました
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ fontSize: 12, background: 'rgba(255,255,255,0.2)', padding: '4px 12px', borderRadius: 6, cursor: 'pointer' }}
                    onClick={() => onNavigateToConstruction && autoCreated.constructionId && onNavigateToConstruction(autoCreated.constructionId)}>
                    👉 見積詳細を見る
                  </div>
                  <div style={{ fontSize: 12, background: 'rgba(255,255,255,0.35)', padding: '4px 12px', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold' }}
                    onClick={() => {
                      if (onNavigateToConstruction && autoCreated.constructionId) {
                        // purchase-ordersページへの遷移は親から制御
                      }
                      alert('発注書ページで業者名・納期を記入してPDF出力できます。');
                    }}>
                    📝 発注書を確認
                  </div>
                </div>
              </div>
            </div>
          )}

          {creating && (
            <div style={{ background: '#fff8e1', padding: '10px 16px', borderRadius: 8, marginBottom: 16, fontSize: 13, color: '#e67e22' }}>
              ⏳ 物件・施工・請求書を自動登録中...
            </div>
          )}

          {/* ヘッダー */}
          <div className="card" style={{ background: 'linear-gradient(135deg, #1a2332, #2c3e50)', color: '#fff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 4 }}>AI 判定</div>
                <div
                  style={{ fontSize: 24, fontWeight: 'bold', cursor: autoCreated ? 'pointer' : 'default', textDecoration: autoCreated ? 'underline' : 'none' }}
                  onClick={() => autoCreated && onNavigateToConstruction && onNavigateToConstruction(autoCreated.constructionId)}
                >{result.workType}</div>
                <div style={{ fontSize: 14, marginTop: 8, opacity: 0.9 }}>{result.description}</div>
                <div style={{ fontSize: 13, marginTop: 4, opacity: 0.7 }}>推定規模: {result.estimatedScale}</div>
                {(result.estimatedDuration || result.totalManDays) && (
                  <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
                    {result.estimatedDuration && (
                      <span style={{ background: '#e8f0fe', color: '#1a73e8', padding: '3px 10px', borderRadius: 12, fontSize: 12, fontWeight: 'bold' }}>
                        工期: {result.estimatedDuration}
                      </span>
                    )}
                    {result.totalManDays && (
                      <span style={{ background: '#fef3e0', color: '#e67e22', padding: '3px 10px', borderRadius: 12, fontSize: 12, fontWeight: 'bold' }}>
                        総工数: {result.totalManDays}人工
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div style={{ textAlign: 'right' }}>
                <span style={{
                  background: confidenceColor[result.confidence] || '#888',
                  padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 'bold',
                }}>
                  信頼度: {result.confidence}
                </span>
                {result.similarWork && (
                  <div style={{ fontSize: 12, marginTop: 8, opacity: 0.8 }}>
                    類似実績: {result.similarWork}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* お客様に伝える「工事のお時間」。金額の次に必ず聞かれるので金額内訳より前に出す */}
          <CustomerSchedule schedule={result.customerSchedule} workType={result.workType} duration={result.estimatedDuration} />

          {/* AIが前提にした面積 → その場で直して再計算（全自動が基本、気になる時だけ1箇所直す） */}
          {result.assumedArea && (
            <div className="card" style={{ marginTop: 12, background: '#fffbea', border: '1px solid #f0d98a', padding: '12px 16px' }}>
              <div style={{ fontSize: 13, fontWeight: 'bold', color: '#8a6d00', marginBottom: 6 }}>
                📐 AIが前提にした面積・数量{result.confidence === '低' ? '（写真からの推定です。実測と違えば直して再計算してください）' : ''}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  value={reArea}
                  onChange={e => setReArea(e.target.value)}
                  placeholder="例: 屋根 450㎡"
                  style={{ flex: '1 1 220px', minWidth: 180, padding: '8px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, fontFamily: 'inherit' }}
                />
                <button className="btn btn-primary" disabled={analyzing || !reArea.trim()} onClick={() => analyze(reArea)} style={{ whiteSpace: 'nowrap' }}>
                  {analyzing ? '🔄 再計算中...' : '🔄 この面積で再計算'}
                </button>
              </div>
              <div style={{ fontSize: 11, color: '#999', marginTop: 6 }}>実測値を入れて再計算すると、信頼度が上がり金額が正確になります。合っていればそのままでOKです。</div>
            </div>
          )}

          {/* 前回とまったく同じ依頼だったので、計算し直さず同じ金額を出した */}
          {result.reusedFrom && (
            <div className="card" style={{ marginTop: 16, background: '#eef6ff', border: '2px solid #3a7bd5' }}>
              <h3 style={{ margin: '0 0 6px', color: '#1a4f8a', fontSize: 16 }}>📌 前回と同じ工事です</h3>
              <div style={{ fontSize: 13.5, lineHeight: 1.8 }}>
                入力がまったく同じだったため、<b>{result.reusedFrom.date} に出した見積</b>と<b>同じ金額</b>で表示しています。
                計算し直していないので<b>AIストックは消費していません</b>。
                {result.reusedFrom.edited && (
                  <div style={{ marginTop: 6, background: '#fff7e6', border: '1px solid #f0c14b', borderRadius: 6, padding: '7px 11px' }}>
                    ✏️ この見積は<b>{result.reusedFrom.editedDate} に金額を手直し</b>されています。
                    <b>AIの原案ではなく、直したあとの金額</b>を出しています。
                  </div>
                )}
                <div style={{ color: '#666', marginTop: 4 }}>
                  ※ 同じ工事なら同じ金額になるようにしています。単価や仕様を変えたい場合は、条件を書き換えるか下のボタンで出し直してください。
                </div>
              </div>
              <button
                className="btn btn-secondary btn-sm"
                style={{ marginTop: 10 }}
                onClick={() => analyze(undefined, { forceFresh: true })}
              >🔄 新しく見積もり直す（ストックを1〜2消費）</button>
            </div>
          )}

          {/* お見積金額（編集可能） */}
          <div style={{ marginTop: 16 }}>
            <div className="card" style={{ background: '#f0fff4', border: '3px solid #27ae60', padding: '20px 24px' }}>
              <div style={{ textAlign: 'center', marginBottom: 16 }}>
                {result.usedIndustryType && (
                  <div style={{ fontSize: 11.5, color: '#7a8697', marginBottom: 6 }}>
                    この見積は「<b style={{ color: '#4a5666' }}>
                      {(INDUSTRIES.find(o => o.v === result.usedIndustryType) || { label: result.usedIndustryType }).label}
                    </b>」として計算しています（変更は設定から）
                  </div>
                )}
                <div style={{ fontSize: 14, color: '#888', marginBottom: 4 }}>お見積金額（税抜・利益込）</div>
                <div style={{ fontSize: 36, fontWeight: 'bold', color: '#27ae60' }}>{fmt(result.estimatedTotal)}</div>
                {/* 消費税10%。端数は円未満切り捨て（請求書の慣行に合わせる） */}
                <div style={{ fontSize: 15, color: '#15803d', marginTop: 4 }}>
                  税込 <strong style={{ fontSize: 20 }}>{fmt(Math.floor((Number(result.estimatedTotal) || 0) * (1 + TAX_RATE)))}</strong>
                  <span style={{ fontSize: 12, color: '#888', marginLeft: 8 }}>
                    （消費税 {fmt(Math.floor((Number(result.estimatedTotal) || 0) * TAX_RATE))}）
                  </span>
                </div>
              </div>
              {/* 材料費 + 人件費 + 経費 + 粗利 = 売上金額。原価を編集すると粗利が自動で追従する */}
              {(() => {
                const mat = Number(result.estimatedMaterialCost) || 0;
                const labor = Number(result.estimatedLaborCost) || 0;
                const exp = Number(result.estimatedExpenseCost) || 0;
                const total = Number(result.estimatedTotal) || 0;
                const profit = total - (mat + labor + exp);
                const rate = total > 0 ? Math.round((profit / total) * 1000) / 10 : 0;
                const tile = { background: '#fff', borderRadius: 8, padding: 10, border: '1px solid #bbf7d0' };
                const num = { width: '100%', padding: 6, fontSize: 15, fontWeight: 'bold', border: '1px solid #d1d5db', borderRadius: 6, textAlign: 'right' as const };
                // ★遮熱シート(山下さん)は材工共に人件費が込み。人件費タイルは出さず2タイル（材工共・経費）にする。
                //   生成直後は main の isHeatshield フラグ、過去ログ再表示時は workType からフォールバック判定。
                const isHs = !!result.isHeatshield || /遮熱|特許/.test(String(result.workType || ''));
                return (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: isHs ? '1fr 1fr' : '1fr 1fr 1fr', gap: 10 }}>
                      <div style={tile}>
                        <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>{isHs ? '材工共（原価・人件費込み）' : '材料費（原価）'}</div>
                        <NumInput value={mat} onValue={n => editCost('estimatedMaterialCost', n)} style={num} />
                      </div>
                      {!isHs && (
                        <div style={tile}>
                          <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>人件費（原価）</div>
                          <NumInput value={labor} onValue={n => editCost('estimatedLaborCost', n)} style={num} />
                        </div>
                      )}
                      <div style={tile}>
                        <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>経費（仮設・現場管理・福利厚生）</div>
                        <NumInput value={exp} onValue={n => editCost('estimatedExpenseCost', n)} style={num} />
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
                      <div style={{ ...tile, background: profit < 0 ? '#fef2f2' : '#f0fdf4', border: `1px solid ${profit < 0 ? '#fecaca' : '#86efac'}` }}>
                        <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>粗利（{rate}%）</div>
                        <div style={{ padding: 6, fontSize: 15, fontWeight: 'bold', textAlign: 'right', color: profit < 0 ? '#dc2626' : '#15803d' }}>
                          {fmt(profit)}
                        </div>
                      </div>
                      <div style={tile}>
                        <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>売上金額（税抜）</div>
                        <NumInput value={total} onValue={n => setResult({ ...result, estimatedTotal: n })} style={num} />
                        <div style={{ fontSize: 11, color: '#64748b', marginTop: 4, textAlign: 'right' }}>
                          税込 {fmt(Math.floor(total * (1 + TAX_RATE)))}
                        </div>
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: profit < 0 ? '#dc2626' : '#64748b', marginTop: 8, textAlign: 'center' }}>
                      {isHs
                        ? <>材工共 {fmt(mat)} ＋ 経費 {fmt(exp)} ＋ 粗利 {fmt(profit)} ＝ 売上金額 {fmt(total)}（税込 {fmt(Math.floor(total * (1 + TAX_RATE)))}）</>
                        : <>材料費 {fmt(mat)} ＋ 人件費 {fmt(labor)} ＋ 経費 {fmt(exp)} ＋ 粗利 {fmt(profit)} ＝ 売上金額 {fmt(total)}（税込 {fmt(Math.floor(total * (1 + TAX_RATE)))}）</>}
                      {profit < 0 && '　※原価が売上を超えています。金額を見直してください'}
                    </div>
                  </>
                );
              })()}
              {/* 原価を直したときの「いま何円か」の内訳。掛率を保って売価が追従したことを見せる */}
              {baseMarkup > 0 && baseline && (
                (() => {
                  const baseLabor = Number(baseline.estimatedLaborCost) || 0;
                  const nowLabor = Number(result.estimatedLaborCost) || 0;
                  const baseTotal = Number(baseline.estimatedTotal) || 0;
                  const nowTotal = Number(result.estimatedTotal) || 0;
                  const diffLabor = nowLabor - baseLabor;
                  const diffTotal = nowTotal - baseTotal;
                  if (Math.abs(diffLabor) < 1 && Math.abs(diffTotal) < 1) return null;
                  return (
                    <div style={{
                      marginTop: 10, background: '#fffbeb', border: '1px solid #fde68a',
                      borderRadius: 8, padding: '8px 12px', fontSize: 12, color: '#92400e', lineHeight: 1.8,
                    }}>
                      <strong>AIの原案から修正されています</strong>
                      {Math.abs(diffLabor) >= 1 && (
                        <div>
                          人件費（原価）: {fmt(baseLabor)} → <strong>{fmt(nowLabor)}</strong>
                          <span style={{ color: diffLabor > 0 ? '#b91c1c' : '#15803d', marginLeft: 6 }}>
                            （{diffLabor > 0 ? '+' : ''}{fmt(diffLabor)}）
                          </span>
                        </div>
                      )}
                      <div>
                        売上金額: {fmt(baseTotal)} → <strong>{fmt(nowTotal)}</strong>
                        <span style={{ color: diffTotal > 0 ? '#b91c1c' : '#15803d', marginLeft: 6 }}>
                          （{diffTotal > 0 ? '+' : ''}{fmt(diffTotal)}）
                        </span>
                        <span style={{ color: '#a16207', marginLeft: 8 }}>
                          掛率 ×{Math.round(baseMarkup * 100) / 100} を保って引き直しました（粗利率は維持）
                        </span>
                      </div>
                    </div>
                  );
                })()
              )}
              {costEdited && (
                <div style={{ marginTop: 8, fontSize: 11, color: '#0369a1', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 6, padding: '6px 10px' }}>
                  💾 保存済みの修正があります（{costEdited.edited_at}）。請求書・明細もこの金額になっています。
                </div>
              )}
              {autoCreated && (
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button
                    className="btn btn-primary btn-sm"
                    style={{ flex: 1 }}
                    disabled={savingCost}
                    onClick={saveCostEdit}
                  >
                    {savingCost ? '保存中...' : '💾 修正を上書き保存（請求書・AI学習に反映）'}
                  </button>
                  <button
                    className="btn btn-sm"
                    style={{ whiteSpace: 'nowrap' }}
                    disabled={savingCost}
                    title="AIが最初に出した金額に戻します（請求書も戻ります）"
                    onClick={revertCostEdit}
                  >
                    ↩ 元に戻す
                  </button>
                </div>
              )}
              <div style={{ fontSize: 11, color: '#888', marginTop: 6, textAlign: 'center' }}>
                {autoCreated
                  ? '人件費など原価を直して保存すると、明細・請求書の金額まで一括で合わせ、AIの学習にも反映します。'
                  : '金額を修正するとAIの学習精度が向上します（一括登録後に保存できます）'}
              </div>
            </div>
          </div>

          {/* 内訳 */}
          {result.breakdown && result.breakdown.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                <h3 style={{ margin: 0 }}>費用内訳（数量・単価つき）</h3>
                <span style={{ fontSize: 11, color: '#888' }}>数量・単価・金額はどれも直接直せます（残りが自動で引き直されます）</span>
              </div>
              {Object.keys(takeoffByName).length > 0 && (
                <div style={{ fontSize: 11, color: '#2e7d32', background: '#eaf6ee', border: '1px solid #cfe6d6', borderRadius: 6, padding: '6px 10px', marginBottom: 8 }}>
                  📐 のついた行は<strong>図面から拾った数量</strong>です。クリックすると計算式・寸法・出典（どの図面のどこか）が開きます。
                </div>
              )}
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ minWidth: 180 }}>項目</th>
                      <th style={{ width: 64 }}>区分</th>
                      <th style={{ width: 92, textAlign: 'right' }}>数量</th>
                      <th style={{ width: 46 }}>単位</th>
                      <th style={{ width: 110, textAlign: 'right' }}>単価</th>
                      <th style={{ width: 130, textAlign: 'right' }}>金額</th>
                      <th style={{ minWidth: 260 }}>備考（単価の内訳・根拠）</th>
                      <th style={{ textAlign: 'center', width: 70 }}>発注書</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.breakdown.map((b: any, i: number) => {
                      const src = b.takeoffRef ? takeoffByName[String(b.takeoffRef).trim()] : null;
                      // 数量が無い行（AIが出し忘れ／古い見積ログ）は「1式」として扱う。
                      // 0のまま表示すると「数量0・単価0」に見えてしまう。
                      const qty = Number(b.quantity) > 0 ? Number(b.quantity) : 1;
                      const unitPrice = Number(b.unitPrice) > 0 ? Number(b.unitPrice) : Math.round((Number(b.cost) || 0) / qty);
                      return (
                        <React.Fragment key={i}>
                          <tr>
                            <td>
                              {b.item}
                              {src && (
                                <button
                                  type="button"
                                  onClick={() => setOpenBasis(openBasis === i ? null : i)}
                                  title="この数量を図面のどこから拾ったか見る"
                                  style={{
                                    marginLeft: 6, border: '1px solid #cfe6d6', background: '#eaf6ee', color: '#2e7d32',
                                    borderRadius: 10, fontSize: 10, padding: '1px 7px', cursor: 'pointer', fontWeight: 'bold',
                                  }}
                                >📐 図面 {openBasis === i ? '▲' : '▼'}</button>
                              )}
                            </td>
                            <td style={{ fontSize: 11, color: '#78909c' }}>{b.category || '—'}</td>
                            <td style={{ textAlign: 'right' }}>
                              <NumInput
                                value={qty}
                                onValue={n => updateBreakdownRow(i, 'quantity', n)}
                                style={{ width: 80, padding: '5px 6px', textAlign: 'right', border: '1px solid #ddd', borderRadius: 6, fontSize: 13, fontFamily: 'inherit' }}
                              />
                            </td>
                            <td style={{ fontSize: 12, color: '#607d8b' }}>{b.unit || '式'}</td>
                            <td style={{ textAlign: 'right' }}>
                              <NumInput
                                value={unitPrice}
                                onValue={n => updateBreakdownRow(i, 'unitPrice', n)}
                                style={{ width: 100, padding: '5px 6px', textAlign: 'right', border: '1px solid #ddd', borderRadius: 6, fontSize: 13, fontFamily: 'inherit' }}
                              />
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <NumInput
                                value={b.cost || 0}
                                onValue={n => updateBreakdownRow(i, 'cost', n)}
                                style={{
                                  width: 120, padding: '6px 8px', textAlign: 'right', fontWeight: 'bold',
                                  border: '1px solid #ddd', borderRadius: 6, fontSize: 14, fontFamily: 'inherit',
                                }}
                              />
                            </td>
                            {/* 備考は「コンクリート 4,500円/㎡（…）」のように単価を割った複数行になる。
                                改行を潰すと1行に繋がって読めないので pre-wrap でそのまま出す。 */}
                            <td style={{ color: '#666', fontSize: 11.5, whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{b.note}</td>
                            <td style={{ textAlign: 'center' }}>
                              <button
                                type="button"
                                title="この項目で発注書PDFを出力"
                                onClick={async () => {
                                  const today = new Date().toISOString().split('T')[0];
                                  const po = {
                                    id: 0,
                                    vendor_name: '',
                                    vendor_address: '',
                                    issue_date: today,
                                    delivery_date: '',
                                    tax_rate: 0.1,
                                    notes: '',
                                    construction_title: result.workType || '',
                                  };
                                  // 数量・単位・単価が拾えている行は、その粒度のまま発注書に落とす
                                  const items = [{
                                    name: b.item,
                                    quantity: qty > 0 ? qty : 1,
                                    unit: b.unit || '式',
                                    unit_price: qty > 0 ? unitPrice : (b.cost || 0),
                                  }];
                                  try {
                                    await (window as any).api.generatePurchaseOrderPDF({ po, items });
                                  } catch (e: any) {
                                    alert('PDF生成に失敗: ' + (e.message || e));
                                  }
                                }}
                                style={{
                                  fontSize: 11, color: '#3498db', fontWeight: 'bold', cursor: 'pointer',
                                  background: 'none', border: 'none', padding: '4px 6px',
                                }}
                              >📄 出力</button>
                            </td>
                          </tr>
                          {src && openBasis === i && (
                            <tr>
                              <td colSpan={8} style={{ background: '#f6fbf7', borderLeft: '3px solid #66bb6a' }}>
                                <div style={{ fontSize: 12, color: '#37474f', lineHeight: 1.9, padding: '4px 2px' }}>
                                  <div><strong>拾い出し根拠</strong>（{src.part || '—'} ／ {src.method || '—'}）</div>
                                  <div>計算式: <span style={{ fontFamily: 'monospace', color: '#2e7d32' }}>{src.formula || '—'}</span></div>
                                  {src.dimensions && <div>使った寸法: {src.dimensions}</div>}
                                  {src.deduction && <div>控除: {src.deduction}</div>}
                                  {Number(src.lossRate) > 0 && <div>ロス: {Math.round(Number(src.lossRate) * 100)}%（発注数量 {src.quantityWithLoss}{src.unit || ''}）</div>}
                                  <div>出典: {src.source || '—'}
                                    {takeoffSource?.scale && <span style={{ color: '#78909c' }}>（縮尺 {takeoffSource.scale}）</span>}
                                  </div>
                                  {src.assumption && <div style={{ color: '#ef6c00' }}>仮定: {src.assumption}</div>}
                                  <div>確度: <strong style={{ color: src.confidence === '高' ? '#2e7d32' : src.confidence === '中' ? '#ef6c00' : '#c62828' }}>{src.confidence || '—'}</strong></div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                    <tr style={{ background: '#f8f9fa' }}>
                      <td style={{ fontWeight: 'bold' }} colSpan={5}>合計（内訳の総和）</td>
                      <td style={{ textAlign: 'right', fontWeight: 'bold', paddingRight: 8 }}>
                        {fmt(result.breakdown.reduce((s: number, r: any) => s + (Number(r.cost) || 0), 0))}
                      </td>
                      <td colSpan={2} style={{ color: '#888', fontSize: 11 }}>
                        上の「合計」欄と連動します
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {(takeoffSource?.items || []).length > 0 && (
                <div style={{ marginTop: 10, textAlign: 'right' }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    type="button"
                    onClick={async () => {
                      try {
                        await (window as any).api.generateTakeoffPDF({
                          takeoff: takeoffSource,
                          title: result.workType || takeoffSource.title || '',
                          clientName,
                        });
                      } catch (e: any) { alert('PDF生成に失敗: ' + (e.message || e)); }
                    }}
                  >📐 数量拾い出し明細をPDFで出す（見積書の別紙）</button>
                </div>
              )}
            </div>
          )}

          {/* 松竹梅 — 施主が選べる3グレード提案。竹＝この見積(ベース)、松梅は差分。表示専用で保存見積は竹のまま。 */}
          {Array.isArray(result.gradeOptions) && result.gradeOptions.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <h3 style={{ margin: 0 }}>松竹梅プラン（お客様への提案用）</h3>
                <span style={{ fontSize: 11, color: '#888' }}>竹＝この見積。保存されるのは竹です</span>
              </div>
              <div style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>予算に応じて3案を提示できます。松＝グレードアップ／竹＝標準／梅＝コスト重視。</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                {['松', '竹', '梅'].map(g => {
                  const opt = result.gradeOptions.find((o: any) => o.grade === g);
                  if (!opt) return null;
                  const isBase = g === '竹';
                  const diff = Number(opt.diff) || 0;
                  const accent = g === '松' ? '#c0392b' : g === '竹' ? '#27ae60' : '#2980b9';
                  return (
                    <div key={g} style={{
                      border: `2px solid ${isBase ? accent : '#e5e7eb'}`, borderRadius: 12, padding: 14,
                      background: isBase ? '#f0fbf4' : '#fff', position: 'relative', display: 'flex', flexDirection: 'column'
                    }}>
                      {isBase && (
                        <div style={{ position: 'absolute', top: -10, right: 10, background: accent, color: '#fff', fontSize: 10, fontWeight: 'bold', padding: '2px 8px', borderRadius: 10 }}>この見積</div>
                      )}
                      <div style={{ fontSize: 22, fontWeight: 'bold', color: accent }}>{g}</div>
                      <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>{opt.label}</div>
                      <div style={{ fontSize: 20, fontWeight: 'bold', color: '#222' }}>{fmt(opt.total)}</div>
                      <div style={{ fontSize: 11, color: '#999', marginBottom: 4 }}>
                        税込 {fmt(Math.floor((Number(opt.total) || 0) * (1 + TAX_RATE)))}
                      </div>
                      <div style={{ fontSize: 12, fontWeight: 'bold', color: diff > 0 ? '#c0392b' : diff < 0 ? '#2980b9' : '#888', marginBottom: 8 }}>
                        {diff === 0 ? '基準' : (diff > 0 ? '＋' : '−') + fmt(Math.abs(diff))}
                      </div>
                      <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: '#444', lineHeight: 1.5, flex: 1 }}>
                        {(Array.isArray(opt.spec) ? opt.spec : []).map((s: string, i: number) => <li key={i}>{s}</li>)}
                      </ul>
                      {opt.note && <div style={{ fontSize: 11, color: '#777', marginTop: 8, borderTop: '1px dashed #ddd', paddingTop: 6 }}>{opt.note}</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 人工内訳（遮熱シート=山下さんは材工共に人件費込みのため工数内訳は出さない） */}
          {!result.isHeatshield && result.manDaysBreakdown && result.manDaysBreakdown.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ margin: 0 }}>工数内訳</h3>
                <span style={{ fontSize: 11, color: '#888' }}>人数・日数・日額は直接修正できます（人工と小計は自動計算）</span>
              </div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>職種</th>
                    <th style={{ textAlign: 'center' }}>人数</th>
                    <th style={{ textAlign: 'center' }}>日数</th>
                    <th style={{ textAlign: 'center' }}>人工</th>
                    <th style={{ textAlign: 'right' }}>日額</th>
                    <th style={{ textAlign: 'right' }}>小計</th>
                    <th style={{ textAlign: 'center', width: 80 }}>発注書</th>
                  </tr>
                </thead>
                <tbody>
                  {result.manDaysBreakdown.map((m: any, i: number) => {
                    const tradeName = (m.trade || '').replace(/[（(].*?レベル.*?[）)]/g, '').trim();
                    const subtotal = (Number(m.manDays) || 0) * (Number(m.dailyRate) || 0);
                    // 人数・日数を直すと人工(manDays)を再計算し、合計人工も揃える
                    const patchRow = (patch: any) => {
                      const next = [...result.manDaysBreakdown];
                      const row = { ...next[i], ...patch };
                      if ('workers' in patch || 'days' in patch) {
                        row.manDays = (Number(row.workers) || 0) * (Number(row.days) || 0);
                      }
                      next[i] = row;
                      const totalManDays = next.reduce((s: number, r: any) => s + (Number(r.manDays) || 0), 0);
                      setResult({ ...result, manDaysBreakdown: next, totalManDays });
                    };
                    const numStyle = {
                      width: 70, padding: '5px 6px', textAlign: 'center' as const,
                      border: '1px solid #ddd', borderRadius: 6, fontSize: 13, fontFamily: 'inherit',
                    };
                    return (
                    <tr key={i}>
                      <td>
                        {tradeName}
                        {m.basis && <div style={{ fontSize: 11, color: '#888', fontWeight: 'normal', marginTop: 3, lineHeight: 1.5 }}>根拠: {m.basis}</div>}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <NumInput min={0} value={Number(m.workers) || 0}
                          onValue={n => patchRow({ workers: n })}
                          style={numStyle} />
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <NumInput min={0} value={Number(m.days) || 0}
                          onValue={n => patchRow({ days: n })}
                          style={numStyle} />
                      </td>
                      <td style={{ textAlign: 'center', fontWeight: 'bold' }}>{Number(m.manDays) || 0}</td>
                      <td style={{ textAlign: 'right' }}>
                        <NumInput min={0} value={Number(m.dailyRate) || 0}
                          onValue={n => patchRow({ dailyRate: n })}
                          style={{ ...numStyle, width: 100, textAlign: 'right' }} />
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 'bold' }}>{fmt(subtotal)}</td>
                      <td style={{ textAlign: 'center' }}>
                        <button
                          type="button"
                          title="この職種で発注書PDFを出力"
                          onClick={async () => {
                            const today = new Date().toISOString().split('T')[0];
                            const po = {
                              id: 0,
                              vendor_name: '',
                              vendor_address: '',
                              issue_date: today,
                              delivery_date: '',
                              tax_rate: 0.1,
                              notes: '',
                              construction_title: result.workType || '',
                            };
                            const items = [{ name: `${tradeName} ${m.workers}人×${m.days}日`, quantity: m.manDays, unit: '人工', unit_price: m.dailyRate || 0 }];
                            try {
                              await (window as any).api.generatePurchaseOrderPDF({ po, items });
                            } catch (e: any) {
                              alert('PDF生成に失敗: ' + (e.message || e));
                            }
                          }}
                          style={{
                            fontSize: 11, color: '#3498db', fontWeight: 'bold', cursor: 'pointer',
                            background: 'none', border: 'none', padding: '4px 6px',
                          }}
                        >📄 出力</button>
                      </td>
                    </tr>
                    );
                  })}
                  <tr style={{ borderTop: '2px solid #333', fontWeight: 'bold' }}>
                    <td>合計</td>
                    <td></td>
                    <td></td>
                    <td style={{ textAlign: 'center' }}>
                      {result.manDaysBreakdown.reduce((s: number, m: any) => s + (Number(m.manDays) || 0), 0)}人工
                    </td>
                    <td></td>
                    <td style={{ textAlign: 'right' }}>
                      {fmt(result.manDaysBreakdown.reduce((s: number, m: any) => s + (Number(m.manDays) || 0) * (Number(m.dailyRate) || 0), 0))}
                    </td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
              <div style={{ fontSize: 11, color: '#888', marginTop: 8, lineHeight: 1.6 }}>
                施工費 ＝ 各職種の（人工 × 日額）の合計。各行の「根拠」は 数量 ÷ 歩掛（1人が1日にこなす標準作業量）で日数を算出しています。数字の妥当性はここで検算できます。
              </div>
            </div>
          )}

          {/* 入力したコメント表示 */}
          {comment && (
            <div className="card" style={{ marginTop: 16, background: '#f0f4ff', border: '1px solid #b8d0ff' }}>
              <h3 style={{ marginBottom: 8 }}>📝 入力した工事内容</h3>
              <p style={{ fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{comment}</p>
            </div>
          )}

          {/* 金額・数量の検算に引っかかった行。見逃すと売価がまるごと狂ったまま提出される */}
          {Array.isArray(result.estimateWarnings) && result.estimateWarnings.length > 0 && (
            <div className="card" style={{ marginTop: 16, background: '#fdecea', border: '2px solid #c0392b' }}>
              <h3 style={{ margin: '0 0 8px', color: '#c0392b' }}>⚠ 金額・数量の検算で異常が出ています</h3>
              <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.8 }}>
                {result.estimateWarnings.map((w: string, i: number) => <li key={i}>{w}</li>)}
              </ul>
              {/* 実際に直したときだけ書く。何も直していないのに「自動で下げました」と出て、
                  警告文の「金額は変更していません」と矛盾していた。
                  さらに、粗利ゼロ行の引き上げなど「上げる」自動修正もあるため、
                  方向を決めつけず「直しました」と書く（下げたと言いながら増えていた） */}
              <div style={{ fontSize: 12, color: '#7b241c', marginTop: 8 }}>
                {result.estimateAutoFixed && '検算で見つかった誤りは自動で直しました。'}
                {result.estimateAdvisoryOnly && 'ここに出ている金額はまだ変えていません。勝手に増額せず、下のボタンを押したときだけ直します。'}
                <strong>提出前に必ず内訳の数量と金額を確認してください。</strong>
              </div>
              {/* 各警告の「正しい値」に、人の承認を経て1クリックで直す＋上書き保存する */}
              {Array.isArray(result.estimateFixes) && result.estimateFixes.length > 0 && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed #e0a0a0', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {result.estimateFixes.map((fix: any, i: number) => (
                    <div key={i}>
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={applyingFix}
                        onClick={async () => {
                          if (applyingFix) return;
                          if (!confirm(`${fix.label}\n\nこの内容に変更して保存しますか？`)) return;
                          setApplyingFix(true);
                          try {
                            const fixed = await (window as any).api.applyEstimateFix({ result, fix });
                            if (fixed) {
                              setResult({ ...fixed });
                              if (autoCreated?.constructionId) {
                                // 材料明細 = 補正後 breakdown の1対1対応（listはcm.id順=登録順=breakdown順）。
                                // 補正後の各行 cost をそのまま単価に反映する（数量は1のまま／単価に総額が乗る設計）。
                                // 旧実装は total 比で全行を一律スケールしていたが、それだと applyEstimateFix が
                                // 据え置いた仮設・経費まで膨らみ、画面の内訳と保存値がズレていた。
                                // 掛率・人件費・備考(施工指示)には触らない（updateConstruction を呼ぶと notes が消える）。
                                const mats = await (window as any).api.listConstructionMaterials(autoCreated.constructionId);
                                const bd = Array.isArray(fixed.breakdown) ? fixed.breakdown : [];
                                if (bd.length > 0 && mats.length === bd.length) {
                                  for (let i = 0; i < mats.length; i++) {
                                    const m = mats[i];
                                    const newCost = Math.round(Number(bd[i].cost) || 0);
                                    if (newCost > 0 && newCost !== m.unit_price) {
                                      await (window as any).api.updateConstructionMaterial({
                                        id: m.id, materialId: m.material_id, name: m.material_name,
                                        quantity: m.quantity, unit: m.unit || '式',
                                        unitPrice: newCost,
                                      });
                                    }
                                  }
                                  alert('金額を直して上書き保存しました。AIの学習にも反映されます。');
                                } else {
                                  // 内訳の行数が変わっている（手編集など）→ 一律補正だと壊すので保存は一括登録に委ねる
                                  alert('金額を直しました。内訳の行数が変わっているため、「一括登録」で保存し直してください。');
                                }
                              } else {
                                alert('金額を直しました。一括登録すると保存されます。');
                              }
                            }
                          } catch (e: any) {
                            alert('変更に失敗しました: ' + (e.message || e));
                          }
                          setApplyingFix(false);
                        }}
                      >
                        {applyingFix ? '変更中…' : `✔ こちらに変更する（${fix.label}）`}
                      </button>
                    </div>
                  ))}
                  <div style={{ fontSize: 11, color: '#7b241c' }}>
                    ※押すと該当の費目だけを補正します（仮設・経費は数量に比例しないため変わりません）。金額に直結するので内容を確認のうえどうぞ。
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 葺き師への施工指示（遮熱シート工事のみ・現場用の指令ブロック） */}
          {result.installInstruction && (
            <div className="card" style={{ marginTop: 16, background: '#eef6ff', border: '2px solid #3a7bd5' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
                <h3 style={{ margin: 0 }}>🧰 葺き師への施工指示（現場用）</h3>
                <button
                  className="btn"
                  style={{ fontSize: 12, padding: '4px 12px' }}
                  onClick={() => { try { navigator.clipboard?.writeText(String(result.installInstruction || '')); } catch (_) {} }}
                >📋 コピー</button>
              </div>
              <div style={{ fontSize: 14, lineHeight: 1.8, whiteSpace: 'pre-wrap', background: '#fff', borderRadius: 8, padding: '12px 14px', border: '1px solid #cfe0ef', color: '#1e293b' }}>
                {result.installInstruction}
              </div>
              <div style={{ fontSize: 11, color: '#888', marginTop: 6 }}>そのまま現場の職人へ共有できます（施工案件の備考にも自動で入ります）。</div>
            </div>
          )}

          {/* 希望納期の短縮提案・相談（推定工期より短いときのみAIが返す） */}
          {result.scheduleProposal && (
            <div className="card" style={{ marginTop: 16, background: '#fff4f0', border: '1px solid #e08060' }}>
              <h3 style={{ marginBottom: 8, color: '#c0392b' }}>⏱️ 急ぎ工期の提案・相談</h3>
              <div style={{ fontSize: 11, color: '#a55', marginBottom: 6 }}>推定工期{result.estimatedDuration ? `（${result.estimatedDuration}）` : ''}より短いご希望への提案です。割増費用は本体金額とは別です。</div>
              <p style={{ fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{result.scheduleProposal}</p>
            </div>
          )}

          {/* 提案 */}
          {result.recommendations && (
            <div className="card" style={{ marginTop: 16, background: '#fffbf0', border: '1px solid #f0d060' }}>
              <h3 style={{ marginBottom: 8 }}>💡 提案・注意点</h3>
              <p style={{ fontSize: 14, lineHeight: 1.7 }}>{result.recommendations}</p>
            </div>
          )}

          {/* 研修モード（THINKING）— 次世代への技術継承 */}
          <div ref={trainingRef} className="card" style={{ marginTop: 16, background: '#f3f7fb', border: '2px solid #2e4057' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <h3 style={{ margin: 0, color: '#2e4057' }}>🎓 研修モード（次世代への技術継承）</h3>
              {trainingShown && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button
                    className="btn"
                    style={{ fontSize: 12, padding: '4px 12px' }}
                    onClick={() => { try { navigator.clipboard?.writeText(trainingToText(training)); } catch (_) {} }}
                  >📋 コピー</button>
                  <button
                    className="btn"
                    style={{ fontSize: 12, padding: '4px 12px' }}
                    onClick={async () => {
                      try { await (window as any).api.generateTrainingPDF({ guide: training }); }
                      catch (e: any) { alert('PDFを作れませんでした: ' + String(e?.message || e).replace(/^Error invoking remote method '[^']+': /, '').replace(/^Error: /, '')); }
                    }}
                  >📄 PDFで配る</button>
                </div>
              )}
            </div>

            {!trainingShown && (
              <>
                <p style={{ fontSize: 13, color: '#4a5b6b', lineHeight: 1.8, margin: '8px 0 10px' }}>
                  この見積を教材にして、<strong>なぜその材料が・何個・何のために要り、どう使うのか</strong>を若手向けの文章にします。
                  数量はこの見積の値をそのまま使うので、資料と現場で数字がズレません。
                </p>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, color: '#4a5b6b' }}>読ませる相手:</span>
                  <select
                    value={trainingLevel}
                    onChange={e => setTrainingLevel(e.target.value)}
                    style={{ padding: '7px 10px', border: '1px solid #c3d0da', borderRadius: 8, fontSize: 13, background: '#fff', color: '#1e293b' }}
                  >
                    <option value="新人">新人（入社1年目）</option>
                    <option value="2〜3年目">2〜3年目</option>
                    <option value="職長候補">職長候補</option>
                  </select>
                  <button className="btn btn-primary" onClick={makeTraining} disabled={trainingLoading}>
                    {trainingLoading ? '解説を作っています…' : '🎓 解説を作る'}
                  </button>
                  <span style={{ fontSize: 11, color: '#8b95a1' }}>AIストック 1</span>
                </div>
              </>
            )}

            {trainingErr && (
              <div style={{ marginTop: 8, fontSize: 12, color: '#c0392b', background: '#fdf2f0', border: '1px solid #f0c8c0', borderRadius: 6, padding: '8px 10px' }}>
                {trainingErr}
              </div>
            )}

            {trainingShown && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 15, fontWeight: 'bold', color: '#2e4057' }}>{training.title || '研修資料'}</div>
                <div style={{ fontSize: 11, color: '#8b95a1', marginBottom: 8 }}>
                  {training.workType || ''}{training.level ? '　対象: ' + training.level : ''}{training.generatedAt ? '　作成: ' + training.generatedAt : ''}
                </div>

                {training.overview && (
                  <div style={{ background: '#fff', border: '1px solid #d9e2ea', borderLeft: '4px solid #2e4057', borderRadius: '0 8px 8px 0', padding: '10px 12px', fontSize: 13, lineHeight: 1.8, whiteSpace: 'pre-wrap', color: '#26313d' }}>
                    {training.overview}
                  </div>
                )}

                {(training.flow || []).length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 13, fontWeight: 'bold', color: '#2e4057', marginBottom: 6 }}>1. 工事の流れ — どの順で、なぜその順番か</div>
                    {(training.flow || []).map((f: any, i: number) => (
                      <div key={i} style={{ background: '#fff', border: '1px solid #e3e9ee', borderRadius: 8, padding: '8px 12px', marginBottom: 6 }}>
                        <div style={{ fontSize: 13, fontWeight: 'bold', color: '#26313d' }}>{f.step} <span style={{ fontWeight: 'normal' }}>{f.what}</span></div>
                        {f.why && <div style={{ fontSize: 12, color: '#556575', marginTop: 3 }}>なぜこの順番: {f.why}</div>}
                        {f.watch && <div style={{ fontSize: 12, color: '#1f6f3f', marginTop: 2 }}>👁 見ておく所: {f.watch}</div>}
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 'bold', color: '#2e4057', marginBottom: 6 }}>
                    2. 材料 — なぜ要るのか・何個要るのか・どう使うのか
                    <span style={{ fontWeight: 'normal', fontSize: 11, color: '#8b95a1', marginLeft: 6 }}>
                      解説 {(training.materials || []).length}件{training.sourceItemCount ? '／見積の材料・仮設 ' + training.sourceItemCount + '行' : ''}
                    </span>
                  </div>
                  {(training.materials || []).map((m: any, i: number) => (
                    <div key={i} style={{ background: '#fff', border: '1px solid #d9e2ea', borderRadius: 8, marginBottom: 8, overflow: 'hidden' }}>
                      <div style={{ background: '#eef3f8', padding: '7px 12px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid #d9e2ea' }}>
                        <span style={{ background: '#2e4057', color: '#fff', width: 20, height: 20, borderRadius: '50%', textAlign: 'center', lineHeight: '20px', fontSize: 11, flex: 'none' }}>{i + 1}</span>
                        <span style={{ fontWeight: 'bold', fontSize: 14, flex: 1, color: '#26313d' }}>{m.name}</span>
                        {m.quantity && <span style={{ background: '#fff', border: '1px solid #b9c9d6', borderRadius: 4, padding: '2px 10px', fontSize: 12, fontWeight: 'bold', color: '#2e4057' }}>{m.quantity}</span>}
                      </div>
                      <div style={{ padding: '8px 12px', fontSize: 13, lineHeight: 1.8, color: '#26313d' }}>
                        {m.role && <div style={{ marginBottom: 5 }}><span style={{ color: '#4a5b6b', fontSize: 11 }}>何に使うか</span><br />{m.role}</div>}
                        {m.why && <div style={{ marginBottom: 5 }}><span style={{ color: '#4a5b6b', fontSize: 11 }}>なぜ必要か</span><br />{m.why}</div>}
                        {m.howMany && (
                          <div style={{ marginBottom: 5, background: '#f4f7fa', borderRadius: 6, padding: '6px 9px' }}>
                            <span style={{ color: '#4a5b6b', fontSize: 11 }}>なぜこの数量か</span><br />{m.howMany}
                          </div>
                        )}
                        {m.howToUse && (
                          <div style={{ marginBottom: 5 }}>
                            <span style={{ color: '#4a5b6b', fontSize: 11 }}>どう使うか</span>
                            <div style={{ whiteSpace: 'pre-wrap' }}>{m.howToUse}</div>
                          </div>
                        )}
                        {m.tools && <div style={{ fontSize: 12, color: '#556575' }}>🔧 使う道具: {m.tools}</div>}
                        {m.mistakes && <div style={{ fontSize: 12, color: '#a8442a', background: '#fff8f5', borderRadius: 6, padding: '5px 9px', marginTop: 4 }}>⚠ よくある失敗: {m.mistakes}</div>}
                        {m.seniorTip && <div style={{ fontSize: 12, color: '#1f6f3f', background: '#f5fbf7', borderRadius: 6, padding: '5px 9px', marginTop: 4 }}>💡 先輩のコツ: {m.seniorTip}</div>}
                      </div>
                    </div>
                  ))}
                </div>

                {(training.labor || []).length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 13, fontWeight: 'bold', color: '#2e4057', marginBottom: 6 }}>3. 職人 — 誰が何をして、なぜその人数・日数か</div>
                    {(training.labor || []).map((l: any, i: number) => (
                      <div key={i} style={{ background: '#fff', border: '1px solid #e3e9ee', borderRadius: 8, padding: '8px 12px', marginBottom: 6, fontSize: 13, lineHeight: 1.8, color: '#26313d' }}>
                        <div><strong>{l.trade}</strong> <span style={{ color: '#2e4057', fontSize: 12 }}>{l.manDays}</span></div>
                        {l.whatTheyDo && <div>{l.whatTheyDo}</div>}
                        {l.whyThisManDays && <div style={{ fontSize: 12, color: '#556575' }}>人工の根拠: {l.whyThisManDays}</div>}
                      </div>
                    ))}
                  </div>
                )}

                {(training.safety || []).length > 0 && (
                  <div style={{ marginTop: 12, background: '#fff8f0', border: '1px solid #f0d8b8', borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ fontSize: 13, fontWeight: 'bold', color: '#a8442a', marginBottom: 5 }}>4. 安全 — ここで人が死ぬ・怪我をする</div>
                    <ul style={{ margin: '0 0 0 18px', fontSize: 13, lineHeight: 1.8, color: '#26313d' }}>
                      {(training.safety || []).map((x: any, i: number) => <li key={i}>{x}</li>)}
                    </ul>
                  </div>
                )}

                {training.costEducation && (
                  <div style={{ marginTop: 12, background: '#fff', border: '1px solid #d9e2ea', borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ fontSize: 13, fontWeight: 'bold', color: '#2e4057', marginBottom: 4 }}>5. 原価の感覚</div>
                    <div style={{ fontSize: 13, lineHeight: 1.8, whiteSpace: 'pre-wrap', color: '#26313d' }}>{training.costEducation}</div>
                  </div>
                )}

                {(training.quiz || []).length > 0 && (
                  <div style={{ marginTop: 12, background: '#fff', border: '1px solid #d9e2ea', borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ fontSize: 13, fontWeight: 'bold', color: '#2e4057', marginBottom: 4 }}>6. 確認問題</div>
                    {(training.quiz || []).map((q: any, i: number) => (
                      <div key={i} style={{ borderBottom: '1px dashed #e3e9ee', padding: '6px 0', fontSize: 13, lineHeight: 1.7, color: '#26313d' }}>
                        <div style={{ fontWeight: 'bold' }}>Q{i + 1}. {q.q}</div>
                        <div style={{ color: '#4a5b6b' }}>A. {q.a}</div>
                      </div>
                    ))}
                  </div>
                )}

                {training.closing && (
                  <div style={{ marginTop: 12, background: '#2e4057', color: '#fff', borderRadius: 8, padding: '11px 14px', fontSize: 13, lineHeight: 1.8, whiteSpace: 'pre-wrap' }}>
                    {training.closing}
                  </div>
                )}

                <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <select
                    value={trainingLevel}
                    onChange={e => setTrainingLevel(e.target.value)}
                    style={{ padding: '6px 10px', border: '1px solid #c3d0da', borderRadius: 8, fontSize: 12, background: '#fff', color: '#1e293b' }}
                  >
                    <option value="新人">新人（入社1年目）</option>
                    <option value="2〜3年目">2〜3年目</option>
                    <option value="職長候補">職長候補</option>
                  </select>
                  <button className="btn" style={{ fontSize: 12, padding: '6px 14px' }} onClick={makeTraining} disabled={trainingLoading}>
                    {trainingLoading ? '作成中…' : '🔄 この相手向けに作り直す'}
                  </button>
                  <span style={{ fontSize: 11, color: '#8b95a1' }}>※数量は見積の値をそのまま使っています。手順・安全は現場の職長の指示が優先です。</span>
                </div>
              </div>
            )}
          </div>

          {/* 再解析・チャット相談 */}
          <div className="card" style={{ marginTop: 16, textAlign: 'center', background: '#f8f9fa' }}>
            <p style={{ fontSize: 13, color: '#888', marginBottom: 8 }}>内容を修正して再解析、またはチャットで詳細を相談できます</p>
            <div style={{ marginBottom: 8 }}>
              <input
                type="text"
                value={location}
                onChange={e => setLocation(e.target.value)}
                placeholder="📍 場所（現場住所・物件名）"
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #ddd', borderRadius: 8, fontSize: 13 }}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'flex-end' }}>
              <textarea
                value={comment}
                onChange={e => setComment(e.target.value)}
                placeholder="追加の工事内容や修正点を入力..."
                style={{ flex: 1, minHeight: 60, padding: 10, border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, resize: 'vertical', color: '#1e293b', background: '#fff', WebkitUserSelect: 'text', userSelect: 'text' }}
              />
              <button className="btn btn-primary" onClick={() => analyze()} disabled={analyzing} style={{ height: 60 }}>
                {analyzing ? '解析中...' : '🔄 再解析'}
              </button>
              <button className="btn" onClick={() => {
                const r = result;
                setChatMessages([
                  { role: 'assistant', content: `先ほどの見積結果を確認しました。\n\n工事種別: ${r.workType}\n売価: ¥${Math.round(r.estimatedTotal||0).toLocaleString()}\n材料費: ¥${Math.round(r.estimatedMaterialCost||0).toLocaleString()}\n人件費: ¥${Math.round(r.estimatedLaborCost||0).toLocaleString()}\n${r.breakdown ? '内訳:\n' + r.breakdown.map((b:any)=>`  ${b.item}: ¥${Math.round(b.cost||0).toLocaleString()}`).join('\n') : ''}\n\nこの見積について、何でもご質問ください。\n例：「材料をもっと安いものに変えたい」「工期を短くしたい」「追加で○○もやりたい」` },
                ]);
                setChatEstimate(null);
                setChatSessionId(null);
                setResult(null);
                setMode('chat');
                // 入力欄にフォーカスを繰り返しかける
                const focusInterval = setInterval(() => {
                  if (chatInputRef.current) {
                    chatInputRef.current.focus();
                    chatInputRef.current.click();
                    clearInterval(focusInterval);
                  }
                }, 100);
                setTimeout(() => clearInterval(focusInterval), 3000);
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }} style={{ height: 60, background: '#8e44ad', color: '#fff', border: 'none', borderRadius: 8, padding: '0 16px', cursor: 'pointer', fontSize: 13, fontWeight: 'bold' }}>
                💬 チャットで相談
              </button>
            </div>
          </div>

          {/* 完成イメージ生成 */}
          <div className="card" style={{ marginTop: 16 }}>
            <h3 style={{ marginBottom: 12 }}>🎨 完成イメージを生成</h3>
            {!generatedImage ? (
              <div style={{ textAlign: 'center' }}>
                <p style={{ color: '#888', marginBottom: 12, fontSize: 13 }}>
                  AI がこの工事の完成イメージを生成します（⏱ {etaText('image-gen', IMAGE_SEC)}）
                </p>
                <button className="btn btn-primary" onClick={generateImage} disabled={generating} style={{ fontSize: 16, padding: '12px 32px' }}>
                  {generating ? `🔄 画像を生成中... ${genElapsed}秒` : '🎨 完成イメージを生成'}
                </button>
              </div>
            ) : (
              <div style={{ textAlign: 'center' }}>
                <img src={generatedImage} style={{ maxWidth: '100%', maxHeight: 500, borderRadius: 8, boxShadow: '0 4px 20px rgba(0,0,0,0.15)' }} alt="generated" />
                <div style={{ marginTop: 12 }}>
                  <button className="btn btn-secondary" onClick={generateImage} disabled={generating}>
                    {generating ? `🔄 再生成中... ${genElapsed}秒` : '🔄 別のイメージを生成'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 請求書セクション */}
          {invoiceLoading && (
            <div className="card" style={{ marginTop: 16, textAlign: 'center', padding: 20, color: '#888' }}>
              ⏳ 請求書を読み込み中...
            </div>
          )}
          {logInvoice && logInvoice.invoice && (
            <div className="card" style={{ marginTop: 16, border: '2px solid #27ae60' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ margin: 0 }}>💰 請求書</h3>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{
                    fontSize: 11, padding: '3px 10px', borderRadius: 12, fontWeight: 'bold',
                    background: logInvoice.invoice.status === 'paid' ? '#e8fdf0' : logInvoice.invoice.status === 'sent' ? '#e8f4fd' : logInvoice.invoice.status === 'overdue' ? '#fde8e8' : '#f0f0f0',
                    color: logInvoice.invoice.status === 'paid' ? '#27ae60' : logInvoice.invoice.status === 'sent' ? '#3498db' : logInvoice.invoice.status === 'overdue' ? '#e74c3c' : '#999',
                  }}>
                    {logInvoice.invoice.status === 'draft' ? '下書き' : logInvoice.invoice.status === 'sent' ? '送付済' : logInvoice.invoice.status === 'paid' ? '入金済' : '期限超過'}
                  </span>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={async () => {
                      try {
                        await (window as any).api.generatePDF({ invoice: logInvoice.invoice, materials: logInvoice.materials });
                      } catch (e: any) {
                        alert('PDF生成に失敗: ' + (e.message || e));
                      }
                    }}
                    style={{ fontSize: 12, padding: '6px 16px', background: '#27ae60' }}
                  >
                    📄 請求書PDF出力
                  </button>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 13, marginBottom: 12 }}>
                <div><span style={{ color: '#888' }}>請求先:</span> {logInvoice.invoice.client_name || '（未設定）'}</div>
                <div><span style={{ color: '#888' }}>発行日:</span> {logInvoice.invoice.issue_date || '—'}</div>
                <div><span style={{ color: '#888' }}>施工:</span> {logInvoice.invoice.construction_title || '—'}</div>
                <div><span style={{ color: '#888' }}>支払期限:</span> {logInvoice.invoice.due_date || '—'}</div>
              </div>
              <div style={{ textAlign: 'right', fontSize: 16, fontWeight: 'bold', color: '#27ae60' }}>
                請求金額: {fmt(logInvoice.invoice.amount || 0)}
                <span style={{ fontSize: 12, color: '#888', marginLeft: 8 }}>
                  (税込 {fmt(Math.round((logInvoice.invoice.amount || 0) * (1 + (logInvoice.invoice.tax_rate || 0.1))))})
                </span>
              </div>
            </div>
          )}
          {!logInvoice && !invoiceLoading && selectedLog && estimateLog.find(l => l.id === selectedLog)?.constructionId && (
            <div className="card" style={{ marginTop: 16, textAlign: 'center', padding: 16, background: '#f8f9fa' }}>
              <p style={{ color: '#888', fontSize: 13, marginBottom: 8 }}>この見積に紐づく請求書がありません</p>
              <button
                className="btn btn-sm"
                onClick={async () => {
                  const log = estimateLog.find(l => l.id === selectedLog);
                  if (!log?.constructionId) return;
                  setInvoiceLoading(true);
                  try {
                    const today = new Date().toISOString().split('T')[0];
                    await (window as any).api.createInvoice({
                      constructionId: log.constructionId,
                      clientName: '',
                      issueDate: today,
                      amount: log.total || 0,
                      status: 'draft',
                    });
                    const inv = await (window as any).api.getInvoiceByConstruction(log.constructionId);
                    setLogInvoice(inv);
                  } catch (e: any) {
                    alert('請求書作成に失敗: ' + (e.message || e));
                  }
                  setInvoiceLoading(false);
                }}
                style={{ fontSize: 12, background: '#27ae60', color: '#fff', border: 'none', padding: '6px 16px', borderRadius: 6, cursor: 'pointer' }}
              >
                💰 請求書を作成
              </button>
            </div>
          )}

          {/* 発注書セクション */}
          {poLoading && (
            <div className="card" style={{ marginTop: 16, textAlign: 'center', padding: 20, color: '#888' }}>
              ⏳ 発注書を読み込み中...
            </div>
          )}
          {logPO && (
            <div className="card" style={{ marginTop: 16, border: '2px solid #3498db' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ margin: 0 }}>📝 発注書</h3>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{
                    fontSize: 11, padding: '3px 10px', borderRadius: 12, fontWeight: 'bold',
                    background: logPO.status === 'draft' ? '#f0f0f0' : logPO.status === 'sent' ? '#e8f4fd' : logPO.status === 'delivered' ? '#e8fdf0' : '#fde8e8',
                    color: logPO.status === 'draft' ? '#999' : logPO.status === 'sent' ? '#3498db' : logPO.status === 'delivered' ? '#27ae60' : '#e74c3c',
                  }}>
                    {logPO.status === 'draft' ? '下書き' : logPO.status === 'sent' ? '発注済' : logPO.status === 'delivered' ? '納品済' : 'キャンセル'}
                  </span>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={async () => {
                      try {
                        await (window as any).api.generatePurchaseOrderPDF({ po: logPO, items: logPO.items });
                      } catch (e: any) {
                        alert('PDF生成に失敗: ' + (e.message || e));
                      }
                    }}
                    style={{ fontSize: 12, padding: '6px 16px' }}
                  >
                    📄 PDF出力
                  </button>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 13, marginBottom: 12 }}>
                <div><span style={{ color: '#888' }}>発注先:</span> {logPO.vendor_name || '（未設定）'}</div>
                <div><span style={{ color: '#888' }}>発行日:</span> {logPO.issue_date || '—'}</div>
                <div><span style={{ color: '#888' }}>施工:</span> {logPO.construction_title || '—'}</div>
                <div><span style={{ color: '#888' }}>納期:</span> {logPO.delivery_date || '—'}</div>
              </div>
              {logPO.items && logPO.items.length > 0 && (
                <table className="data-table" style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>品名</th>
                      <th style={{ textAlign: 'center' }}>数量</th>
                      <th style={{ textAlign: 'center' }}>単位</th>
                      <th style={{ textAlign: 'right' }}>単価</th>
                      <th style={{ textAlign: 'right' }}>小計</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logPO.items.map((item: any) => (
                      <tr key={item.id}>
                        <td>{item.name}</td>
                        <td style={{ textAlign: 'center' }}>{item.quantity}</td>
                        <td style={{ textAlign: 'center' }}>{item.unit || '式'}</td>
                        <td style={{ textAlign: 'right' }}>{fmt(item.unit_price || 0)}</td>
                        <td style={{ textAlign: 'right', fontWeight: 'bold' }}>{fmt((item.quantity || 1) * (item.unit_price || 0))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div style={{ textAlign: 'right', marginTop: 8, fontSize: 16, fontWeight: 'bold', color: '#3498db' }}>
                合計: {fmt(logPO.amount || 0)}
                <span style={{ fontSize: 12, color: '#888', marginLeft: 8 }}>
                  (税込 {fmt(Math.round((logPO.amount || 0) * (1 + (logPO.tax_rate || 0.1))))})
                </span>
              </div>
            </div>
          )}
          {!logPO && !poLoading && selectedLog && estimateLog.find(l => l.id === selectedLog)?.constructionId && (
            <div className="card" style={{ marginTop: 16, textAlign: 'center', padding: 16, background: '#f8f9fa' }}>
              <p style={{ color: '#888', fontSize: 13, marginBottom: 8 }}>この見積に紐づく発注書がありません</p>
              <button
                className="btn btn-primary btn-sm"
                onClick={async () => {
                  const log = estimateLog.find(l => l.id === selectedLog);
                  if (!log?.constructionId) return;
                  setPOLoading(true);
                  try {
                    await (window as any).api.createPOFromConstruction(log.constructionId);
                    const po = await (window as any).api.getPOByConstruction(log.constructionId);
                    setLogPO(po);
                  } catch (e: any) {
                    alert('発注書作成に失敗: ' + (e.message || e));
                  }
                  setPOLoading(false);
                }}
                style={{ fontSize: 12 }}
              >
                📝 発注書を作成
              </button>
            </div>
          )}

        </div>
      )}
      </div>

      {/* 見積ログ（右サイドバー） */}
      {estimateLog.length > 0 && (
        <div style={{ width: 240, flexShrink: 0 }}>
          <div style={{ position: 'sticky', top: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 'bold', marginBottom: 8, color: '#555' }}>見積履歴</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {estimateLog.map((log) => (
                <div
                  key={log.id}
                  onClick={() => loadFromLog(log)}
                  style={{
                    padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                    border: selectedLog === log.id ? '2px solid #3a7bd5' : '1px solid #ddd',
                    background: selectedLog === log.id ? '#f0f7ff' : '#fff',
                    transition: 'all 0.15s',
                  }}
                  onMouseEnter={e => { if (selectedLog !== log.id) e.currentTarget.style.background = '#f8f9fa'; }}
                  onMouseLeave={e => { if (selectedLog !== log.id) e.currentTarget.style.background = '#fff'; }}
                >
                  {(log.image || log.uploadedImage) && (
                    <img src={log.image || log.uploadedImage} style={{ width: '100%', height: 60, objectFit: 'cover', borderRadius: 6, marginBottom: 6 }} alt="" />
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <div style={{ fontSize: 11, color: '#888', flex: 1 }}>{log.date || ''} {log.time || ''}</div>
                    {log.source === 'chat_followup' && (
                      <span style={{ fontSize: 10, fontWeight: 700, color: '#7c3aed', background: '#f3e8ff', borderRadius: 4, padding: '1px 5px' }} title="既存見積についての相談から作成された見積">💬 相談</span>
                    )}
                    {log.source === 'chat' && (
                      <span style={{ fontSize: 10, fontWeight: 700, color: '#2563eb', background: '#dbeafe', borderRadius: 4, padding: '1px 5px' }} title="チャットで作成した見積">💬 チャット</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 'bold', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {log.uploadedImage ? '📷' : ''}{log.image ? '🖼' : ''} {log.workType}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
                    <div style={{ fontSize: 14, fontWeight: 'bold', color: '#27ae60' }}>
                      {fmt(log.total)}
                      {/* 金額を直して保存した履歴は、AIの原案がいくらだったかも見えるようにする */}
                      {log.edited && (
                        <span
                          title={`AIの原案 ${fmt(log.aiTotal || 0)} から修正済み`}
                          style={{ marginLeft: 5, fontSize: 9, fontWeight: 700, color: '#b45309', background: '#fef3c7', borderRadius: 4, padding: '1px 4px', verticalAlign: 'middle' }}
                        >修正済</span>
                      )}
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm('この見積履歴を削除しますか？')) {
                          (window as any).api.deleteEstimateLog?.(log.id).then(() => {
                            setEstimateLog(prev => prev.filter(l => l.id !== log.id));
                            if (selectedLog === log.id) {
                              setSelectedLog(null);
                              setResult(null);
                              setGeneratedImage(null);
                            }
                          });
                        }
                      }}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: '#ccc', fontSize: 14, padding: '2px 4px', borderRadius: 4,
                      }}
                      onMouseEnter={e => e.currentTarget.style.color = '#e74c3c'}
                      onMouseLeave={e => e.currentTarget.style.color = '#ccc'}
                      title="削除"
                    >
                      x
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
