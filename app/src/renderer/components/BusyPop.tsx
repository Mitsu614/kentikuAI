import React, { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * 「あとどれくらい待てばいいのか」を必ずお客様に見せるための共通POP。
 *
 * ページ側は startBusy / setBusyProgress / endBusy を呼ぶだけでよく、
 * 画面上部に固定のPOPが出る（スクロールしても隠れない）。
 * 目安時間は実測値を localStorage に貯めて自動で較正されるので、
 * 使い込むほどそのお客様の回線・PCに合った時間が出る。
 */

export type BusyTask = {
  /** 実測を貯めるキー（用途ごとに固定の文字列） */
  key: string;
  /** POPの見出し（例: 請求書をAIで読み取っています） */
  title: string;
  /** 補足（例: 8枚を順番に読み取ります） */
  sub?: string;
  /** 目安の全体秒数。total を渡すときは perItemSec の方を使う */
  etaSec?: number;
  /** 複数件処理のときの総数 */
  total?: number;
  /** 1件あたりの目安秒数（total とセットで使う） */
  perItemSec?: number;
  /** 待っている間に見せる一言（省略時は既定文） */
  note?: string;
};

type BusyState = (BusyTask & { startedAt: number; done: number }) | null;

// ---- ごく小さなストア（Provider を挟まずどこからでも呼べるようにする） ----
let current: BusyState = null;
let doneFlash: { title: string; sec: number } | null = null;
let flashTimer: any = null;
const subs = new Set<() => void>();
const emit = () => { subs.forEach(f => f()); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const getSnapshot = () => current;
const getFlash = () => doneFlash;

// ---- 実測の学習（同じ作業の過去5回の中央値を目安にする） ----
const SAMPLE_PREFIX = 'busyEta:';

function readSamples(key: string): number[] {
  try {
    const raw = localStorage.getItem(SAMPLE_PREFIX + key);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((n: any) => typeof n === 'number' && n > 0 && n < 24 * 3600) : [];
  } catch { return []; }
}

function pushSample(key: string, sec: number) {
  if (!(sec > 0)) return;
  try { localStorage.setItem(SAMPLE_PREFIX + key, JSON.stringify([...readSamples(key), sec].slice(-5))); } catch {}
}

/** 過去の実測から目安秒数を返す（実測が2回未満なら既定値） */
export function learnedSec(key: string, fallbackSec: number): number {
  const arr = readSamples(key);
  if (arr.length < 2) return fallbackSec;
  const sorted = [...arr].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)]);
}

/** 秒数を日本語の「ざっくり時間」に変換（45秒 / 2分半 / 1時間20分） */
export function fmtSec(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 10) return `${s}秒`;
  if (s < 60) return `${Math.round(s / 5) * 5}秒`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return r < 15 ? `${m}分` : r < 45 ? `${m}分半` : `${m + 1}分`;
  const h = Math.floor(m / 60), rm = m % 60;
  return rm ? `${h}時間${rm}分` : `${h}時間`;
}

/** ボタンの横などに「目安 約○分」と先出しするための文字列 */
export function etaText(key: string, fallbackSec: number, count = 1): string {
  return `目安 約${fmtSec(learnedSec(key, fallbackSec) * Math.max(1, count))}`;
}

// ---- ページ側から呼ぶAPI ----

/** 待ち時間POPを出す。処理を始める直前に呼ぶ */
export function startBusy(task: BusyTask) {
  const per = task.perItemSec;
  const total = task.total;
  const eta = total && per
    ? learnedSec(task.key, per) * total
    : learnedSec(task.key, task.etaSec || 30);
  current = { ...task, etaSec: eta, startedAt: Date.now(), done: 0 };
  if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
  doneFlash = null;
  emit();
}

/** 複数件処理のとき、1件終わるたびに呼ぶ（残り時間が実測ペースで再計算される） */
export function setBusyProgress(done: number, sub?: string) {
  if (!current) return;
  current = { ...current, done, ...(sub !== undefined ? { sub } : {}) };
  emit();
}

