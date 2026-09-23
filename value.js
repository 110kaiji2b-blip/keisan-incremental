'use strict';

/* =====================================================================
 * 巨大な数のための値モジュール
 *
 * 値は次のどちらかの形で持つ：
 *   ・ふつうの Number（安全な整数の範囲内。整数の計算は完全に正確）
 *   ・{ m, e } ＝ m × 10^e （1 ≤ m < 10）
 *
 * e は Number なので 10^(1.7×10^308) くらいまで表せる。
 * 最終目標の 10^(10^100) は e = 10^100 なので、余裕で収まる。
 * =================================================================== */
const V = (function () {
  const MAXN = Number.MAX_SAFE_INTEGER;
  // 指数自体を科学記数法で書きはじめる大きさ。
  // 2^53 を超えるまでは整数のまま正確に書く（+1 のズレまで見せないと式が解けないため）
  const EXP_SCI = 1e16;

  const isSci = v => typeof v === 'object' && v !== null;

  // m × 10^e を 1 ≤ m < 10 の形に整える
  function sci(m, e) {
    if (!isFinite(m) || !isFinite(e)) return { m: NaN, e: NaN };
    if (m === 0) return { m: 0, e: 0 };
    const d = Math.floor(Math.log10(Math.abs(m)));
    const r = d === 0 ? { m, e } : { m: m / Math.pow(10, d), e: e + d };
    r.m = parseFloat(r.m.toPrecision(12));   // 浮動小数点のゴミを落とす
    return r;
  }

  const toSci = v => (isSci(v) ? v : sci(v, 0));

  // 小さい値はふつうの Number に戻す
  function num(v) {
    if (!isSci(v)) return v;
    if (v.e > 15) return Infinity;
    return Math.round(v.m * Math.pow(10, v.e));
  }

  /* ---------------- 四則 ---------------- */

  function add(a, b) {
    if (!isSci(a) && !isSci(b)) {
      const r = a + b;
      if (Math.abs(r) <= MAXN) return r;
    }
    const A = toSci(a), B = toSci(b);
    if (A.m === 0) return b;
    if (B.m === 0) return a;
    const hi = A.e >= B.e ? A : B;
    const lo = A.e >= B.e ? B : A;
    const d = hi.e - lo.e;
    if (d > 17) return hi;                   // 小さい方は誤差以下
    return sci(hi.m + lo.m / Math.pow(10, d), hi.e);
  }

  function sub(a, b) {
    if (!isSci(a) && !isSci(b)) return a - b;
    const A = toSci(a), B = toSci(b);
    const d = A.e - B.e;
    if (d > 17) return A;
    return sci(A.m - B.m / Math.pow(10, d), A.e);
  }

  function mul(a, b) {
    if (!isSci(a) && !isSci(b)) {
      const r = a * b;
      if (Math.abs(r) <= MAXN) return r;
    }
    const A = toSci(a), B = toSci(b);
    return sci(A.m * B.m, A.e + B.e);
  }

  function div(a, b) {
    if (!isSci(a) && !isSci(b)) return a / b;
    const A = toSci(a), B = toSci(b);
    return sci(A.m / B.m, A.e - B.e);
  }

  // n は小さい整数（べき乗の指数）
  function pow(a, n) {
    if (!isSci(a)) {
      const r = Math.pow(a, n);
      if (Math.abs(r) <= MAXN) return r;
    }
    const A = toSci(a);
    // 対数で計算する（b がどれだけ大きくても、b が小数でも壊れない）
    const E = A.e * n;
    const Ei = Math.floor(E);
    const l = n * Math.log10(Math.abs(A.m)) + (E - Ei);
    const k = Math.floor(l);
    return sci(Math.pow(10, l - k), Ei + k);
  }

  // 割合をかける（部分点など）
  function scale(v, f) {
    if (!isSci(v)) return Math.floor(v * f);
    return sci(v.m * f, v.e);
  }

  /* ---------------- 比較 ---------------- */

  function log10(v) {
    if (!isSci(v)) return v > 0 ? Math.log10(v) : -Infinity;
    return v.m > 0 ? v.e + Math.log10(v.m) : -Infinity;
  }

  function cmp(a, b) {
    if (!isSci(a) && !isSci(b)) return a === b ? 0 : a < b ? -1 : 1;
    const la = log10(a), lb = log10(b);
    return la === lb ? 0 : la < lb ? -1 : 1;
  }

  // 答え合わせ用。3e12 と 30e11 のような書き方の違いは同じ値として扱う
  function eq(a, b) {
    if (!isSci(a) && !isSci(b)) return a === b;
    const A = toSci(a), B = toSci(b);
    if (!isFinite(A.m) || !isFinite(B.m)) return false;
    const etol = Math.max(1e-9 * Math.abs(A.e), 1e-9);
    if (Math.abs(A.e - B.e) > etol) return false;
    return Math.abs(A.m - B.m) <= 1e-6 * Math.max(1, Math.abs(A.m));
  }

  /* ---------------- 表示 ---------------- */

  // 表示用に有効数字を丸める。丸めた結果 10 になったら桁を繰り上げる
  function round6(v) {
    let m = parseFloat(v.m.toPrecision(6));
    let e = v.e;
    if (Math.abs(m) >= 10) { m /= 10; e += 1; }
    return { m, e };
  }

  function expStr(e) {
    const r = Math.round(e);
    if (Math.abs(r) < EXP_SCI) return r.toLocaleString('en-US');
    return `(${fmt(sci(e, 0))})`;             // 指数自体も科学記数法で
  }

  function fmt(v) {
    if (!isSci(v)) {
      if (!isFinite(v)) return '∞';
      if (Math.abs(v) < 1e15) return v.toLocaleString('en-US');
      v = toSci(v);
    }
    if (!isFinite(v.m)) return '?';
    if (v.m === 0) return '0';
    const r = round6(v);
    return `${r.m} × 10^${expStr(r.e)}`;
  }

  function expHtml(e) {
    const r = Math.round(e);
    if (Math.abs(r) < EXP_SCI) return r.toLocaleString('en-US');
    return html(sci(e, 0));
  }

  // <sup> を使った表示（式や結果画面用）
  function html(v) {
    if (!isSci(v)) {
      if (!isFinite(v)) return '∞';
      if (Math.abs(v) < 1e15) return v.toLocaleString('en-US');
      v = toSci(v);
    }
    if (!isFinite(v.m)) return '?';
    if (v.m === 0) return '0';
    const r = round6(v);
    return `${r.m}×10<sup>${expHtml(r.e)}</sup>`;
  }

  // 10^10^x の x（目標達成度をはかる物差し）
  function tower(v) {
    const l = log10(v);
    return l > 0 ? Math.log10(l) : -Infinity;
  }

  /* ---------------- 入力の解釈 ---------------- */

  // "1234" / "3e12" / "2.5E30" / "1e1e100"（指数自体も e 記法）を読む
  function parse(text) {
    const t = String(text).trim();
    if (!t || !/^[0-9.eE+-]+$/.test(t)) return null;
    const i = t.search(/[eE]/);
    if (i < 0) {
      const n = Number(t);
      return isFinite(n) ? n : null;
    }
    const head = t.slice(0, i);
    const tail = t.slice(i + 1);
    const m = head === '' ? 1 : Number(head);
    let e = parse(tail);
    if (e === null || !isFinite(m)) return null;
    if (isSci(e)) e = e.m * Math.pow(10, e.e);   // 指数は Number に戻す
    if (!isFinite(e)) return null;
    return sci(m, e);
  }

  return { isSci, sci, toSci, num, add, sub, mul, div, pow, scale,
           log10, cmp, eq, fmt, html, tower, parse };
})();
