// ビル風診断が満たすべき不変条件。
//
// 外部の正解データ（風洞実験の実測値）は入手できなかった。AIJのCFD検証用
// ベンチマークは存在するが、数値が図の中にあり表として取り出せない。
// そこで harness-electrical と同じ「自己整合を測る」方式にした。
// 公表文献が報告している**定性的な関係**（順序・単調性・範囲）を不変条件に置き、
// 掃いたケース全部でそれを満たすかを見る。
//
// ここで測れるのは「文献の傾向と矛盾していないか」であって、
// 「実測に何%で当たるか」ではない。そこは取り違えないこと。

const BASE = { H: 60, B: 40, D: 20, Hs: 10, rough: "III", bcr: 30, region: "metro", form: "none", area: 20000 };
const v = (o) => Object.assign({}, BASE, o);

// 掃くケース群
function sweep() {
  const out = [];
  for (const H of [15, 31, 45, 60, 100, 150, 200]) {
    for (const B of [15, 25, 40, 60, 90, 120]) {
      for (const Hs of [5, 10, 20, 31]) {
        for (const rough of ["I", "II", "III", "IV"]) {
          for (const form of ["none", "pilotis", "through"]) {
            if (Hs >= H) continue;
            out.push(v({ H, B, D: Math.max(8, Math.round(B * 0.5)), Hs, rough, form }));
          }
        }
      }
    }
  }
  return out;
}