/** POPの文言だけ差し替える（工程が変わったときなど） */
export function updateBusy(patch: Partial<BusyTask>) {
  if (!current) return;
  current = { ...current, ...patch };
  emit();
}

/**
 * 待ち時間POPを閉じる。必ず finally で呼ぶこと。
 * ok:false（失敗）のときは実測を学習に混ぜない＝異常な短時間で目安が壊れないようにする。
 */
export function endBusy(opts?: { ok?: boolean }) {
  const cur = current;
  current = null;
  if (cur) {
    const sec = Math.round((Date.now() - cur.startedAt) / 1000);
    const ok = opts?.ok !== false;
    if (ok && sec >= 2) {
      pushSample(cur.key, cur.total && cur.total > 0 ? sec / cur.total : sec);
      doneFlash = { title: cur.title, sec };
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { doneFlash = null; flashTimer = null; emit(); }, 3200);
    }
  }
  emit();
}

/** 処理を async で包んで自動で開閉するヘルパー */
export async function withBusy<T>(task: BusyTask, fn: () => Promise<T>): Promise<T> {
  startBusy(task);
  try {
    const r = await fn();
    endBusy();
    return r;
  } catch (e) {
    endBusy({ ok: false });
    throw e;
  }
}

// ---- 表示本体（App から1回だけ描画する） ----
export default function BusyPop() {
  const busy = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const flash = useSyncExternalStore(subscribe, getFlash, getFlash);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!busy) { setElapsed(0); return; }
    const tick = () => setElapsed(Math.floor((Date.now() - busy.startedAt) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [busy?.startedAt]);

  // 学習POPと重ならないように、待機中は body にクラスを付ける
  useEffect(() => {
    document.body.classList.toggle('busy-active', !!busy);
    return () => { document.body.classList.remove('busy-active'); };
  }, [!!busy]);

  if (flash && !busy) {
    return (
      <div className="busy-pop busy-pop-done" role="status">
        <span className="busy-icon">✅</span>
        <div className="busy-body">
          <div className="busy-title">完了しました</div>
          <div className="busy-note">{flash.title}（実際 {fmtSec(flash.sec)}）</div>
        </div>
      </div>
    );
  }

  if (!busy) return null;

  // 複数件のときは実測ペースで残りを引き直す（1枚目が重い環境でもズレが小さくなる）
  const pace = busy.total && busy.done > 0 ? (elapsed / busy.done) * busy.total : 0;
  const etaNow = Math.max(pace || busy.etaSec || 30, 1);
  const remain = etaNow - elapsed;
  const byTime = Math.min(96, (elapsed / etaNow) * 96);
  const pct = busy.total ? Math.max((busy.done / busy.total) * 100, byTime) : byTime;

  const remainLabel =
    remain > 3 ? `あと約 ${fmtSec(remain)}`
    : elapsed > etaNow * 1.6 ? 'もう少しかかっています'
    : 'まもなく完了します';

  return (
    <div className="busy-pop" role="status" aria-live="polite">
      <span className="busy-icon">⏳</span>
      <div className="busy-body">
        <div className="busy-title">{busy.title}</div>
        <div className="busy-remain">{remainLabel}</div>
        <div className="busy-bar"><div className="busy-bar-fill" style={{ width: `${Math.max(3, pct)}%` }} /></div>
        <div className="busy-meta">
          <span>{busy.total ? `${Math.min(busy.done + 1, busy.total)}件目 / ${busy.total}件` : busy.sub || ''}</span>
          <span>経過 {fmtSec(elapsed)} ・ 目安 約{fmtSec(etaNow)}</span>
        </div>
        <div className="busy-note">{busy.note || '完了までこの画面を開いたままにしてください'}</div>
      </div>
    </div>
  );
}