// 各条件は { id, 出典, test(E) -> {ok, detail} }
// E は model.load() が返すエンジン
const CONSTRAINTS = [

  { id: "C1", src: "文献一般（単独高層の増加率はおおむね1.2〜2.0倍）",
    desc: "低層街に単独で建つ高層の増加率が 1.15〜2.2 の範囲に収まる",
    test(E) {
      const bad = [];
      for (const H of [45, 60, 100, 150]) {
        for (const B of [25, 40, 60, 90]) {
          const R = E.speedup(v({ H, B, D: B * 0.5, Hs: 8, rough: "III", form: "none" })).R;
          if (R < 1.15 || R > 2.2) bad.push(`H${H} B${B} → ${R.toFixed(2)}`);
        }
      }
      return { ok: !bad.length, detail: bad.slice(0, 4).join(" / ") };
    } },

  { id: "C2", src: "Wise (1970) / Penwarden & Wise (1975)",
    desc: "周辺市街地からの突出が大きいほど増加率が上がる（単調）",
    test(E) {
      const bad = [];
      for (const H of [45, 60, 100, 150]) {
        let prev = Infinity;
        for (const Hs of [31, 20, 10, 5, 0]) {   // 突出を増やす向き
          if (Hs >= H) continue;
          const R = E.speedup(v({ H, Hs })).R;
          if (R < prev - 1e-9 && prev !== Infinity) bad.push(`H${H} Hs${Hs}: ${R.toFixed(3)} < ${prev.toFixed(3)}`);
          prev = R;
        }
      }
      return { ok: !bad.length, detail: bad.slice(0, 4).join(" / ") };
    } },

  { id: "C3", src: "Tsang, Kwok & Hitchcock (2012)",
    desc: "見付け幅が広いほど増加率が上がる（単調）",
    test(E) {
      const bad = [];
      for (const H of [45, 60, 100]) {
        let prev = -Infinity;
        for (const B of [15, 25, 40, 60, 90, 120]) {
          const R = E.speedup(v({ H, B, D: 20 })).R;
          if (R < prev - 1e-9) bad.push(`H${H} B${B}: ${R.toFixed(3)} < ${prev.toFixed(3)}`);
          prev = R;
        }
      }
      return { ok: !bad.length, detail: bad.slice(0, 4).join(" / ") };
    } },

  { id: "C4", src: "Tsang, Kwok & Hitchcock (2012)",
    desc: "同率で増やしたとき、幅の寄与が高さの寄与を上回る",
    test(E) {
      const bad = [];
      for (const H of [45, 60, 100, 150]) {
        for (const B of [25, 40, 60]) {
          const r0 = E.speedup(v({ H, B, D: 20 })).R;
          const rB = E.speedup(v({ H, B: B * 1.2, D: 20 })).R;
          const rH = E.speedup(v({ H: H * 1.2, B, D: 20 })).R;
          if (!(rB - r0 > rH - r0)) bad.push(`H${H} B${B}: ΔB=${(rB - r0).toFixed(3)} ΔH=${(rH - r0).toFixed(3)}`);
        }
      }
      return { ok: !bad.length, detail: bad.slice(0, 4).join(" / ") };
    } },

  { id: "C5", src: "Tsang, Kwok & Hitchcock (2012)",
    desc: "ポディウム（低層部の張り出し）で増加率が下がる",
    test(E) {
      const bad = [];
      for (const c of sweep().slice(0, 200)) {
        const R = E.speedup(c).R;
        const R2 = E.applyMeasures(R, new Set(["podium"]));
        if (!(R2 < R || Math.abs(R - 1) < 1e-9)) bad.push(`${R.toFixed(3)}→${R2.toFixed(3)}`);
      }
      return { ok: !bad.length, detail: bad.slice(0, 3).join(" / ") };
    } },

  { id: "C6", src: "Uematsu ら (1992) / Stathopoulos (1985)",
    desc: "隅切りによる低減が増分の10〜25%に収まる（わずかな形状変更で大きく改善する範囲）",
    test(E) {
      const m = E.MEASURES.find(x => x.id === "corner");
      const cut = (1 - m.f) * 100;
      return { ok: cut >= 10 && cut <= 25, detail: `低減 ${cut.toFixed(0)}%` };
    } },

  { id: "C7", src: "Blocken, Carmeliet & Stathopoulos (2007, 2008)",
    desc: "足元の増速は 貫通通路 > ピロティ > なし の順",
    test(E) {
      const bad = [];
      for (const c of [v({}), v({ H: 150, B: 60 }), v({ H: 31, B: 20, Hs: 6 })]) {
        const none = E.speedup(Object.assign({}, c, { form: "none" })).R;
        const pil = E.speedup(Object.assign({}, c, { form: "pilotis" })).R;
        const thr = E.speedup(Object.assign({}, c, { form: "through" })).R;
        if (!(thr > pil && pil > none)) bad.push(`${none.toFixed(2)}/${pil.toFixed(2)}/${thr.toFixed(2)}`);
      }
      return { ok: !bad.length, detail: bad.join(" / ") };
    } },

  { id: "C8", src: "Kubota, Miura, Tominaga & Mochida (2008)",
    desc: "建蔽率が10%上がると建設前の風速比が 0.1 下がる",
    test(E) {
      const a = E.baseRatio("III", 30);
      const b = E.baseRatio("III", 40);
      const d = a - b;
      return { ok: Math.abs(d - 0.1) < 1e-6, detail: `Δ=${d.toFixed(4)}（期待 0.1000）` };
    } },

  { id: "C9", src: "地表面粗度の定義（告示第1454号）",
    desc: "粗度が粗いほど、建設前の歩行者レベル風速比は小さい",
    test(E) {
      const r = ["I", "II", "III", "IV"].map(x => E.baseRatio(x, null));
      const ok = r.every((x, i) => i === 0 || x < r[i - 1]);
      return { ok, detail: r.map(x => x.toFixed(2)).join(" > ") };
    } },

  { id: "C10", src: "3基準の整合",
    desc: "増加率を上げたとき、村上ランク・NENクラス・Lawson GEM が逆行しない",
    test(E) {
      const bad = [];
      const order = { A: 0, B: 1, C: 2, D: 3, E: 4 };
      for (const rough of ["II", "III", "IV"]) {
        for (const region of ["metro", "inland", "south"]) {
          let pm = 0, pn = -1, pg = 0;
          for (const Hs of [31, 20, 10, 5, 0]) {
            const d = E.diagnose(v({ H: 60, Hs, rough, region }), new Set());
            const m = d.after.murakami.rank, n = order[d.after.nen.cls.c], g = d.after.lawson.gem;
            if (m < pm) bad.push(`村上が逆行 ${rough}/${region} Hs${Hs}`);
            if (n < pn) bad.push(`NENが逆行 ${rough}/${region} Hs${Hs}`);
            if (g < pg - 1e-9) bad.push(`GEMが逆行 ${rough}/${region} Hs${Hs}`);
            pm = m; pn = n; pg = g;
          }
        }
      }
      return { ok: !bad.length, detail: [...new Set(bad)].slice(0, 3).join(" / ") };
    } },

  { id: "C11", src: "数値の健全性",
    desc: "掃いた全ケースで確率が 0〜1、風速が有限、ランクが 1〜4",
    test(E) {
      const bad = [];
      for (const c of sweep()) {
        const d = E.diagnose(c, new Set());
        const ps = [...d.after.murakami.p, d.after.nen.p5, d.after.nen.p15];
        if (ps.some(p => !(p >= 0 && p <= 1))) bad.push(`確率が範囲外 H${c.H} B${c.B}`);
        if (![1, 2, 3, 4].includes(d.after.murakami.rank)) bad.push(`ランク異常 H${c.H}`);
        if (!isFinite(d.after.storm.gust) || d.after.storm.gust <= 0) bad.push(`暴風が異常 H${c.H}`);
        if (!isFinite(d.after.lawson.gem)) bad.push(`GEMが異常 H${c.H}`);
      }
      return { ok: !bad.length, detail: [...new Set(bad)].slice(0, 3).join(" / ") };
    } },

  { id: "C12", src: "境界条件",
    desc: "周辺と同じ高さ（突出なし）なら増加率はほぼ 1.0",
    test(E) {
      const bad = [];
      for (const H of [15, 31, 60, 100]) {
        const R = E.speedup(v({ H, Hs: H })).R;
        if (Math.abs(R - 1) > 1e-9) bad.push(`H${H} → ${R.toFixed(4)}`);
      }
      return { ok: !bad.length, detail: bad.join(" / ") };
    } },

  { id: "C13", src: "確率の単調性",
    desc: "閾値を上げれば超過確率は必ず下がる（10 > 15 > 20 m/s）",
    test(E) {
      const bad = [];
      for (const c of sweep().slice(0, 300)) {
        const p = E.diagnose(c, new Set()).after.murakami.p;
        if (!(p[0] >= p[1] && p[1] >= p[2])) bad.push(`H${c.H} B${c.B}: ${p.map(x => x.toFixed(4)).join(">")}`);
      }
      return { ok: !bad.length, detail: bad.slice(0, 3).join(" / ") };
    } },

  { id: "C14", src: "対策の実務的な意味",
    desc: "形状対策を3つ入れても増加率が 1.0 を下回らない（建てる前より静かにはならない）",
    test(E) {
      const bad = [];
      for (const c of sweep().slice(0, 300)) {
        const R2 = E.applyMeasures(E.speedup(c).R, new Set(["corner", "setback", "podium"]));
        if (R2 < 1) bad.push(`${R2.toFixed(3)}`);
      }
      return { ok: !bad.length, detail: bad.slice(0, 3).join(" / ") };
    } },

  { id: "C15", src: "村上ら (1986) の基準値",
    desc: "実装した閾値が原典どおり（10/15/20 m/s、ランク1〜3の超過頻度）",
    test(E) {
      const want = [
        [0.10, 0.009, 0.0008],
        [0.22, 0.036, 0.006],
        [0.35, 0.07, 0.015]
      ];
      const got = E.MURAKAMI.map(m => m.lim);
      const ok = JSON.stringify(E.GUSTS) === JSON.stringify([10, 15, 20]) &&
        JSON.stringify(got) === JSON.stringify(want);
      return { ok, detail: ok ? "一致" : JSON.stringify(got) };
    } },

  { id: "C16", src: "NEN 8100 (2006) の基準値",
    desc: "クラス境界が 2.5 / 5 / 10 / 20 %、危険性が 0.05 / 0.30 %",
    test(E) {
      const cls = E.NEN.map(n => n.max);
      const ok = JSON.stringify(cls.slice(0, 4)) === JSON.stringify([0.025, 0.05, 0.10, 0.20]);
      return { ok, detail: ok ? "一致" : JSON.stringify(cls) };
    } },

  { id: "C18", src: "このハーネスの感度分析で判明した不確かさ",
    desc: "判定ランクの幅（rankBand）が、点推定のランクを必ず含む",
    test(E) {
      const bad = [];
      for (const c of sweep().slice(0, 250)) {
        const d = E.diagnose(c, new Set());
        const b = E.rankBand(c, new Set());
        if (!(b.lo <= d.after.murakami.rank && d.after.murakami.rank <= b.hi)) {
          bad.push(`H${c.H} B${c.B}: ランク${d.after.murakami.rank} が幅 ${b.lo}〜${b.hi} の外`);
        }
        if (b.spread !== b.hi - b.lo) bad.push("spread の計算が合わない");
      }
      return { ok: !bad.length, detail: bad.slice(0, 3).join(" / ") };
    } },

  { id: "C19", src: "このハーネスの感度分析で判明した不確かさ",
    desc: "粗度区分と建蔽率が判定を動かす以上、幅が付くケースが相応にある（黙って点推定だけ出さない）",
    test(E) {
      const cases = sweep().slice(0, 400);
      const withBand = cases.filter(c => E.rankBand(c, new Set()).spread > 0).length;
      const pct = withBand / cases.length * 100;
      return { ok: pct > 20, detail: `幅が付くケース ${pct.toFixed(0)}%（20%超なら、不確かさが利用者に伝わっている）` };
    } },

  { id: "C17", src: "Lawson / LDDC の閾値",
    desc: "常時着座2.5 / 一時着座4 / 立ち止まり6 / 歩行8 m/s",
    test(E) {
      const t = E.LAWSON.map(x => x.t);
      const ok = JSON.stringify(t) === JSON.stringify([2.5, 4.0, 6.0, 8.0]);
      return { ok, detail: ok ? "一致" : JSON.stringify(t) };
    } }
];

module.exports = { CONSTRAINTS, sweep, BASE, v };
