'use strict';

/* =====================================================================
 * 計算するインクリメンタルゲーム（仮）
 *
 * コアループ： 計算 → 報酬を得る → アップグレード → そしてまた計算
 *
 * 報酬 = ( floor(log10(正解した答えの合計)) + 演算ボーナス ) × 倍率
 * ===================================================================== */

const SAVE_KEY = 'keisan-incremental-v1';

/* ---------------------------------------------------------------
 * 演算の定義
 * ------------------------------------------------------------- */
const OPS = {
  add: { id: 'add', label: 'たし算', symbol: '+' },
  sub: { id: 'sub', label: 'ひき算', symbol: '−' },
  mul: { id: 'mul', label: 'かけ算', symbol: '×' },
  div: { id: 'div', label: 'わり算', symbol: '÷' },
  pow: { id: 'pow', label: 'べき乗', symbol: '^' },
};
const OP_ORDER = ['add', 'sub', 'mul', 'div', 'pow'];

/* ---------------------------------------------------------------
 * セーブされる状態
 * ------------------------------------------------------------- */
function newState() {
  return {
    points: 0,
    runEarned: 0,    // この周回で獲得した T の合計（転生時の Σ 計算に使う）
    digits: 1,     // 出題される数字の桁数
    terms: 2,      // たし算1問あたりの数字の個数（ひき算・わり算は常に2個）
    mulTerms: 2,   // かけ算の1問あたりの数字の個数
    powLevel: 0,   // べき乗の指数アップ（a^b の b を大きくする）
    problems: 3,   // 1ラウンドの出題数
    multLevel: 0,    // 報酬倍率レベル
    logBase: 10,     // 報酬に使う対数の底（下げるほど報酬が伸びる）
    comboLevel: 0,    // 連続正解ボーナス
    combo: 0,         // いまの連続正解数
    allIn: false,     // 一発勝負を解放したか
    allInCut: 0,      // 出題数を何問減らすか
    interestLevel: 0, // ラウンドごとの利息
    expRewardLevel: 0,// 基礎値を累乗する
    auto: false,      // オート計算を解放したか
    autoOn: true,     // オート計算の入/切
    autoSpeed: 0,     // オートの速さ
    autoRound: false, // ラウンドを自動で続けるか
    manual: false,   // 出題される数字を自分で決められるか
    manualLog: null, // 決めた大きさ（10^これ）。null なら自動
    sciMode: false,  // 指数表記（科学記数法）で出題されるか
    expLevel: 0,     // 指数スケール。出題される数字は 10^(n × 10^expOrder)
    perfectLevel: 0, // 全問正解ボーナス
    partialLevel: 0, // 不正解でも答えの一部が合計に入る
    challenge: null, // 挑戦中のチャレンジ（転生すると終わる）
    chBest: 0,       // チャレンジ中の1ラウンドの合計の最高（log10）
    unlocked: { add: true, sub: false, mul: false, div: false, pow: false },
    enabled:  { add: true, sub: false, mul: false, div: false, pow: false },
    // ---- ここから下は転生しても引き継がれる ----
    sigma: 0,        // 所持Σ（永続強化に使う）
    sigmaTotal: 0,   // 累計Σ（報酬ボーナスの基準）
    perm: {
      sigmaPower: 0,    // Σ1つあたりの報酬ボーナス
      baseBoost: 0,     // 報酬の基礎値に足す分
      startCash: 0,     // 転生後の持ち込みTポイント（10^n）
      keep: 0,          // 転生しても失わないものの段階
      startDigits: 0,   // 開始時の桁数
      startProblems: 0, // 開始時の出題数
      sigmaExp: 0,      // Σの累乗：基礎値の累乗が増える
      skip: 0,          // 飛び級：指数表記・指数スケールを持って始める
      expMul: 0,        // 指数ブースト：出題される数字の指数を何倍にするか
      powExp: 0,        // べき乗の指数：a^b の b を大きくする
      expEff: 0,        // 指数的報酬の効率
      expDiscount: 0,   // 指数まわりのアップグレードの値引き
    },
    stats: { rounds: 0, earned: 0, correct: 0, answered: 0, best: 0, prestiges: 0,
             bestTower: -Infinity, goal: false, goalTier: 0,
             perfects: 0, bestStreak: 0, bought: 0 },
    ach: {},         // 達成した実績（転生・振り直しでも消えない）
    chDone: {},      // クリアしたチャレンジ（転生・振り直しでも消えない）
    lab: { done: {}, cur: null },               // 研究（転生・振り直しでも消えない）
    look: { theme: 'default', effect: 'flash' }, // 着せ替え（転生・振り直しでも消えない）
  };
}

let state = newState();

/* ---------------------------------------------------------------
 * 計算式まわりのルール
 * ------------------------------------------------------------- */
// 最終目標： 1ラウンドの合計が 10^(10^100) を超えること
const GOAL_TOWER = 100;           // log10(log10(合計)) がこの値を超えたら達成

/* 目標の先。10^10^100 を超えたあとも、合計 10^10^x の x を目印に目標が続く。
 * 到達するたびに称号と Σ がもらえる（転生しても消えない）。
 * 数として扱えるのは 10^10^308 くらいまでなので、最後の目標は 10^10^250。
 * 「指数スケール」の上限もここに届くように合わせてある。 */
const GOAL_TIERS = [
  { tower: 100, title: '到達者',       sigma: 20 },
  { tower: 110, title: 'はみ出し者',   sigma: 30 },
  { tower: 120, title: '塔の住人',     sigma: 45 },
  { tower: 130, title: '雲の上',       sigma: 60 },
  { tower: 140, title: '成層圏',       sigma: 80 },
  { tower: 150, title: '中間圏',       sigma: 100 },
  { tower: 160, title: '熱圏',         sigma: 130 },
  { tower: 180, title: '外気圏',       sigma: 170 },
  { tower: 200, title: '月面',         sigma: 220 },
  { tower: 220, title: '太陽系の果て', sigma: 300 },
  { tower: 250, title: '数の果て',     sigma: 500 },
];

function goalTier(s)  { return s.stats.goalTier || 0; }
function nextTier(s)  { return GOAL_TIERS[goalTier(s)] || null; }
function tierTitle(s) { const t = GOAL_TIERS[goalTier(s) - 1]; return t ? t.title : null; }

// tower まで届いた目標をすべて達成済みにし、Σを渡す。新しく届いた目標を返す
function reachTiers(s, tower) {
  const got = [];
  while (goalTier(s) < GOAL_TIERS.length && tower >= GOAL_TIERS[goalTier(s)].tower) {
    const t = GOAL_TIERS[goalTier(s)];
    s.sigma += t.sigma;
    s.sigmaTotal += t.sigma;
    s.stats.goalTier = goalTier(s) + 1;
    got.push(t);
  }
  if (got.length) s.stats.goal = true;
  return got;
}

/* ---------------------------------------------------------------
 * チャレンジ
 *   制限つきで最初からやり直し、1ラウンドの合計が 10^goal に届けばクリア。
 *   クリアすると永続ボーナスと Σ がもらえる。
 *   「開始時の強化」（引き継ぎ・飛び級・持ち込み資金・英才教育・予習）は効かない。
 * ------------------------------------------------------------- */
const CHALLENGES = [
  { id: 'noAdd',     name: 'たし算なし', goal: 50,  sigma: 5,
    rule: 'たし算が出題されない（ひき算は最初から使える）',
    reward: 'ひき算を最初から持って始める' },
  { id: 'manual',    name: '手作業',     goal: 50,  sigma: 5,
    rule: 'オート計算が使えない',
    reward: 'オート計算の1問あたりの時間が ×0.7' },
  { id: 'oneShot',   name: '一問入魂',   goal: 100, sigma: 10,
    rule: '1ラウンドの出題が1問だけ',
    reward: '一発勝負の倍率が 1問あたり ×1.3 → ×1.5' },
  { id: 'strict',    name: '間違い厳禁', goal: 200, sigma: 10,
    rule: '1問でも間違えると、そのラウンドの報酬が 0',
    reward: 'パーフェクトボーナスが2倍' },
  { id: 'inflation', name: 'インフレ',   goal: 200, sigma: 15,
    rule: 'アップグレードの値段が10倍',
    reward: 'アップグレードの値段が 0.8倍' },
  { id: 'noMult',    name: '素の力',     goal: 500, sigma: 25,
    rule: '報酬倍率（倍率アップ・Σのボーナス）が効かない',
    reward: '報酬 ×2' },
];

function challengeOf(id)      { return CHALLENGES.find(c => c.id === id) || null; }
function inChallenge(s, id)   { return s.challenge === id; }
function cleared(s, id)       { return !!(s.chDone && s.chDone[id]); }
function clearedCount(s)      { return CHALLENGES.filter(c => cleared(s, c.id)).length; }
function opBanned(s, id)      { return id === 'add' && inChallenge(s, 'noAdd'); }
function canChallenge(s)      { return s.stats.prestiges >= 1; }

// 10^L の表示（大きすぎるときは 10^10^x の形）
function logGoalStr(L) {
  return L < 1e6 ? `10^${fmt(L)}` : towerStr(Math.log10(L));
}

// ラウンドの合計でチャレンジの達成を判定する。クリアしたらそのチャレンジを返す
function checkChallenge(s, sum) {
  const c = challengeOf(s.challenge);
  if (!c) return null;
  const L = V.log10(sum);
  if (L > s.chBest) s.chBest = L;
  if (L < c.goal) return null;
  s.chDone[c.id] = true;
  s.sigma += c.sigma;
  s.sigmaTotal += c.sigma;
  s.challenge = null;     // 制限が外れて、このまま続けられる
  return c;
}

const SIGMA_DIV = 100;            // Σ の計算に使う基準
const SIGMA_RATES = [0.25, 0.50, 1.00, 2.00, 4.00, 8.00];

// 獲得Tが10倍になるごとに +4Σ（桁が爆発しても破綻しないように log で数える）
const SIGMA_PER_DECADE = 4;

function sigmaBase(s) {
  if (V.cmp(s.runEarned, SIGMA_DIV) < 0) return 0;
  const decades = V.log10(s.runEarned) - Math.log10(SIGMA_DIV);
  return Math.floor(SIGMA_PER_DECADE * decades) + 1;
}
// 転生で受け取る Σ（研究の上乗せは、転生できるときだけ）
function sigmaGain(s) {
  const b = sigmaBase(s);
  return b >= 1 ? b + labSigmaBonus(s) : 0;
}
function sigmaNeed(s) {
  return Math.ceil(SIGMA_DIV * Math.pow(10, sigmaBase(s) / SIGMA_PER_DECADE));
}
function sigmaRate(s)    { return SIGMA_RATES[s.perm.sigmaPower]; }
function sigmaBonus(s)   { return sigmaRate(s) * s.sigmaTotal; }

/* 報酬の刻み。
 * ⌊log(合計)⌋ のままだと「桁が変わるまで1Tも増えない」ので、
 * 10倍の細かさで数える（= 合計が少し伸びただけでも報酬が増える）。 */
const REWARD_SCALE = 10;

// アップグレードの値段。報酬が10倍細かくなったぶん、ここも引き上げる
const COST_SCALE = 5;
function costOf(def, s) {
  const f = COST_SCALE * (inChallenge(s, 'inflation') ? 10 : 1) * (cleared(s, 'inflation') ? 0.8 : 1);
  const c = V.mul(def.cost(s), f);
  return V.isSci(c) ? c : Math.ceil(c - 1e-9);
}

function multiplier(s) {
  if (inChallenge(s, 'noMult')) return 1;
  return 1 + 0.5 * s.multLevel + sigmaBonus(s);
}
// アップグレードとは別にかかる倍率（チャレンジ「素の力」のクリア報酬・研究）
function bonusMult(s) {
  if (inChallenge(s, 'noMult')) return 1;
  return (cleared(s, 'noMult') ? 2 : 1) * labRewardMult(s);
}
function enabledOps(s) {
  return OP_ORDER.filter(id => s.unlocked[id] && s.enabled[id] && !opBanned(s, id));
}
function varietyBonus(s) { return REWARD_SCALE * Math.max(0, enabledOps(s).length - 1); }
function partialRate(s)  { return [0, 0.25, 0.5, 0.75][s.partialLevel] || 0; }
function perfectBonus(s, perfect) {
  return perfect ? REWARD_SCALE * s.perfectLevel * (cleared(s, 'strict') ? 2 : 1) : 0;
}

// ⌊log_b(sum)⌋ を整数演算で正確に求める（巨大な合計でもズレない）
function baseFromSum(sum, s) {
  const b = s.logBase;
  const l = V.log10(sum);
  if (!isFinite(l) || l < 0) return 0;
  // log を REWARD_SCALE 倍の細かさで数える（端数は切り捨て）
  return Math.floor(l / Math.log10(b) * REWARD_SCALE + 1e-9);
}

// 1問の貢献分（不正解でも部分点があれば一部が合計に入る）
function contribution(p, s) {
  if (p.correct) return p.answer;
  const rate = partialRate(s);
  return rate ? V.scale(p.answer, rate) : 0;
}

const BASE_BOOST_STEP = 5 * REWARD_SCALE;   // 1レベル = 合計が 5 桁ぶん大きいのと同じ
function permBoost(s) { return BASE_BOOST_STEP * ((s.perm && s.perm.baseBoost) || 0); }

/* ---- 4つの「伸ばし方」---- */

// ① 連続正解：切らさないほど倍率が伸びる。1問でも間違えると 0 に戻る
function comboCap(s)  { return 20 * (s.comboLevel || 0); }
function comboCount(s){ return Math.min(s.combo || 0, comboCap(s)); }
function comboMult(s) { return s.comboLevel ? 1 + 0.05 * comboCount(s) : 1; }

// ② 一発勝負：1ラウンドの問題を減らすほど倍率が上がる
function roundSize(s) {
  if (inChallenge(s, 'oneShot')) return 1;
  return Math.max(1, s.problems - (s.allInCut || 0));
}
function allInMult(s) {
  if (inChallenge(s, 'oneShot')) return 1;   // もともと1問なので、減らしたことにはならない
  return 1 + (cleared(s, 'oneShot') ? 0.5 : 0.3) * (s.allInCut || 0);
}

// ③ 利息：ラウンドが終わるたびに所持Tが増える
function interestRate(s) { return 0.02 * (s.interestLevel || 0); }

// ④ 指数的報酬：基礎値そのものを累乗する（桁が大きいほど効く）
function expRewardPow(s) {
  return 1 + expRewardStep(s) * (s.expRewardLevel || 0) + 0.1 * ((s.perm && s.perm.sigmaExp) || 0);
}
// 「指数的報酬」1レベルで増える累乗（永続強化「指数的報酬の効率」で伸びる）
function expRewardStep(s) { return 0.05 * (1 + 0.5 * ((s.perm && s.perm.expEff) || 0)); }
// 出題される数字の指数にかかる倍率（永続強化「指数ブースト」）
function expMul(s) { return 1 + ((s.perm && s.perm.expMul) || 0); }
// 指数まわりのアップグレードの値引き（永続強化「指数の値引き」）
function discounted(cost, factor, lv) {
  if (!lv) return cost;
  const c = V.div(cost, V.pow(factor, lv));
  return V.cmp(c, 1) < 0 ? 1 : (V.isSci(c) ? c : Math.max(1, Math.round(c)));
}
function hasPowBoost(s) { return expRewardPow(s) > 1; }
function boostedBase(sum, s) {
  const b = baseFromSum(sum, s);
  if (!hasPowBoost(s) || b <= 1) return b;
  return V.pow(b, expRewardPow(s));   // 1e308 を超えても V が受け止める
}

function rewardFor(sum, s, perfect) {
  if (inChallenge(s, 'strict') && !perfect) return 0;
  const extra = varietyBonus(s) + perfectBonus(s, perfect) + permBoost(s);
  const raw = V.add(boostedBase(sum, s), extra);
  const gain = V.scale(raw, multiplier(s) * bonusMult(s) * comboMult(s) * allInMult(s));
  return V.cmp(gain, 0) > 0 ? gain : 0;
}

/* ---------------------------------------------------------------
 * アップグレード定義
 *   level / cost / now / next / apply をもつオブジェクトを並べるだけで
 *   新しいアップグレードを追加できる。
 * ------------------------------------------------------------- */
const UPGRADES = [
  {
    id: 'digits',
    name: '桁数アップ',
    max: 8,
    level: s => s.digits,
    cost:  s => Math.round(Math.pow(3, s.digits - 1)),   // 1, 3, 9, 27 …
    now:   s => (s.manualLog !== null
      ? `${s.digits} 桁（いまは「数字の直接指定」が優先されています）`
      : `${s.digits} 桁の数字が出題される`),
    next:  s => `${s.digits + 1} 桁の数字が出題される`,
    apply: s => { s.digits += 1; },
  },
  {
    id: 'manual',
    name: '数字の直接指定',
    max: 1,
    level: s => (s.manual ? 1 : 0),
    cost:  () => 10,
    now:   s => (s.manual
      ? '計算画面で、式の端数をきりよくできる'
      : '出題された式はそのまま解くしかない'),
    next:  () => '出ている式の端数をきりよくして、計算を楽にできるようになる',
    apply: s => { s.manual = true; },
  },
  {
    id: 'sub',
    name: 'ひき算 解放',
    max: 1,
    level: s => (s.unlocked.sub ? 1 : 0),
    cost:  () => 5,
    now:   s => (s.unlocked.sub ? 'ひき算が使える' : 'たし算しか出題されない'),
    next:  () => 'ひき算が出題に加わる（演算ボーナス +1）',
    apply: s => { s.unlocked.sub = true; s.enabled.sub = true; },
  },
  {
    id: 'problems',
    name: '出題数アップ',
    max: 8,
    level: s => s.problems,
    cost:  s => Math.round(8 * Math.pow(3.5, s.problems - 3)),
    now:   s => `1ラウンド ${s.problems} 問`,
    next:  s => `1ラウンド ${s.problems + 1} 問`,
    apply: s => { s.problems += 1; },
  },
  {
    id: 'terms',
    name: '項数アップ',
    max: 5,
    level: s => s.terms,
    cost:  s => Math.round(12 * Math.pow(4, s.terms - 2)),
    now:   s => `たし算の1問に数字が ${s.terms} 個（ほかの演算には効かない）`,
    next:  s => `たし算の1問に数字が ${s.terms + 1} 個`,
    apply: s => { s.terms += 1; },
  },
  {
    id: 'mult',
    name: '報酬倍率アップ',
    max: 20,
    level: s => s.multLevel,
    cost:  s => Math.round(15 * Math.pow(3, s.multLevel)),
    now:   s => `獲得Tポイント ×${multiplier(s).toFixed(1)}`,
    next:  s => `獲得Tポイント ×${(multiplier(s) + 0.5).toFixed(1)}`,
    apply: s => { s.multLevel += 1; },
  },
  {
    id: 'mul',
    name: 'かけ算 解放',
    max: 1,
    level: s => (s.unlocked.mul ? 1 : 0),
    cost:  () => 20,
    now:   s => (s.unlocked.mul ? 'かけ算が使える' : 'かけ算は出題されない'),
    next:  () => 'かけ算が出題に加わる（演算ボーナス +1・桁が一気に増える）',
    apply: s => { s.unlocked.mul = true; s.enabled.mul = true; },
  },
  {
    id: 'mulTerms',
    name: 'かけ算の項数アップ',
    max: 6,
    requires: s => s.unlocked.mul,
    lockedNote: '「かけ算 解放」を買うと購入できる',
    level: s => s.mulTerms,
    cost:  s => Math.round(30 * Math.pow(4, s.mulTerms - 2)),
    now:   s => `かけ算は1問に数字が ${s.mulTerms} 個`,
    next:  s => `かけ算は1問に数字が ${s.mulTerms + 1} 個（答えの桁がさらに伸びる）`,
    apply: s => { s.mulTerms += 1; },
  },
  {
    id: 'partial',
    name: '部分点',
    max: 3,
    level: s => s.partialLevel,
    cost:  s => Math.round(25 * Math.pow(4, s.partialLevel)),
    now:   s => (s.partialLevel
      ? `不正解でも答えの ${partialRate(s) * 100}% が合計に入る`
      : '不正解の問題は合計に入らない'),
    next:  s => `不正解でも答えの ${[25, 50, 75][s.partialLevel]}% が合計に入る`,
    apply: s => { s.partialLevel += 1; },
  },
  {
    id: 'perfect',
    name: 'パーフェクトボーナス',
    max: 5,
    level: s => s.perfectLevel,
    cost:  s => Math.round(30 * Math.pow(3, s.perfectLevel)),
    now:   s => (s.perfectLevel
      ? `全問正解で基礎値 +${s.perfectLevel}`
      : '全問正解してもボーナスなし'),
    next:  s => `全問正解で基礎値 +${s.perfectLevel + 1}`,
    apply: s => { s.perfectLevel += 1; },
  },
  {
    id: 'div',
    name: 'わり算 解放',
    max: 1,
    level: s => (s.unlocked.div ? 1 : 0),
    cost:  () => 40,
    now:   s => (s.unlocked.div ? 'わり算が使える' : 'わり算は出題されない'),
    next:  () => 'わり算が出題に加わる（必ず割り切れる・演算ボーナス +1）',
    apply: s => { s.unlocked.div = true; s.enabled.div = true; },
  },
  {
    id: 'pow',
    name: 'べき乗 解放',
    max: 1,
    level: s => (s.unlocked.pow ? 1 : 0),
    cost:  () => 300,
    now:   s => (s.unlocked.pow ? 'べき乗が使える' : 'べき乗は出題されない'),
    next:  () => 'a^b が出題に加わる（答えの桁が一気に伸びる・演算ボーナス +1）',
    apply: s => { s.unlocked.pow = true; s.enabled.pow = true; },
  },
  {
    id: 'powK',
    name: 'べき乗の指数アップ',
    max: Infinity,                       // 上限なし
    requires: s => s.unlocked.pow,
    lockedNote: '「べき乗 解放」を買うと購入できる',
    level: s => s.powLevel,
    cost:  s => powKCost(s.powLevel),
    now:   s => `a^b の b が ${powRange(s).join('〜')}`,
    next:  s => `b が ${powRange({ powLevel: s.powLevel + 1 }).join('〜')} になる（指数表記のときも +${s.powLevel + 1}）`,
    apply: s => { s.powLevel += 1; },
  },
  {
    id: 'logbase',
    name: '対数の底を下げる',
    max: 8,                       // 10 → 2 まで
    level: s => 10 - s.logBase,
    cost:  s => Math.round(50 * Math.pow(4, 10 - s.logBase)),
    now:   s => `報酬の基礎値は ⌊log${sub10(s.logBase)}(合計) × ${REWARD_SCALE}⌋`,
    next:  s => `基礎値が ⌊log${sub10(s.logBase - 1)}(合計) × ${REWARD_SCALE}⌋ になり、同じ合計でも報酬が増える`,
    apply: s => { s.logBase -= 1; },
  },
  {
    id: 'combo',
    name: '連続正解ボーナス',
    max: 5,
    level: s => s.comboLevel,
    cost:  s => Math.round(200 * Math.pow(3, s.comboLevel)),
    now:   s => (s.comboLevel
      ? `連続正解1つにつき報酬 +5%（最大 ${comboCap(s)} 連鎖 = +${comboCap(s) * 5}%）`
      : '連続正解しても何も起きない'),
    next:  s => `最大 ${20 * (s.comboLevel + 1)} 連鎖まで伸びる（+${20 * (s.comboLevel + 1) * 5}%）`,
    apply: s => { s.comboLevel += 1; },
  },
  {
    id: 'interest',
    name: '利息',
    max: 10,
    level: s => s.interestLevel,
    cost:  s => Math.round(300 * Math.pow(2.5, s.interestLevel)),
    now:   s => (s.interestLevel
      ? `ラウンドが終わるたび、所持Tポイントが +${(interestRate(s) * 100).toFixed(0)}%`
      : '所持Tポイントは増えない'),
    next:  s => `ラウンドごとに所持Tポイントが +${((s.interestLevel + 1) * 2)}%`,
    apply: s => { s.interestLevel += 1; },
  },
  {
    id: 'allIn',
    name: '一発勝負',
    max: 1,
    level: s => (s.allIn ? 1 : 0),
    cost:  () => 400,
    now:   s => (s.allIn ? '1ラウンドの問題数を減らして倍率を上げられる' : '問題数は減らせない'),
    next:  () => '1問減らすごとに報酬 ×1.3（計算画面で切り替え）',
    apply: s => { s.allIn = true; },
  },
  {
    id: 'expReward',
    name: '指数的報酬',
    max: Infinity,                       // 上限なし
    level: s => s.expRewardLevel,
    cost:  s => discounted(V.mul(800, V.pow(5, s.expRewardLevel)), 5, s.perm.expDiscount),
    now:   s => (hasPowBoost(s)
      ? `報酬の基礎値が ${expRewardPow(s).toFixed(2)} 乗される（上限なし）`
      : '報酬の基礎値はそのまま'),
    next:  s => `基礎値が ${(expRewardPow(s) + expRewardStep(s)).toFixed(3).replace(/0$/, '')} 乗される（桁が大きいほど効く）`,
    apply: s => { s.expRewardLevel += 1; },
  },
  {
    id: 'auto',
    name: 'オート計算',
    max: 1,
    level: s => (s.auto ? 1 : 0),
    cost:  () => 250,
    now:   s => (s.auto ? `${(autoDelay(s) / 1000).toFixed(1)} 秒に1問、自動で解く` : '自分で解くしかない'),
    next:  () => '出題された式を自動で解いてくれるようになる（3.0 秒に1問）',
    apply: s => { s.auto = true; s.autoOn = true; },
  },
  {
    id: 'autoSpeed',
    name: 'オート速度',
    max: 8,
    level: s => s.autoSpeed,
    cost:  s => Math.round(150 * Math.pow(2.5, s.autoSpeed)),
    now:   s => (s.auto ? `${(autoDelay(s) / 1000).toFixed(1)} 秒に1問` : '「オート計算」を買うと効きはじめる'),
    next:  s => `${(autoDelay(Object.assign({}, s, { autoSpeed: s.autoSpeed + 1 })) / 1000).toFixed(1)} 秒に1問になる`,
    apply: s => { s.autoSpeed += 1; },
  },
  {
    id: 'autoRound',
    name: 'オート周回',
    max: 1,
    level: s => (s.autoRound ? 1 : 0),
    cost:  () => 1000,
    now:   s => (s.autoRound ? 'ラウンドが終わると自動で次を始める' : 'ラウンドごとに自分で始める'),
    next:  () => 'ラウンドが終わると自動で次のラウンドを始める（放っておける）',
    apply: s => { s.autoRound = true; },
  },
  {
    id: 'sci',
    name: '指数表記',
    max: 1,
    level: s => (s.sciMode ? 1 : 0),
    cost:  () => 2000,
    now:   s => (s.sciMode ? '数字が m × 10ⁿ の形で出題される' : 'ふつうの数字で出題される'),
    next:  () => '数字が m × 10ⁿ の形になり、「指数スケール」で桁を無限に伸ばせる',
    apply: s => { s.sciMode = true; },
  },
  {
    id: 'expScale',
    name: '指数スケール',
    max: 22,                      // p = 254。最後の目標 10^10^250 に届く大きさ
    level: s => s.expLevel,
    cost:  s => discounted(Math.round(8000 * Math.pow(10, expOrder(s))), 1000, s.perm.expDiscount),
    now:   s => (s.manualLog !== null
      ? `10^(n × 10^${expOrder(s)}) 規模（いまは「数字の直接指定」が優先されています）`
      : s.sciMode
        ? `出題される数字は 10^(n × 10^${expOrder(s)}) 規模`
        : '「指数表記」を買うと効きはじめる'),
    next:  s => `10^(n × 10^${expOrder({ expLevel: s.expLevel + 1 })}) 規模になる`,
    apply: s => { s.expLevel += 1; },
  },
];

const KEEP_STEPS = [
  '演算の解放（ひき算・かけ算・わり算・べき乗）',
  'オート計算ひとそろい（速度・周回も）',
  '対数の底',
  '報酬倍率のレベル',
  '桁数・項数・かけ算の項数・出題数',
  '指数表記・指数スケール・指数的報酬',
  'ほかのアップグレード全部（部分点・パーフェクト・連続正解・利息・一発勝負・直接指定）',
];

const PERKS = [
  {
    id: 'keep',
    name: '引き継ぎ',
    max: KEEP_STEPS.length,
    level: s => s.perm.keep,
    cost:  s => [1, 3, 8, 20, 40, 80, 160][s.perm.keep],
    now:   s => (s.perm.keep
      ? `転生しても残る: ${KEEP_STEPS.slice(0, s.perm.keep).join(' / ')}`
      : '転生すると強化はすべて失われる'),
    next:  s => `転生しても ${KEEP_STEPS[s.perm.keep]} が残るようになる`,
    apply: s => { s.perm.keep += 1; },
  },
  {
    id: 'startCash',
    name: '持ち込み資金',
    max: 20,
    level: s => s.perm.startCash,
    cost:  s => Math.round(2 * Math.pow(2, s.perm.startCash)),
    now:   s => (s.perm.startCash
      ? `転生した直後に ${fmt(startCashOf(s.perm.startCash))} T を持って始める`
      : '転生したら 0 T から'),
    next:  s => `転生した直後に ${fmt(startCashOf(s.perm.startCash + 1))} T を持って始める（いま買うとすぐ受け取れる）`,
    apply: s => {
      s.perm.startCash += 1;
      s.points = V.add(s.points, startCashOf(s.perm.startCash));   // 買った分は今すぐ受け取れる
    },
  },
  {
    id: 'baseBoost',
    name: '基礎値の底上げ',
    max: 20,
    level: s => s.perm.baseBoost,
    cost:  s => Math.round(2 * Math.pow(1.6, s.perm.baseBoost)),
    now:   s => (s.perm.baseBoost
      ? `報酬の基礎値に +${permBoost(s)}（合計が ${5 * s.perm.baseBoost} 桁ぶん大きいのと同じ）`
      : '報酬は ⌊log(合計)⌋ のぶんだけ'),
    next:  s => `報酬の基礎値に +${BASE_BOOST_STEP * (s.perm.baseBoost + 1)}`,
    apply: s => { s.perm.baseBoost += 1; },
  },
  {
    id: 'power',
    name: 'Σの力',
    max: SIGMA_RATES.length - 1,
    level: s => s.perm.sigmaPower,
    cost:  s => [2, 6, 15, 40, 100][s.perm.sigmaPower],
    now:   s => `Σ 1つにつき 報酬 +${(sigmaRate(s) * 100).toFixed(0)}%（いま ×${multiplier(s).toFixed(2)}）`,
    next:  s => `Σ 1つにつき 報酬 +${(SIGMA_RATES[s.perm.sigmaPower + 1] * 100).toFixed(0)}%`,
    apply: s => { s.perm.sigmaPower += 1; },
  },
  {
    id: 'startDigits',
    name: '英才教育',
    max: 7,
    level: s => s.perm.startDigits,
    cost:  s => [1, 2, 4, 8, 15, 30, 60][s.perm.startDigits],
    now:   s => `開始時の桁数 ${1 + s.perm.startDigits} 桁`,
    next:  s => `開始時の桁数 ${2 + s.perm.startDigits} 桁`,
    apply: s => { s.perm.startDigits += 1; },
  },
  {
    id: 'startProblems',
    name: '予習',
    max: 5,
    level: s => s.perm.startProblems,
    cost:  s => [1, 3, 6, 12, 25][s.perm.startProblems],
    now:   s => `開始時の出題数 ${3 + s.perm.startProblems} 問`,
    next:  s => `開始時の出題数 ${4 + s.perm.startProblems} 問`,
    apply: s => { s.perm.startProblems += 1; },
  },
  {
    id: 'sigmaExp',
    name: 'Σの累乗',
    max: 20,
    level: s => s.perm.sigmaExp,
    cost:  s => Math.round(5 * Math.pow(1.8, s.perm.sigmaExp)),
    now:   s => (s.perm.sigmaExp
      ? `報酬の基礎値が さらに +${(0.1 * s.perm.sigmaExp).toFixed(1)} 乗される（いま ${expRewardPow(s).toFixed(2)} 乗）`
      : '基礎値の累乗は「指数的報酬」だけ'),
    next:  s => `基礎値の累乗が +0.1（「指数的報酬」2つぶん。桁が大きいほど爆発的に効く）`,
    apply: s => { s.perm.sigmaExp += 1; },
  },
  {
    id: 'skip',
    name: '飛び級',
    max: 6,
    level: s => s.perm.skip,
    cost:  s => [10, 25, 60, 140, 300, 600][s.perm.skip],
    now:   s => (s.perm.skip
      ? `転生直後から「指数表記」つき・指数スケール Lv.${s.perm.skip - 1} で始まる`
      : '転生すると指数表記からやり直し'),
    next:  s => (s.perm.skip
      ? `開始時の指数スケールが Lv.${s.perm.skip} になる`
      : '転生直後から「指数表記」を持って始める（買った瞬間にも効く）'),
    apply: s => { s.perm.skip += 1; },
  },
  {
    id: 'expMul',
    name: '指数ブースト',
    max: 10,
    level: s => s.perm.expMul,
    cost:  s => Math.round(8 * Math.pow(2, s.perm.expMul)),
    now:   s => (s.perm.expMul
      ? `指数表記の数字の指数が ×${expMul(s)}（10^n が 10^(${expMul(s)}n) になる）`
      : '指数表記の数字の指数はそのまま'),
    next:  s => `指数が ×${expMul(s) + 1} になる（「指数表記」を持っているときに効く）`,
    apply: s => { s.perm.expMul += 1; },
  },
  {
    id: 'powExp',
    name: 'べき乗の指数',
    max: 5,
    level: s => s.perm.powExp,
    cost:  s => [6, 15, 35, 80, 180][s.perm.powExp],
    now:   s => {
      const k = 3 * s.perm.powExp;
      return `指数表記のべき乗 a^b で、b が ${2 + k}〜${5 + k}`;
    },
    next:  s => {
      const k = 3 * (s.perm.powExp + 1);
      return `b が ${2 + k}〜${5 + k} になる（答えの指数が b 倍に伸びる）`;
    },
    apply: s => { s.perm.powExp += 1; },
  },
  {
    id: 'expEff',
    name: '指数的報酬の効率',
    max: 6,
    level: s => s.perm.expEff,
    cost:  s => Math.round(10 * Math.pow(2, s.perm.expEff)),
    now:   s => `アップグレード「指数的報酬」1レベルで +${expRewardStep(s).toFixed(3).replace(/0$/, '')} 乗`,
    next:  s => `1レベルで +${(0.05 * (1 + 0.5 * (s.perm.expEff + 1))).toFixed(3).replace(/0$/, '')} 乗になる（買ってあるレベルにも効く）`,
    apply: s => { s.perm.expEff += 1; },
  },
  {
    id: 'expDiscount',
    name: '指数の値引き',
    max: 5,
    level: s => s.perm.expDiscount,
    cost:  s => [5, 12, 30, 70, 160][s.perm.expDiscount],
    now:   s => (s.perm.expDiscount
      ? `「指数スケール」が 1/${fmt(Math.pow(1000, s.perm.expDiscount))}、「指数的報酬」が 1/${fmt(Math.pow(5, s.perm.expDiscount))} の値段`
      : '指数まわりのアップグレードは定価'),
    next:  s => `「指数スケール」1/${fmt(Math.pow(1000, s.perm.expDiscount + 1))}・「指数的報酬」1/${fmt(Math.pow(5, s.perm.expDiscount + 1))} の値段になる`,
    apply: s => { s.perm.expDiscount += 1; },
  },
];

// 持ち込み資金 Lv.n で受け取る T（10^(3n)）
function startCashOf(n) { return n ? V.pow(10, 3 * n) : 0; }

// 永続強化を今の状態に反映する（購入時と転生直後に呼ぶ）
function applyPerm(s) {
  // チャレンジ中は「開始時の強化」が効かない
  if (!s.challenge) {
    s.digits = Math.max(s.digits, 1 + s.perm.startDigits);
    s.problems = Math.max(s.problems, 3 + s.perm.startProblems);
    if (s.perm.skip) {
      s.sciMode = true;
      s.expLevel = Math.max(s.expLevel, s.perm.skip - 1);
    }
  }
  // 「たし算なし」はひき算から始まる。クリアすると、いつでもひき算を持って始められる
  if (inChallenge(s, 'noAdd') || cleared(s, 'noAdd')) {
    if (!s.unlocked.sub) s.enabled.sub = true;
    s.unlocked.sub = true;
  }
}

// 下付き数字（log の底の表示用）
function sub10(n) {
  return String(n).split('').map(c => '₀₁₂₃₄₅₆₇₈₉'[Number(c)]).join('');
}

/* ---------------------------------------------------------------
 * 出題
 * ------------------------------------------------------------- */
/* 「べき乗の指数アップ」の値段（上限なしなので、先に行くほど急に高くなる）
 *   Lv.0〜9  ：×2.5 ずつ（375 T から）
 *   Lv.10 から：さらに1レベルごとに上がり幅が大きくなる（×10、×12.6、×15.8 …）
 * 効果（答えの桁）はレベルに比例して伸びるだけなので、値段の伸びがいずれ必ず追い越す。 */
function powKCost(L) {
  const early = 150 * Math.pow(2.5, Math.min(L, 10));
  const over = Math.max(0, L - 10);
  if (!over) return Math.round(early);
  const extraLog = over + 0.05 * over * (over - 1);   // 10 の何乗ぶん上乗せするか
  const c = V.mul(Math.round(early), V.pow(10, extraLog));
  return V.isSci(c) ? c : Math.round(c);
}

// ふつうの数字のべき乗で出る b の範囲
function powRange(s) {
  const L = s.powLevel || 0;
  return [2 + L, 3 + 2 * L];
}

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function randNumber(digits) {
  const lo = digits === 1 ? 1 : Math.pow(10, digits - 1);
  const hi = Math.pow(10, digits) - 1;
  return randInt(lo, hi);
}

// 掛け合わせた値が安全な整数の範囲を超えないよう、項を減らす
function safeProduct(list) {
  const used = [list[0]];
  let acc = list[0];
  for (let i = 1; i < list.length; i++) {
    if (acc * list[i] > Number.MAX_SAFE_INTEGER) break;
    acc *= list[i];
    used.push(list[i]);
  }
  return { used, product: acc };
}

// 指数スケール Lv.L のとき、指数は n × 10^expOrder(L)
function expOrder(s) { const L = s.expLevel; return 1 + L * (L + 1) / 2; }

/* 出題される数字の大きさ。
 * 手動設定（manualLog）があればそれを優先し、なければアップグレードの値を使う。 */
function intDigits(s) {
  if (s.manualLog === null) return s.digits;
  return Math.max(1, Math.min(15, Math.floor(s.manualLog) + 1));
}
function randExp(s) {
  if (s.manualLog !== null) return s.manualLog;
  return randInt(1, 9) * Math.pow(10, expOrder(s)) * expMul(s);
}
function randSci(s)  { return V.sci(randInt(1, 9), randExp(s)); }

// いまの出題の大きさを 10^x の x で表したもの
function currentLog(s) {
  if (s.manualLog !== null) return s.manualLog;
  return s.sciMode ? 5 * Math.pow(10, expOrder(s)) * expMul(s) : s.digits;
}

// その大きさで1ラウンド解いたときの報酬のおおよその値
function estimateGain(L, s) {
  const stacks = s.enabled.mul ? s.mulTerms : 1;
  const base = (L * stacks) / Math.log10(s.logBase);
  const raw = base + varietyBonus(s) + s.perfectLevel + permBoost(s);
  const g = Math.floor(raw * multiplier(s));
  return isFinite(g) ? Math.max(0, g) : Infinity;
}

/* 大きさを L に設定する値段。
 * 0 にしてあるので、どんな大きさでもタダで指定できる＝好きなだけ壊せる。
 * 値段を復活させたいときは、この係数を 12 くらいに戻す。 */
const MANUAL_COST_RATE = 0;

function manualCost(L, s) {
  const cur = currentLog(s);
  if (!(L > cur) || MANUAL_COST_RATE === 0) return 0;
  const diff = estimateGain(L, s) - estimateGain(cur, s);
  return Math.max(10, Math.round(MANUAL_COST_RATE * diff));
}

const MANUAL_MAX_LOG = 1e300;   // これ以上は数として扱えない

/* 手で書きかえられる大きさの上限。
 * アップグレードで出せる最大＋少しの余裕まで。
 * 「端数をきりよくする」ためのものなので、桁を飛び越えることはできない。 */
function maxAutoLog(s) {
  return s.sciMode ? 9 * Math.pow(10, expOrder(s)) * expMul(s) : s.digits;
}
// 以降の問題の大きさとして引き継げる上限（アップグレードで出せる最大）。
// 整数なら「桁数アップの桁」の数字 = 10^(digits-1) 台まで
function manualCarryLimit(s) {
  return s.sciMode ? maxAutoLog(s) : s.digits - 1;
}
function manualLimit(s) {
  const m = maxAutoLog(s);
  return m + Math.max(1, m * 0.05);
}

// 手で 10^15 より大きい数を指定したときは、指数表記でないと表示も計算もできない
function useSci(s) {
  return s.sciMode || (s.manualLog !== null && s.manualLog >= 15);
}

function makeProblem(s) {
  const ops = enabledOps(s);
  const op = ops.length ? ops[randInt(0, ops.length - 1)] : 'add';
  return useSci(s) ? makeSciProblem(s, op) : makeIntProblem(s, op);
}

/* ふつうの整数で出題する（序盤） */
function makeIntProblem(s, op) {
  const n = op === 'add' ? s.terms : 2;   // 項数アップはたし算だけ。ひき算・わり算は2個
  const d = intDigits(s);
  let terms, answer;

  if (op === 'pow') {
    // 手計算できる範囲におさえる
    // 答えが安全な整数（約16桁）に収まるよう、b が大きいほど a を小さくする
    const [kMin, kMax] = powRange(s);
    const k = randInt(kMin, kMax);
    let base;
    if (Math.pow(2, k) > 9e15) {
      // 2^b でも16桁を超えるほど b が大きい → 答えは指数表記（E キーで入力）
      base = randInt(2, 9);
    } else {
      const cap = Math.max(2, Math.floor(Math.pow(9e15, 1 / k) + 1e-9));
      const hiA = Math.min(Math.pow(10, Math.min(d, 3)) - 1, cap);
      const loA = Math.min(Math.max(2, d === 1 ? 2 : Math.pow(10, Math.min(d, 3) - 1)), hiA);
      base = randInt(loA, hiA);
    }
    terms = [base, k];
    answer = V.pow(base, k);
  } else if (op === 'add') {
    terms = Array.from({ length: n }, () => randNumber(d));
    answer = terms.reduce((a, b) => a + b, 0);
  } else if (op === 'mul') {
    // 項数も1項の桁数も必ず守る。積が安全な整数（約15桁）を超えたら答えは指数表記になり、
    // 上から7桁が合っていれば正解になる（V.eq の許容誤差）
    terms = Array.from({ length: s.mulTerms }, () => randNumber(d));
    answer = terms.reduce((a, b) => V.mul(a, b));
  } else if (op === 'div') {
    answer = randNumber(d);
    const r = safeProduct([answer, ...Array.from({ length: n - 1 }, () => randNumber(d))]);
    terms = [r.product, ...r.used.slice(1)];
  } else {
    const rest = Array.from({ length: n - 1 }, () => randNumber(d));
    answer = randNumber(d);
    const head = rest.reduce((a, b) => a + b, answer);
    terms = [head, ...rest];
  }
  return { op, terms, answer, given: null, correct: false };
}

/* 指数表記で出題する（終盤）
 * 仮数は1桁、指数は n × 10^p。やることは
 *   かけ算 → 仮数をかけて指数を足す
 *   たし算 → 指数をそろえて仮数を足す
 * なので、数がどれだけ大きくなっても手で解ける。 */
function makeSciProblem(s, op) {
  const n = op === 'add' ? s.terms : 2;   // 項数アップはたし算だけ。ひき算・わり算は2個
  let terms, answer;

  if (op === 'pow') {
    const base = randSci(s);
    const k = randInt(2, 5) + 3 * ((s.perm && s.perm.powExp) || 0) + (s.powLevel || 0);
    terms = [base, k];
    answer = V.pow(base, k);
  } else if (op === 'mul') {
    terms = Array.from({ length: s.mulTerms }, () => randSci(s));
    answer = terms.reduce((a, b) => V.mul(a, b));
  } else if (op === 'div') {
    answer = randSci(s);
    const rest = Array.from({ length: n - 1 }, () => randSci(s));
    const head = rest.reduce((a, b) => V.mul(a, b), answer);
    terms = [head, ...rest];
  } else if (op === 'add') {
    // 指数をそろえる（そろっていないと小さい方が誤差に消えてしまう）
    const e = randExp(s);
    terms = Array.from({ length: n }, () => V.sci(randInt(1, 9), e));
    answer = terms.reduce((a, b) => V.add(a, b));
  } else {
    const e = randExp(s);
    const rest = Array.from({ length: n - 1 }, () => V.sci(randInt(1, 9), e));
    answer = V.sci(randInt(1, 9), e);
    const head = rest.reduce((a, b) => V.add(a, b), answer);
    terms = [head, ...rest];
  }
  return { op, terms, answer, given: null, correct: false };
}

function fmt(n)  { return V.fmt(n); }            // 文字列（カンマ or 科学記数法）
function fmtH(n) { return V.html(n); }           // <sup> つきの表示

// 式の表示。指数表記の項はカッコでくくって読みやすくする
function expressionHtml(p) {
  if (p.op === 'pow') {
    const base = V.isSci(p.terms[0]) ? `(${fmtH(p.terms[0])})` : fmtH(p.terms[0]);
    return `${base}<sup class="pow-exp">${p.terms[1]}</sup>`;
  }
  const many = p.terms.length > 1;
  return p.terms
    .map(t => (many && V.isSci(t) ? `(${fmtH(t)})` : fmtH(t)))
    .join(` ${OPS[p.op].symbol} `);
}

function expressionText(p) {
  if (p.op === 'pow') return `${fmt(p.terms[0])} ^ ${p.terms[1]}`;
  return p.terms.map(fmt).join(` ${OPS[p.op].symbol} `);
}

// 全角数字・カンマ・空白を吸収して数値にする
function normalizeInput(raw) {
  return String(raw)
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[−ー―－]/g, '-')
    .replace(/[ｅＥ]/g, 'e')
    .replace(/[．]/g, '.')
    .replace(/[,\s，×xX]/g, '')
    .trim();
}

/* ---------------------------------------------------------------
 * ラウンド進行
 * ------------------------------------------------------------- */
let round = null;   // { problems: [], index: 0 }

function startRound() {
  round = {
    problems: Array.from({ length: roundSize(state) }, () => makeProblem(state)),
    index: 0,
  };
  locked = false;
  el.judge.className = 'judge';
  el.expressionCard.className = 'expression-card';
  el.feedback.textContent = '';
  el.feedback.className = 'feedback';
  showScreen('calc');
  showCalcView('play');
  renderProblem();
}

function currentSum() {
  if (!round) return 0;
  return round.problems.reduce((acc, p) => V.add(acc, contribution(p, state)), 0);
}

const JUDGE_MS = 550;   // ○× を見せる時間
let locked = false;     // 判定表示中は次の入力を受けつけない

function submitAnswer(raw) {
  const p = round.problems[round.index];
  const text = normalizeInput(raw);
  const value = V.parse(text);
  const valid = value !== null;

  p.given = valid ? value : null;
  p.correct = valid && V.eq(value, p.answer);

  state.stats.answered += 1;
  if (p.correct) {
    state.stats.correct += 1;
    state.combo += 1;
    state.stats.bestStreak = Math.max(state.stats.bestStreak || 0, state.combo);
  } else {
    state.combo = 0;
  }
  save();   // 実績の判定もここで走る

  // 判定を大きく表示
  locked = true;
  el.judge.textContent = p.correct ? '○' : '×';
  el.judge.className = 'judge show ' + (p.correct ? 'ok' : 'ng');
  el.expressionCard.className = 'expression-card ' + judgeClass(p.correct);
  if (p.correct && currentEffect(state) === 'confetti') spawnConfetti(el.expressionCard);
  const part = p.correct ? 0 : contribution(p, state);
  el.feedback.textContent = p.correct
    ? '正解！'
    : `ちがう（答えは ${fmt(p.answer)}）` + (part ? ` ＋部分点 ${fmt(part)}` : '');
  el.feedback.className = 'feedback ' + (p.correct ? 'ok' : 'ng');
  el.runningSum.innerHTML = fmtH(currentSum());
  el.input.value = '';
  renderSteps();
  renderPreview();
  renderCombo();

  const pause = autoActive() ? Math.min(JUDGE_MS, Math.max(120, autoDelay(state) * 0.6)) : JUDGE_MS;
  setTimeout(() => {
    locked = false;
    el.judge.className = 'judge';
    el.expressionCard.className = 'expression-card';
    round.index += 1;
    if (round.index >= round.problems.length) {
      finishRound();
    } else {
      el.feedback.textContent = '';
      el.feedback.className = 'feedback';
      renderProblem();
    }
  }, pause);
}

function finishRound() {
  const sum = currentSum();
  const perfect = round.problems.every(p => p.correct);
  const base = baseFromSum(sum, state);
  const bonus = varietyBonus(state);
  const perfectAdd = perfectBonus(state, perfect);
  const mult = multiplier(state);
  const gain = rewardFor(sum, state, perfect);
  const before = state.points;
  const isBest = V.cmp(gain, 0) > 0 && V.cmp(gain, state.stats.best) > 0;

  // 最終目標（合計 10^10^100）への到達度を記録
  const tower = V.tower(sum);
  if (tower > state.stats.bestTower) state.stats.bestTower = tower;
  const newTiers = reachTiers(state, tower);
  const chClear = checkChallenge(state, sum);

  state.points = V.add(state.points, gain);
  state.runEarned = V.add(state.runEarned, gain);

  // 利息（使わずに貯めておくほど増える）
  const interest = state.interestLevel ? V.scale(state.points, interestRate(state)) : 0;
  if (V.cmp(interest, 0) > 0) {
    state.points = V.add(state.points, interest);
    state.runEarned = V.add(state.runEarned, interest);
  }
  state.stats.rounds += 1;
  if (perfect) state.stats.perfects = (state.stats.perfects || 0) + 1;
  state.stats.earned = V.add(state.stats.earned, gain);
  if (isBest) state.stats.best = gain;
  save();

  renderResult({ sum, base, bonus, perfectAdd, mult, gain, before, isBest, tower, newTiers,
                 interest, combo: comboCount(state), comboMult: comboMult(state),
                 allInMult: allInMult(state), bonusMult: bonusMult(state), boosted: boostedBase(sum, state) });
  renderAll();
  showScreen('result');   // 計算が終わったら結果画面へ
  if (chClear) {
    showToast({ name: chClear.name, desc: `永続ボーナス：${chClear.reward}`, sigma: chClear.sigma }, 'チャレンジ達成');
  }
}

/* ---------------------------------------------------------------
 * 実績
 *   test が true になった瞬間に達成。reward があれば T をもらえる。
 *   序盤（T が 1〜10 の苦しい時期）に達成しやすいものほど報酬をつけている。
 * ------------------------------------------------------------- */
const ACHIEVEMENTS = [
  { id: 'firstCorrect', name: 'はじめの一問',     desc: '1問正解する',                reward: 3,  test: s => s.stats.correct >= 1 },
  { id: 'firstRound',   name: '1ラウンド完走',    desc: 'ラウンドを1回終える',         reward: 2,  test: s => s.stats.rounds >= 1 },
  { id: 'firstBuy',     name: 'はじめての買い物', desc: 'アップグレードを1つ買う',     reward: 3,  test: s => (s.stats.bought || 0) >= 1 },
  { id: 'perfect1',     name: 'パーフェクト',     desc: '1ラウンド全問正解する',       reward: 5,  test: s => (s.stats.perfects || 0) >= 1 },
  { id: 'streak5',      name: '波に乗る',         desc: '5問連続で正解する',           reward: 4,  test: s => (s.stats.bestStreak || 0) >= 5 },
  { id: 'correct10',    name: '10問正解',         desc: '合計10問正解する',            reward: 5,  test: s => s.stats.correct >= 10 },
  { id: 'digits2',      name: '2桁の世界',        desc: '桁数を2桁にする',             reward: 5,  test: s => s.digits >= 2 },
  { id: 'sub',          name: 'ひき算デビュー',   desc: 'ひき算を解放する',            reward: 8,  test: s => s.unlocked.sub },
  { id: 'rounds10',     name: '10ラウンド',       desc: 'ラウンドを10回終える',        reward: 10, test: s => s.stats.rounds >= 10 },
  { id: 'streak15',     name: '集中モード',       desc: '15問連続で正解する',          reward: 10, test: s => (s.stats.bestStreak || 0) >= 15 },
  { id: 'mul',          name: 'かけ算デビュー',   desc: 'かけ算を解放する',            reward: 15, test: s => s.unlocked.mul },
  { id: 'perfect10',    name: 'パーフェクト×10',  desc: '全問正解のラウンドを10回',    reward: 20, test: s => (s.stats.perfects || 0) >= 10 },
  { id: 'correct100',   name: '100問正解',        desc: '合計100問正解する',           reward: 25, test: s => s.stats.correct >= 100 },
  { id: 'points100',    name: '小金持ち',         desc: '所持Tポイントが100を超える',  test: s => V.cmp(s.points, 100) >= 0 },
  { id: 'digits5',      name: '5桁の世界',        desc: '桁数を5桁にする',             test: s => s.digits >= 5 },
  { id: 'div',          name: 'わり算デビュー',   desc: 'わり算を解放する',            test: s => s.unlocked.div },
  { id: 'pow',          name: 'べき乗デビュー',   desc: 'べき乗を解放する',            test: s => s.unlocked.pow },
  { id: 'auto',         name: '自動化',           desc: 'オート計算を買う',            test: s => s.auto },
  { id: 'best1000',     name: '大漁',             desc: '1ラウンドで1,000T稼ぐ',       test: s => V.cmp(s.stats.best, 1000) >= 0 },
  { id: 'prestige1',    name: '生まれ変わり',     desc: 'はじめて転生する',            test: s => s.stats.prestiges >= 1 },
  { id: 'sci',          name: '指数の入口',       desc: '指数表記を手に入れる',        test: s => s.sciMode },
  { id: 'rounds100',    name: '100ラウンド',      desc: 'ラウンドを100回終える',       test: s => s.stats.rounds >= 100 },
  { id: 'googol',       name: 'グーゴル',         desc: '1ラウンドの合計が 10^100 を超える',       test: s => s.stats.bestTower >= 2 },
  { id: 'prestige10',   name: '輪廻',             desc: '10回転生する',                test: s => s.stats.prestiges >= 10 },
  { id: 'correct1000',  name: '1000問正解',       desc: '合計1,000問正解する',         test: s => s.stats.correct >= 1000 },
  { id: 'tower10',      name: '塔の上',           desc: '1ラウンドの合計が 10^10^10 を超える',     test: s => s.stats.bestTower >= 10 },
  { id: 'goal',         name: '到達',             desc: '最終目標 10^10^100 を達成する', test: s => s.stats.goal },
  { id: 'tier150',      name: '中間圏',           desc: '1ラウンドの合計が 10^10^150 を超える',    test: s => s.stats.bestTower >= 150 },
  { id: 'tier200',      name: '月面着陸',         desc: '1ラウンドの合計が 10^10^200 を超える',    test: s => s.stats.bestTower >= 200 },
  { id: 'chall1',       name: '挑戦者',           desc: 'チャレンジを1つクリアする',   test: s => clearedCount(s) >= 1 },
  { id: 'challAll',     name: '全制覇',           desc: 'チャレンジをすべてクリアする', test: s => clearedCount(s) >= CHALLENGES.length },
  { id: 'lab1',         name: '研究者',           desc: '研究を1つ終える',              test: s => labCount(s) >= 1 },
  { id: 'labAll',       name: '博士',             desc: '研究をすべて終える',           test: s => labCount(s) >= RESEARCH.length },
  { id: 'tier250',      name: '数の果て',         desc: 'すべての目標を達成する（10^10^250）',      test: s => goalTier(s) >= GOAL_TIERS.length },
];

// 条件を満たした実績を達成済みにして、報酬を渡す（save() のたびに呼ばれる）
function checkAchievements() {
  if (!state.ach) state.ach = {};
  const got = [];
  ACHIEVEMENTS.forEach(a => {
    if (state.ach[a.id]) return;
    let ok = false;
    try { ok = a.test(state); } catch (e) { ok = false; }
    if (!ok) return;
    state.ach[a.id] = true;
    if (a.reward) state.points = V.add(state.points, a.reward);
    got.push(a);
  });
  if (!got.length) return;
  if (typeof el !== 'undefined') {
    el.points.textContent = fmt(state.points);
    got.forEach(a => showToast(a));
    renderAchievements();
  }
}

function showToast(a, head = '実績達成') {
  const box = document.getElementById('toasts');
  if (!box) return;
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<span class="toast-icon">🏆</span>
    <span class="toast-body"><b>${head}：${a.name}</b><small>${a.desc}</small></span>` +
    (a.reward ? `<span class="toast-reward">+${a.reward} T</span>` : '') +
    (a.sigma ? `<span class="toast-reward">+${a.sigma} Σ</span>` : '');
  box.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 400);
  }, 3200);
}

function renderAchievements() {
  const list = document.getElementById('ach-list');
  if (!list) return;
  const done = ACHIEVEMENTS.filter(a => state.ach && state.ach[a.id]).length;
  document.getElementById('ach-count').textContent = `${done} / ${ACHIEVEMENTS.length}`;
  list.innerHTML = ACHIEVEMENTS.map(a => {
    const ok = state.ach && state.ach[a.id];
    return `<div class="ach${ok ? ' done' : ''}">
      <span class="ach-mark">${ok ? '🏆' : '・'}</span>
      <span class="ach-text"><b>${a.name}</b><small>${a.desc}</small></span>
      ${a.reward ? `<span class="ach-reward">+${a.reward} T</span>` : ''}
    </div>`;
  }).join('');
}

/* ---------------------------------------------------------------
 * 購入
 * ------------------------------------------------------------- */
function buy(upg) {
  if (upg.level(state) >= upg.max) return;
  if (upg.requires && !upg.requires(state)) return;
  const cost = costOf(upg, state);
  if (V.cmp(state.points, cost) < 0) return;
  state.points = V.sub(state.points, cost);
  upg.apply(state);
  state.stats.bought = (state.stats.bought || 0) + 1;
  save();
  renderAll();
}

function buyPerk(perk) {
  if (perk.level(state) >= perk.max) return;
  const cost = perk.cost(state);
  if (state.sigma < cost) return;
  state.sigma -= cost;
  perk.apply(state);
  applyPerm(state);
  save();
  renderAll();
}

/* ---------------------------------------------------------------
 * オート計算
 * ------------------------------------------------------------- */
const AUTO_BASE_MS = 3000;          // 解放直後の1問あたりの時間
const AUTO_ROUND_MS = 1800;         // ラウンド間の待ち

let autoTimer = null;

function autoDelay(s) {
  return Math.round(AUTO_BASE_MS * Math.pow(0.8, s.autoSpeed || 0) *
                    (cleared(s, 'manual') ? 0.7 : 1) * labAutoMult(s));
}
// オートを持っていて、いま使えるか（チャレンジ「手作業」の間は使えない）
function autoUsable(s) {
  return s.auto && !inChallenge(s, 'manual');
}
function autoActive() {
  return autoUsable(state) && state.autoOn;
}

// オートが入れる答えの文字列（自分で打つときと同じ形）
function autoAnswerText(p) {
  return V.isSci(p.answer)
    ? `${parseFloat(p.answer.m.toPrecision(12))}e${p.answer.e}`
    : String(p.answer);
}

function autoStep() {
  if (locked || editing) return;
  const playing = round && round.index < round.problems.length;

  if (playing) {
    if (!isScreen('calc')) return;            // 計算画面を見ているときだけ解く
    el.input.value = autoAnswerText(round.problems[round.index]);
    trySubmit();
    return;
  }
  // ラウンドが終わっている。オート周回があれば次を始める
  // アップグレードや転生を見ている間は勝手に始めない
  if (state.autoRound && (isScreen('calc') || isScreen('result'))) startRound();
}

function autoLoop() {
  clearTimeout(autoTimer);
  if (!autoActive()) return;
  const playing = round && round.index < round.problems.length;
  const wait = playing ? autoDelay(state) : AUTO_ROUND_MS * (labDone(state, 'auto2') ? 0.5 : 1);
  autoTimer = setTimeout(() => { autoStep(); autoLoop(); }, wait);
}

function renderAuto() {
  const usable = autoUsable(state);
  el.autoRow.classList.toggle('hidden', !usable);
  el.autoStop.classList.toggle('hidden', !usable);
  if (!usable) { clearTimeout(autoTimer); return; }
  el.autoStop.textContent = state.autoOn ? '⏸ オート停止' : '▶ オート再開';
  el.autoStop.classList.toggle('off', !state.autoOn);
  el.autoToggle.checked = state.autoOn;
  el.autoInfo.innerHTML = state.autoOn
    ? `${(autoDelay(state) / 1000).toFixed(1)} 秒に1問` +
      (state.autoRound ? '　／　ラウンドも自動' : '')
    : '止まっています';
  autoLoop();
}

/* ---------------------------------------------------------------
 * 式の数字を自分で書きかえる（計算画面）
 * ------------------------------------------------------------- */
let editing = false;

// 式を評価しなおす
function evalProblem(p) {
  switch (p.op) {
    case 'add': return p.terms.reduce((a, b) => V.add(a, b));
    case 'sub': return p.terms.reduce((a, b) => V.sub(a, b));
    case 'mul': return p.terms.reduce((a, b) => V.mul(a, b));
    case 'div': return p.terms.reduce((a, b) => V.div(a, b));
    case 'pow': return V.pow(p.terms[0], p.terms[1]);
    default:    return 0;
  }
}

// 入力欄に入れる文字列（指数表記は 3e50 の形で編集する）
function termInputValue(t) {
  if (!V.isSci(t)) return String(t);
  return `${parseFloat(t.m.toPrecision(12))}e${t.e}`;
}

function startEdit() {
  if (locked || !round) return;
  const p = round.problems[round.index];
  editing = true;
  el.exprEdit.innerHTML = '';
  p.terms.forEach((t, i) => {
    if (i) {
      const op = document.createElement('span');
      op.className = 'term-op';
      op.textContent = OPS[p.op].symbol;
      el.exprEdit.appendChild(op);
    }
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'term-in' + (p.op === 'pow' && i === 1 ? ' small' : '');
    inp.value = termInputValue(t);
    inp.setAttribute('aria-label', `${i + 1}つめの数字`);
    inp.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); applyEdit(); }
      if (ev.key === 'Escape') { ev.preventDefault(); cancelEdit(); }
    });
    el.exprEdit.appendChild(inp);
  });
  el.exprEditMsg.textContent = '';
  renderEditMode();
  el.exprEdit.querySelector('.term-in').focus();
  el.exprEdit.querySelector('.term-in').select();
}

function cancelEdit() {
  editing = false;
  renderEditMode();
  el.input.focus();
}

function applyEdit() {
  const p = round.problems[round.index];
  const inputs = [...el.exprEdit.querySelectorAll('.term-in')];
  const vals = inputs.map(i => V.parse(normalizeInput(i.value)));

  if (vals.some(v => v === null)) {
    el.exprEditMsg.textContent = '読めない数字があります';
    return;
  }
  // べき乗の指数はふつうの整数だけ
  if (p.op === 'pow') {
    const k = V.isSci(vals[1]) ? V.num(vals[1]) : vals[1];
    if (!isFinite(k) || k < 1 || k > 1e6) {
      el.exprEditMsg.textContent = 'べき乗の指数は 1〜1,000,000 にしてください';
      return;
    }
    vals[1] = Math.round(k);
  }

  // 上限を超える書きかえはできない
  const limit = manualLimit(state);
  if (vals.some(v => V.log10(v) > limit)) {
    el.exprEditMsg.innerHTML =
      `いまは ${magnitudeHtml(Math.floor(limit), state, 1)} までです` +
      `（桁数アップ・指数スケールを進めると上がります）`;
    return;
  }

  const before = p.terms;
  p.terms = vals;
  const answer = evalProblem(p);
  if (!isFinite(V.log10(answer)) && V.cmp(answer, 0) !== 0) {
    p.terms = before;
    el.exprEditMsg.textContent = 'その式は大きすぎて扱えません';
    return;
  }
  p.answer = answer;

  // 以降の問題も同じ大きさで出す。
  // ただし余裕ぶん（1つ上の桁）はこの問題だけで、以降はアップグレードの最大までにおさえる
  const L = Math.min(Math.floor(V.log10(vals[0])), manualCarryLimit(state));
  if (isFinite(L) && L >= 0 && L <= MANUAL_MAX_LOG) {
    const cost = manualCost(L, state);
    if (V.cmp(cost, state.points) <= 0) {
      state.points = V.sub(state.points, cost);
      state.manualLog = L;
      regenerateRest();
    }
  }

  editing = false;
  save();
  renderProblem();
  renderAll();
}

// まだ解いていない問題を、いまの設定で作りなおす
// from を省くと「次の問題から」。いま出ている問題も作りなおすときは round.index を渡す
function regenerateRest(from) {
  const start = from === undefined ? round.index + 1 : from;
  for (let i = start; i < round.problems.length; i++) {
    round.problems[i] = makeProblem(state);
  }
}

function clearManual() {
  state.manualLog = null;
  // いま出ている問題も作りなおす（大きさだけ取り残されないように）
  if (round && round.index < round.problems.length && !locked) regenerateRest(round.index);
  save();
  renderAll();
  if (round && round.index < round.problems.length) renderProblem();
}

// 表示の切り替えと、いまの設定の案内
function renderEditMode() {
  el.expression.classList.toggle('hidden', editing);
  el.exprEdit.classList.toggle('hidden', !editing);
  el.exprTools.classList.toggle('hidden', !state.manual || editing);
  el.exprEditTools.classList.toggle('hidden', !editing);

  if (state.manualLog === null) {
    el.manualNote.innerHTML = '';
  } else {
    el.manualNote.innerHTML =
      `いまは <b>${magnitudeHtml(state.manualLog, state)}</b> 前後で出題　` +
      `<button type="button" class="linkish" id="btn-manual-auto">自動に戻す</button>`;
    const btn = document.getElementById('btn-manual-auto');
    if (btn) btn.addEventListener('click', clearManual);
  }
}

// 「この大きさ」を表す見本の数（整数のうちはふつうの数字で見せる）
function magnitudeHtml(L, s, m = 3) {
  if (s.sciMode || L >= 15) return V.html(V.sci(m, L));   // 15桁を超えたら指数表記
  return V.html(Math.round(m * Math.pow(10, L)));
}

/* ---------------------------------------------------------------
 * 転生
 * ------------------------------------------------------------- */
function doPrestige() {
  const gain = sigmaGain(state);
  if (gain < 1) return;

  const perm = state.perm;
  const carried = {
    sigma: state.sigma + gain,
    sigmaTotal: state.sigmaTotal + gain,
    perm,
    stats: state.stats,
    ach: state.ach,
    chDone: state.chDone,
    lab: state.lab,
    look: state.look,
  };

  // 「引き継ぎ」で残るもの
  if (perm.keep >= 1) {
    carried.unlocked = Object.assign({}, state.unlocked);
    carried.enabled  = Object.assign({}, state.enabled);
  }
  if (perm.keep >= 2) {
    carried.auto = state.auto;
    carried.autoOn = state.autoOn;
    carried.autoSpeed = state.autoSpeed;
    carried.autoRound = state.autoRound;
  }
  if (perm.keep >= 3) carried.logBase = state.logBase;
  if (perm.keep >= 4) carried.multLevel = state.multLevel;
  if (perm.keep >= 5) {
    ['digits', 'terms', 'mulTerms', 'problems'].forEach(k => { carried[k] = state[k]; });
  }
  if (perm.keep >= 6) {
    ['sciMode', 'expLevel', 'expRewardLevel'].forEach(k => { carried[k] = state[k]; });
  }
  if (perm.keep >= 7) {
    ['manual', 'partialLevel', 'perfectLevel', 'comboLevel', 'interestLevel', 'allIn']
      .forEach(k => { carried[k] = state[k]; });
  }

  state = Object.assign(newState(), carried);
  state.points = startCashOf(perm.startCash);   // 持ち込み資金
  state.stats.prestiges += 1;
  applyPerm(state);
  save();

  round = null;
  showScreen('calc');
  showCalcView('idle');
  renderAll();
}

/* これまでアップグレードに払った T ポイントを数えなおす。
 * 値段はレベルだけで決まるので、まっさらな状態から買い直したときの合計と一致する。 */
function spentOnUpgrades(s) {
  const t = newState();
  t.perm = s.perm;
  t.chDone = s.chDone;
  t.challenge = s.challenge;   // 値段はチャレンジの有無で変わる
  applyPerm(t);
  let total = 0;   // 巨大になることがあるので V で足す
  UPGRADES.forEach(u => {
    let guard = 0;
    let acc = 0;
    while (u.level(t) < u.level(s) && guard++ < 10000) {
      acc = V.add(acc, costOf(u, t));
      u.apply(t);
    }
    total = V.add(total, acc);
  });
  return total;
}

// 買ったアップグレードを白紙に戻し、払った分を返す（Σ・永続強化・記録はそのまま）
function doRespec() {
  const refund = spentOnUpgrades(state);
  const keep = {
    points: V.add(state.points, refund),
    runEarned: state.runEarned,
    sigma: state.sigma,
    sigmaTotal: state.sigmaTotal,
    perm: state.perm,
    stats: state.stats,
    ach: state.ach,
    chDone: state.chDone,
    challenge: state.challenge,
    chBest: state.chBest,
    lab: state.lab,
    look: state.look,
  };
  state = Object.assign(newState(), keep);
  applyPerm(state);
  save();

  round = null;
  showScreen('calc');
  showCalcView('idle');
  renderAll();
}

function doReset() {
  state = newState();
  save();
  round = null;
  showScreen('calc');
  showCalcView('idle');
  renderAll();
}

/* ---------------------------------------------------------------
 * 画面
 * ------------------------------------------------------------- */
const el = {
  points:       document.getElementById('points'),
  idleProblems: document.getElementById('idle-problems'),
  screenCalc:   document.getElementById('screen-calc'),
  screenResult: document.getElementById('screen-result'),
  screenUpgrade:document.getElementById('screen-upgrade'),
  screenPrestige: document.getElementById('screen-prestige'),
  screenLab:      document.getElementById('screen-lab'),
  labChip:        document.getElementById('lab-chip'),
  labCount:       document.getElementById('lab-count'),
  labCurrent:     document.getElementById('lab-current'),
  labTree:        document.getElementById('lab-tree'),
  themeList:      document.getElementById('theme-list'),
  effectList:     document.getElementById('effect-list'),
  viewIdle:     document.getElementById('view-idle'),
  viewPlay:     document.getElementById('view-play'),
  steps:        document.getElementById('steps'),
  keypad:       document.getElementById('keypad'),
  preview:      document.getElementById('answer-preview'),
  playHint:     document.getElementById('play-hint'),
  goalFill:     document.getElementById('goal-fill'),
  goalNote:     document.getElementById('goal-note'),
  goalBadge:    document.getElementById('goal-badge'),
  goalLabel:    document.getElementById('goal-label'),
  expressionCard: document.getElementById('expression-card'),
  expression:   document.getElementById('expression'),
  judge:        document.getElementById('judge'),
  form:         document.getElementById('answer-form'),
  input:        document.getElementById('answer-input'),
  feedback:     document.getElementById('feedback'),
  runningSum:   document.getElementById('running-sum'),
  resultBadge:  document.getElementById('result-badge'),
  answerList:   document.getElementById('answer-list'),
  sumLabel:     document.getElementById('sum-label'),
  sumFormula:   document.getElementById('sum-formula'),
  sumDigits:    document.getElementById('sum-digits'),
  digitNote:    document.getElementById('digit-note'),
  breakdown:    document.getElementById('breakdown'),
  gain:         document.getElementById('gain'),
  bestNote:     document.getElementById('best-note'),
  pointsFlow:   document.getElementById('points-flow'),
  nextBlock:    document.getElementById('next-block'),
  nextFill:     document.getElementById('next-fill'),
  nextNote:     document.getElementById('next-note'),
  upgradeList:  document.getElementById('upgrade-list'),
  ops:          document.getElementById('ops'),
  stats:        document.getElementById('stats'),
  combo:        document.getElementById('combo'),
  allInRow:     document.getElementById('allin-row'),
  allInValue:   document.getElementById('allin-value'),
  allInInfo:    document.getElementById('allin-info'),
  autoRow:      document.getElementById('auto-row'),
  autoToggle:   document.getElementById('auto-toggle'),
  autoStop:     document.getElementById('btn-auto-stop'),
  autoInfo:     document.getElementById('auto-info'),
  exprEdit:     document.getElementById('expr-edit'),
  exprTools:    document.getElementById('expr-tools'),
  exprEditTools:document.getElementById('expr-edit-tools'),
  exprEditMsg:  document.getElementById('expr-edit-msg'),
  manualNote:   document.getElementById('manual-note'),
  sigmaChip:    document.getElementById('sigma-chip'),
  sigmaGain:    document.getElementById('sigma-gain'),
  sigmaFill:    document.getElementById('sigma-fill'),
  sigmaNote:    document.getElementById('sigma-note'),
  sigmaFormula: document.getElementById('sigma-formula'),
  sigmaHave:    document.getElementById('sigma-have'),
  sigmaTotal:   document.getElementById('sigma-total'),
  sigmaPower:   document.getElementById('sigma-power'),
  perkList:     document.getElementById('perk-list'),
  chList:       document.getElementById('ch-list'),
  chCount:      document.getElementById('ch-count'),
  chBanner:     document.getElementById('ch-banner'),
  btnPrestige:  document.getElementById('btn-prestige'),
  prestigeConfirm: document.getElementById('prestige-confirm'),
  respecConfirm:   document.getElementById('respec-confirm'),
  respecText:      document.getElementById('respec-text'),
  btnRespec:       document.getElementById('btn-respec'),
  resetConfirm:    document.getElementById('reset-confirm'),
};

function isScreen(name) {
  const map = { calc: el.screenCalc, result: el.screenResult,
                upgrade: el.screenUpgrade, prestige: el.screenPrestige, lab: el.screenLab };
  return !map[name].classList.contains('hidden');
}

// 'calc' / 'result' / 'upgrade' / 'prestige' / 'lab'
function showScreen(name) {
  el.screenCalc.classList.toggle('hidden', name !== 'calc');
  el.screenResult.classList.toggle('hidden', name !== 'result');
  el.screenUpgrade.classList.toggle('hidden', name !== 'upgrade');
  el.screenPrestige.classList.toggle('hidden', name !== 'prestige');
  el.screenLab.classList.toggle('hidden', name !== 'lab');
  window.scrollTo(0, 0);
  if (state.auto) autoLoop();
}

// 計算画面の中身： 'idle'（初回の説明） / 'play'（出題中）
function showCalcView(name) {
  el.viewIdle.classList.toggle('hidden', name !== 'idle');
  el.viewPlay.classList.toggle('hidden', name !== 'play');
}

function renderProblem() {
  const p = round.problems[round.index];
  el.expression.innerHTML = expressionHtml(p);
  el.runningSum.innerHTML = fmtH(currentSum());
  el.input.value = '';
  el.input.focus();
  renderSteps();
  renderKeypad();
  renderPreview();
  renderCombo();
  editing = false;
  renderEditMode();
}

// ●●○ …… 何問目か・これまでの正誤を一目で
function renderSteps() {
  el.steps.innerHTML = '';
  round.problems.forEach((p, i) => {
    const dot = document.createElement('span');
    // 判定表示中は、いま解いた問題も答え合わせ済みとして見せる
    const done = i < round.index || (locked && i === round.index);
    dot.className = 'dot' +
      (done ? (p.correct ? ' ok' : ' ng') : '') +
      (i === round.index && !locked ? ' current' : '');
    dot.textContent = done ? (p.correct ? '○' : '×') : i + 1;
    el.steps.appendChild(dot);
  });
}

function renderResult(r) {
  const solved = round.problems.filter(p => p.correct);
  const scored = round.problems.filter(p => V.cmp(contribution(p, state), 0) > 0);
  const total = round.problems.length;
  const perfect = solved.length === total;
  const b = state.logBase;

  // --- 見出しバッジ ---
  el.resultBadge.className = 'badge ' + (perfect ? 'perfect' : solved.length ? 'normal' : 'zero');
  el.resultBadge.textContent = perfect
    ? `パーフェクト！ ${total}問 全問正解`
    : `${total}問中 ${solved.length}問 正解`;

  // --- 答え合わせ ---
  el.answerList.innerHTML = '';
  round.problems.forEach(p => {
    const li = document.createElement('li');
    li.className = p.correct ? 'ok' : 'ng';
    li.innerHTML =
      `<span class="mark">${p.correct ? '○' : '×'}</span>` +
      `<span>${expressionHtml(p)} = ${fmtH(p.answer)}</span>` +
      (p.correct ? '' : `<span class="yours">あなたの答え: ${p.given === null ? '—' : fmtH(p.given)}` +
        (V.cmp(contribution(p, state), 0) > 0
          ? ` <span class="partial">部分点 +${fmtH(contribution(p, state))}</span>` : '') +
        `</span>`);
    el.answerList.appendChild(li);
  });

  // --- 合計の式 ---
  el.sumLabel.textContent = state.partialLevel
    ? '合計に入った答え（部分点ふくむ）'
    : '正解した答えを合計';
  el.sumFormula.innerHTML = scored.length
    ? `${scored.map(p => fmtH(contribution(p, state))).join(' + ')} = ${fmtH(r.sum)}`
    : '合計に入る答えなし';

  // --- 合計を桁で見せる（⌊log10⌋ = 桁数 − 1） ---
  // 小さいうちは1桁ずつ、大きくなったら指数表記でどんと表示
  el.sumDigits.innerHTML = V.isSci(r.sum)
    ? `<span class="digit huge">${fmtH(r.sum)}</span>`
    : String(r.sum).split('').map(d => `<span class="digit">${d}</span>`).join('');
  const logv = V.log10(r.sum) / Math.log10(b);
  el.digitNote.innerHTML = V.cmp(r.sum, 1) < 0
    ? '合計が 1 以上になると報酬が発生します'
    : V.isSci(r.sum)
      ? `log<sub>${b}</sub>(合計) ≒ ${fmt(Math.round(logv))} → ×${REWARD_SCALE} して 基礎値 <b>${fmt(r.base)}</b>`
      : `log<sub>${b}</sub>(${fmt(r.sum)}) = ${logv.toFixed(2)} → ×${REWARD_SCALE} して 基礎値 <b>${fmt(r.base)}</b>`;

  // --- 内訳 ---
  const parts = [fmt(hasPowBoost(state) ? r.boosted : r.base), r.bonus];
  el.breakdown.innerHTML =
    row(`⌊log<sub>${b}</sub>(合計) × ${REWARD_SCALE}⌋`, fmt(r.base)) +
    (hasPowBoost(state)
      ? row(`基礎値の ${expRewardPow(state).toFixed(2)} 乗`, fmt(r.boosted)) : '') +
    row('演算ボーナス', `+${r.bonus}`) +
    (state.perfectLevel
      ? row('パーフェクトボーナス', r.perfectAdd ? `+${r.perfectAdd}` : '—（全問正解で +' + state.perfectLevel + '）')
      : '') +
    row('倍率', `×${r.mult.toFixed(2)}`) +
    (state.comboLevel ? row(`連続正解 ${fmt(r.combo)} 連鎖`, `×${r.comboMult.toFixed(2)}`) : '') +
    (state.allInCut ? row(`一発勝負 −${state.allInCut} 問`, `×${r.allInMult.toFixed(2)}`) : '') +
    (r.bonusMult !== 1 ? row('研究・チャレンジの倍率', `×${r.bonusMult.toFixed(2)}`) : '') +
    `<div class="row total"><span>( ${parts.concat(r.perfectAdd ? [r.perfectAdd] : []).join(' + ')} ) × ${(r.mult * r.bonusMult * r.comboMult * r.allInMult).toFixed(2)}</span><b>${fmt(r.gain)} T</b></div>` +
    (r.interest > 0 ? row('利息', `+${fmt(r.interest)} T`) : '');

  // --- 獲得（0 から数え上げ） ---
  countUp(el.gain, r.gain);
  el.gain.parentElement.classList.toggle('zero', V.cmp(r.gain, 0) === 0);
  el.gain.parentElement.classList.toggle('long', fmt(r.gain).length > 7);
  el.bestNote.classList.toggle('hidden', !r.isBest);
  el.pointsFlow.innerHTML = `所持 ${fmt(r.before)} → <b>${fmt(V.add(r.before, r.gain))}</b> T`;

  // --- あと少しで次の桁 ---
  el.nextBlock.classList.toggle('hidden', V.isSci(r.sum));
  if (V.cmp(r.sum, 1) >= 0) {
    const frac = (V.log10(r.sum) / Math.log10(b)) * REWARD_SCALE - r.base;
    el.nextFill.style.width = `${Math.max(0, Math.min(100, frac * 100))}%`;
    const nextSum = Math.pow(b, (r.base + 1) / REWARD_SCALE);
    el.nextNote.innerHTML = (!V.isSci(r.sum) && isFinite(nextSum))
      ? `あと <b>${fmt(Math.ceil(nextSum - r.sum))}</b> 合計を伸ばすと基礎値が <b>${fmt(r.base + 1)}</b> に上がる`
      : `もう少し合計を伸ばすと基礎値が <b>${fmt(r.base + 1)}</b> に上がる`;
  } else {
    el.nextFill.style.width = '0%';
    el.nextNote.textContent = 'まずは1問正解を目指そう';
  }

  renderGoal(r);

  function row(label, value) {
    return `<div class="row"><span>${label}</span><b>${value}</b></div>`;
  }
}

// 最終目標： 合計 10^10^100（その先も目標が続く）
function towerStr(x) {
  if (!isFinite(x)) return '—';
  return `10^10^${x < 10 ? x.toFixed(2) : fmt(Math.round(x))}`;
}

function towerHtml(x) {
  return `10<sup>10<sup>${fmt(x)}</sup></sup>`;
}

// ひとつ前の目標から次の目標までの進み具合（最初の目標だけは 0 から数える）
function goalProgress(s) {
  const next = nextTier(s);
  if (!next) return 100;
  const prev = goalTier(s) ? GOAL_TIERS[goalTier(s) - 1].tower : 0;
  const pct = (s.stats.bestTower - prev) / (next.tower - prev) * 100;
  return Math.max(0, Math.min(100, pct));
}

function renderGoal(r) {
  const now = r ? r.tower : state.stats.bestTower;
  const best = state.stats.bestTower;
  const next = nextTier(state);
  const title = tierTitle(state);
  const pct = goalProgress(state);
  el.goalLabel.innerHTML = !goalTier(state)
    ? `最終目標　合計 ${towerHtml(GOAL_TOWER)}`
    : next
      ? `次の目標　合計 ${towerHtml(next.tower)}（称号「${next.title}」）`
      : 'すべての目標を達成しました';
  el.goalFill.style.width = `${pct}%`;
  el.goalNote.innerHTML =
    (title ? `称号 <b>${title}</b> ／ ` : '') +
    `今回 <b>${towerStr(now)}</b> ／ 自己最高 <b>${towerStr(best)}</b>` +
    (next ? ` ／ 到達度 <b>${pct.toFixed(2)}%</b>` : '');
  const got = (r && r.newTiers) || [];
  el.goalBadge.classList.toggle('hidden', !got.length);
  if (got.length) {
    const last = got[got.length - 1];
    const sigma = got.reduce((a, t) => a + t.sigma, 0);
    el.goalBadge.textContent =
      `目標達成！ 合計が ${towerStr(last.tower)} を超えました　称号「${last.title}」・+${sigma} Σ`;
    got.forEach(t => showToast({ name: `称号「${t.title}」`, desc: `合計が ${towerStr(t.tower)} を超えた`,
                                 sigma: t.sigma }, '目標達成'));
  }
}

// 数字を 0 から目標値まで数え上げる演出
function countUp(node, to, ms = 700) {
  node.classList.remove('pop');
  if (V.isSci(to)) {            // 数えきれない大きさは、そのまま表示する
    node.textContent = fmt(to);
    node.classList.add('pop');
    return;
  }
  if (to <= 0) { node.textContent = '0'; return; }
  const start = performance.now();
  (function step(now) {
    const t = Math.min(1, (now - start) / ms);
    node.textContent = fmt(Math.round(to * (1 - Math.pow(1 - t, 3))));
    if (t < 1) requestAnimationFrame(step);
    else node.classList.add('pop');
  })(start);
}

// アップグレード／永続強化に共通のカード描画
function renderCards(container, defs, wallet, unit, onBuy, priceOf) {
  container.innerHTML = '';
  defs.forEach(def => {
    const lv = def.level(state);
    const maxed = lv >= def.max;
    const cost = maxed ? null : priceOf(def, state);
    const locked = !maxed && def.requires && !def.requires(state);
    const affordable = !maxed && !locked && V.cmp(wallet, cost) >= 0;

    const div = document.createElement('div');
    div.className = 'upg' + (maxed ? ' maxed' : affordable ? ' affordable' : '');
    div.innerHTML =
      `<div class="upg-head">
         <span class="upg-name">${def.name}</span>
         <span class="upg-level">${def.max === 1
           ? (maxed ? '解放済み' : '未解放')
           : isFinite(def.max) ? `Lv. ${lv} / ${def.max}` : `Lv. ${fmt(lv)}（上限なし）`}</span>
       </div>
       <p class="upg-now">いま: ${def.now(state)}</p>` +
      (maxed ? '' : `<p class="upg-next">次: ${def.next(state)}</p>`);

    if (!maxed) {
      const btn = document.createElement('button');
      btn.className = 'btn upg-buy' + (affordable ? ' primary' : '');
      btn.textContent = locked ? def.lockedNote : `${fmt(cost)} ${unit} で購入`;
      btn.disabled = !affordable;
      btn.addEventListener('click', () => onBuy(def));
      div.appendChild(btn);
    }
    container.appendChild(div);
  });
}

function renderUpgrades() {
  renderCards(el.upgradeList, UPGRADES, state.points, 'T', buy, costOf);
}

function renderPrestige() {
  const gain = sigmaGain(state);
  const need = sigmaNeed(state);
  const from = Math.pow(sigmaBase(state), 2) * SIGMA_DIV;

  el.sigmaGain.textContent = fmt(gain);
  el.sigmaGain.parentElement.classList.toggle('zero', gain < 1);
  el.sigmaFill.style.width = `${Math.max(0, Math.min(100, (state.runEarned - from) / (need - from) * 100))}%`;
  el.sigmaNote.innerHTML = gain >= 1
    ? `この周回の獲得 <b>${fmt(state.runEarned)}</b> T ／ あと <b>${fmt(need - state.runEarned)}</b> T で +1 Σ`
    : `転生には <b>${fmt(SIGMA_DIV)}</b> T の獲得が必要（いま <b>${fmt(state.runEarned)}</b> T）`;
  el.sigmaFormula.innerHTML =
    `獲得Tが ${SIGMA_DIV} を超えてから、10倍になるごとに +${SIGMA_PER_DECADE} Σ`;

  el.sigmaHave.textContent = fmt(state.sigma);
  el.sigmaTotal.textContent = fmt(state.sigmaTotal);
  el.sigmaPower.textContent = `+${(sigmaBonus(state) * 100).toFixed(0)}%`;
  el.sigmaChip.textContent = `Σ ${fmt(state.sigma)}`;
  el.btnPrestige.disabled = gain < 1;
  el.prestigeConfirm.classList.add('hidden');
  el.btnPrestige.textContent = gain >= 1 ? `転生して ${fmt(gain)} Σ を受け取る` : 'まだ転生できない';

  renderCards(el.perkList, PERKS, state.sigma, 'Σ', buyPerk, (d, s) => d.cost(s));
}

/* ---------------------------------------------------------------
 * 研究ツリー
 *   時間がたつと終わる研究。ゲームを閉じていても進む（始めた時刻で数える）。
 *   同時に進められるのは1つだけ。効果はアップグレードとは別にかかり、ずっと続く。
 * ------------------------------------------------------------- */
const RESEARCH = [
  { id: 'calc1', branch: '計算', name: '暗算の基礎', min: 5,   effect: '報酬 ×1.1' },
  { id: 'calc2', branch: '計算', name: '筆算の工夫', min: 30,  req: ['calc1'], effect: '報酬 ×1.2' },
  { id: 'calc3', branch: '計算', name: '計算尺',     min: 120, req: ['calc2'], effect: '報酬 ×1.5' },
  { id: 'sig1',  branch: '転生', name: '輪廻の観察', min: 15,  effect: '転生で受け取る Σ +1' },
  { id: 'sig2',  branch: '転生', name: '輪廻の理論', min: 60,  req: ['sig1'], effect: '転生で受け取る Σ さらに +3' },
  { id: 'sig3',  branch: '転生', name: '輪廻の悟り', min: 240, req: ['sig2'], effect: '転生で受け取る Σ さらに +10' },
  { id: 'auto1', branch: '自動', name: '歯車',       min: 10,  effect: 'オート計算の1問あたりの時間 ×0.9' },
  { id: 'auto2', branch: '自動', name: 'リレー回路', min: 45,  req: ['auto1'], effect: 'オート周回のラウンド間の待ちが半分' },
  { id: 'auto3', branch: '自動', name: '真空管',     min: 180, req: ['auto2'], effect: 'オート計算の1問あたりの時間 さらに ×0.8' },
  { id: 'lab1',  branch: '研究', name: '研究ノート', min: 20,  effect: 'これから始める研究の時間 ×0.9' },
  { id: 'lab2',  branch: '研究', name: '実験室',     min: 120, req: ['lab1'], effect: 'これから始める研究の時間 さらに ×0.8' },
  { id: 'truth', branch: '頂点', name: '計算の真理', min: 480, req: ['calc3', 'sig3', 'auto3'], effect: '報酬 ×2' },
];
const RESEARCH_BRANCHES = ['計算', '転生', '自動', '研究', '頂点'];

function researchOf(id) { return RESEARCH.find(r => r.id === id) || null; }
function labDone(s, id) { return !!(s.lab && s.lab.done && s.lab.done[id]); }
function labCount(s)    { return RESEARCH.filter(r => labDone(s, r.id)).length; }

function labRewardMult(s) {
  return (labDone(s, 'calc1') ? 1.1 : 1) * (labDone(s, 'calc2') ? 1.2 : 1) *
         (labDone(s, 'calc3') ? 1.5 : 1) * (labDone(s, 'truth') ? 2 : 1);
}
function labSigmaBonus(s) {
  return (labDone(s, 'sig1') ? 1 : 0) + (labDone(s, 'sig2') ? 3 : 0) + (labDone(s, 'sig3') ? 10 : 0);
}
function labAutoMult(s) { return (labDone(s, 'auto1') ? 0.9 : 1) * (labDone(s, 'auto3') ? 0.8 : 1); }
function labTimeMult(s) { return (labDone(s, 'lab1') ? 0.9 : 1) * (labDone(s, 'lab2') ? 0.8 : 1); }

function researchMs(s, r)   { return Math.round(r.min * 60000 * labTimeMult(s)); }
function researchReady(s, r) { return !labDone(s, r.id) && (r.req || []).every(id => labDone(s, id)); }

// 残り時間（ミリ秒）。時計が巻き戻っていたら、そこから数えなおす
function researchLeft(s) {
  const cur = s.lab.cur;
  if (!cur) return 0;
  const now = Date.now();
  if (now < cur.start) cur.start = now;
  return Math.max(0, cur.start + cur.ms - now);
}

function durStr(ms) {
  const t = Math.ceil(ms / 1000);
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), sec = t % 60;
  if (h) return `${h}時間${String(m).padStart(2, '0')}分`;
  if (m) return `${m}分${String(sec).padStart(2, '0')}秒`;
  return `${sec}秒`;
}

function startResearch(id) {
  const r = researchOf(id);
  if (!r || state.lab.cur || !researchReady(state, r)) return;
  state.lab.cur = { id, start: Date.now(), ms: researchMs(state, r) };
  save();
  renderAll();
}

function cancelResearch() {
  state.lab.cur = null;
  save();
  renderAll();
}

// 終わった研究を受け取る。受け取ったら true
function checkResearch() {
  const cur = state.lab.cur;
  if (!cur || researchLeft(state) > 0) return false;
  const r = researchOf(cur.id);
  state.lab.cur = null;
  if (!r) return false;
  state.lab.done[r.id] = true;
  save();
  if (typeof el !== 'undefined') showToast({ name: r.name, desc: r.effect }, '研究完了');
  return true;
}

// 1秒ごと：研究が終わっていたら全部描きなおし、そうでなければ残り時間だけ更新する
function tickLab() {
  if (checkResearch()) { renderAll(); return; }
  renderLabChip();
  if (state.lab.cur && isScreen('lab')) renderLabCurrent();
}

function renderLabChip() {
  el.labChip.textContent = state.lab.cur
    ? `研究中 ${durStr(researchLeft(state))}`
    : (labCount(state) < RESEARCH.length ? '研究・着せ替え' : '着せ替え');
  el.labChip.classList.toggle('busy', !!state.lab.cur);
}

function renderLabCurrent() {
  const cur = state.lab.cur;
  if (!cur) {
    el.labCurrent.innerHTML = labCount(state) < RESEARCH.length
      ? '<p class="lab-idle">いまは何も研究していません。下から選んでください。</p>'
      : '<p class="lab-idle">すべての研究を終えました。</p>';
    return;
  }
  const r = researchOf(cur.id);
  const left = researchLeft(state);
  const pct = Math.max(0, Math.min(100, (1 - left / cur.ms) * 100));
  el.labCurrent.innerHTML =
    `<div class="lab-now">
       <div class="lab-now-head"><b>研究中：${r.name}</b><span>あと ${durStr(left)}</span></div>
       <div class="lab-bar"><div class="lab-fill" style="width:${pct}%"></div></div>
       <p class="lab-now-effect">終わると：${r.effect}</p>
       <button type="button" class="btn tiny" id="btn-lab-cancel">研究をやめる（進み具合は消える）</button>
     </div>`;
  document.getElementById('btn-lab-cancel').addEventListener('click', cancelResearch);
}

function renderLab() {
  renderLabChip();
  el.labCount.textContent = `${labCount(state)} / ${RESEARCH.length}`;
  renderLabCurrent();
  el.labTree.innerHTML = '';
  RESEARCH_BRANCHES.forEach(branch => {
    const col = document.createElement('div');
    col.className = 'lab-branch';
    col.innerHTML = `<h3 class="sub-title">${branch}</h3>`;
    RESEARCH.filter(r => r.branch === branch).forEach(r => {
      const done = labDone(state, r.id);
      const active = state.lab.cur && state.lab.cur.id === r.id;
      const ready = researchReady(state, r);
      const node = document.createElement('div');
      node.className = 'lab-node' + (done ? ' done' : active ? ' active' : ready ? ' ready' : ' locked');
      const need = (r.req || []).filter(id => !labDone(state, id)).map(id => researchOf(id).name);
      node.innerHTML =
        `<div class="lab-node-head"><b>${done ? '✓ ' : ''}${r.name}</b>` +
        `<span>${done ? '完了' : active ? '研究中' : durStr(researchMs(state, r))}</span></div>` +
        `<p>${r.effect}</p>` +
        (!done && need.length ? `<p class="lab-need">先に：${need.join('・')}</p>` : '');
      if (ready && !active) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn upg-buy' + (state.lab.cur ? '' : ' primary');
        b.textContent = state.lab.cur ? 'ほかの研究中' : '研究する';
        b.disabled = !!state.lab.cur;
        b.addEventListener('click', () => startResearch(r.id));
        node.appendChild(b);
      }
      col.appendChild(node);
    });
    el.labTree.appendChild(col);
  });
}

/* ---------------------------------------------------------------
 * 着せ替え
 *   見た目だけが変わる。強さには関係しない。
 *   解放の条件は毎回その場で判定する（保存するのは選んでいるものだけ）。
 * ------------------------------------------------------------- */
function achCount(s) { return Object.keys(s.ach || {}).filter(k => s.ach[k]).length; }

const THEMES = [
  { id: 'default', name: '夜（標準）', how: 'はじめから',             test: () => true },
  { id: 'chalk',   name: '黒板',       how: '転生を1回する',          test: s => s.stats.prestiges >= 1 },
  { id: 'paper',   name: 'ノート',     how: '実績を15個達成する',     test: s => achCount(s) >= 15 },
  { id: 'sakura',  name: '夜桜',       how: 'チャレンジを3つクリア',  test: s => clearedCount(s) >= 3 },
  { id: 'neon',    name: 'ネオン',     how: '研究を5つ終える',        test: s => labCount(s) >= 5 },
  { id: 'gold',    name: '黄金',       how: '称号「到達者」を得る',   test: s => goalTier(s) >= 1 },
  { id: 'cosmos',  name: '宇宙',       how: 'すべての目標を達成する', test: s => goalTier(s) >= GOAL_TIERS.length },
];
const EFFECTS = [
  { id: 'flash',    name: '光る（標準）', how: 'はじめから',               test: () => true },
  { id: 'none',     name: 'なし',         how: 'はじめから',               test: () => true },
  { id: 'pop',      name: '弾む',         how: '全問正解のラウンドを10回', test: s => (s.stats.perfects || 0) >= 10 },
  { id: 'confetti', name: '紙吹雪',       how: '合計1,000問正解する',      test: s => s.stats.correct >= 1000 },
];

// 選んでいるものが使えなくなっていたら（最初からやり直したときなど）標準に戻す
function currentTheme(s) {
  const t = THEMES.find(x => x.id === s.look.theme);
  return t && t.test(s) ? t.id : 'default';
}
function currentEffect(s) {
  const e = EFFECTS.find(x => x.id === s.look.effect);
  return e && e.test(s) ? e.id : 'flash';
}

function applyLook() {
  document.documentElement.dataset.theme = currentTheme(state);
}

// 答えた直後の式カードの見た目
function judgeClass(ok) {
  if (!ok) return 'flash-ng';
  const fx = currentEffect(state);
  if (fx === 'none') return '';
  if (fx === 'pop') return 'flash-ok pop-ok';
  return 'flash-ok';
}

function spawnConfetti(host) {
  const colors = ['var(--accent)', 'var(--warn)', 'var(--bad)', 'var(--text)'];
  for (let i = 0; i < 16; i++) {
    const p = document.createElement('span');
    p.className = 'confetti';
    const a = Math.random() * Math.PI * 2;
    const d = 60 + Math.random() * 90;
    p.style.setProperty('--dx', `${Math.cos(a) * d}px`);
    p.style.setProperty('--dy', `${Math.sin(a) * d - 30}px`);
    p.style.setProperty('--rot', `${Math.round(Math.random() * 720 - 360)}deg`);
    p.style.background = colors[i % colors.length];
    host.appendChild(p);
    setTimeout(() => p.remove(), 900);
  }
}

function renderLookList(container, defs, current, onPick, preview) {
  container.innerHTML = '';
  defs.forEach(d => {
    const open = d.test(state);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'look' + (d.id === current ? ' selected' : '') + (open ? '' : ' locked');
    b.disabled = !open;
    b.innerHTML = (preview ? preview(d) : '') +
      `<span class="look-name">${d.id === current ? '✓ ' : ''}${d.name}</span>` +
      `<small>${open ? (d.id === current ? '使用中' : '選べる') : `解放：${d.how}`}</small>`;
    b.addEventListener('click', () => onPick(d.id));
    container.appendChild(b);
  });
}

function renderLooks() {
  applyLook();
  renderLookList(el.themeList, THEMES, currentTheme(state), id => {
    state.look.theme = id;
    save();
    renderLooks();
  }, d => `<span class="look-preview" data-theme="${d.id}">
             <i style="background:var(--bg)"></i><i style="background:var(--panel)"></i>
             <i style="background:var(--accent)"></i><i style="background:var(--warn)"></i></span>`);
  renderLookList(el.effectList, EFFECTS, currentEffect(state), id => {
    state.look.effect = id;
    save();
    renderLooks();
  });
}

let pendingChallenge = null;   // 「本当に始める？」を出しているチャレンジ

function renderChallenges() {
  const c = challengeOf(state.challenge);
  el.chBanner.classList.toggle('hidden', !c);
  if (c) {
    el.chBanner.innerHTML =
      `<b>チャレンジ中：${c.name}</b>　${c.rule}　／　目標 合計 <b>${logGoalStr(c.goal)}</b>` +
      `（いまの最高 ${state.chBest > 0 ? logGoalStr(Math.floor(state.chBest)) : '—'}）`;
  }

  el.chCount.textContent = `${clearedCount(state)} / ${CHALLENGES.length}`;
  el.chList.innerHTML = '';
  CHALLENGES.forEach(ch => {
    const done = cleared(state, ch.id);
    const active = inChallenge(state, ch.id);
    const div = document.createElement('div');
    div.className = 'upg challenge' + (done ? ' maxed' : '') + (active ? ' active' : '');
    div.innerHTML =
      `<div class="upg-head">
         <span class="upg-name">${ch.name}</span>
         <span class="upg-level">${done ? 'クリア済み' : active ? '挑戦中' : `目標 ${logGoalStr(ch.goal)}`}</span>
       </div>
       <p class="upg-now">制限: ${ch.rule}</p>
       <p class="upg-next">クリア報酬: ${ch.reward}・+${ch.sigma} Σ</p>`;

    const btns = document.createElement('div');
    btns.className = 'ch-btns';
    const button = (text, cls, onClick, disabled = false) => {
      const b = document.createElement('button');
      b.className = `btn upg-buy ${cls}`;
      b.textContent = text;
      b.disabled = disabled;
      b.addEventListener('click', onClick);
      btns.appendChild(b);
    };
    if (active) {
      button('やめる（制限を外して、このまま続ける）', '', quitChallenge);
    } else if (done) {
      // クリア済みは挑戦できない
    } else if (!canChallenge(state)) {
      button('転生を1回すると挑戦できる', '', () => {}, true);
    } else if (pendingChallenge === ch.id) {
      const gain = sigmaGain(state);
      button(`始める（いまの強化はリセット${gain >= 1 ? `・${fmt(gain)} Σ を受け取る` : ''}）`, 'danger',
             () => startChallenge(ch.id));
      button('やめる', '', () => { pendingChallenge = null; renderChallenges(); });
    } else {
      button('挑戦する', 'primary', () => { pendingChallenge = ch.id; renderChallenges(); });
    }
    if (btns.children.length) div.appendChild(btns);
    el.chList.appendChild(div);
  });
}

// チャレンジを始める。いまの周回の Σ は受け取ってから、まっさらな状態でやり直す
function startChallenge(id) {
  const gain = sigmaGain(state);
  const carried = {
    sigma: state.sigma + Math.max(0, gain),
    sigmaTotal: state.sigmaTotal + Math.max(0, gain),
    perm: state.perm,
    stats: state.stats,
    ach: state.ach,
    chDone: state.chDone,
    lab: state.lab,
    look: state.look,
    challenge: id,
  };
  state = Object.assign(newState(), carried);
  if (gain >= 1) state.stats.prestiges += 1;
  applyPerm(state);
  pendingChallenge = null;
  save();

  round = null;
  showScreen('calc');
  showCalcView('idle');
  renderAll();
}

// チャレンジをやめる。制限が外れるだけで、周回はそのまま続く
function quitChallenge() {
  state.challenge = null;
  applyPerm(state);
  save();
  renderAll();
}

function renderOps() {
  el.ops.innerHTML = '';
  OP_ORDER.forEach(id => {
    const op = OPS[id];
    const unlocked = state.unlocked[id] && !opBanned(state, id);
    const on = unlocked && state.enabled[id];

    const label = document.createElement('label');
    label.className = 'op-toggle' + (on ? ' on' : '') + (unlocked ? '' : ' locked');

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = on;
    box.disabled = !unlocked;
    box.addEventListener('change', () => {
      state.enabled[id] = box.checked;
      // 最低ひとつは有効にしておく
      if (enabledOps(state).length === 0) state.enabled[id] = true;
      save();
      renderAll();
    });

    label.appendChild(box);
    label.append(`${op.label} (${op.symbol})`);
    el.ops.appendChild(label);
  });
}

function renderRespec() {
  const refund = spentOnUpgrades(state);
  el.btnRespec.textContent = V.cmp(refund, 0) > 0
    ? `アップグレードを振り直す（${fmt(refund)} T 返却）`
    : 'アップグレードを振り直す';
  el.btnRespec.disabled = V.cmp(refund, 0) <= 0;
  el.respecConfirm.classList.add('hidden');
}

function renderStats() {
  const acc = state.stats.answered
    ? Math.round((state.stats.correct / state.stats.answered) * 100)
    : 0;
  const rows = [
    ['所持 Tポイント', fmt(state.points)],
    ['累計獲得 Tポイント', fmt(state.stats.earned)],
    ['1ラウンドの自己ベスト', `${fmt(state.stats.best)} T`],
    ['ラウンド数', state.stats.rounds],
    ['正答率', `${acc}%  (${state.stats.correct} / ${state.stats.answered})`],
    ['1ラウンドの出題', `${state.problems} 問`],
    ['いまの式', state.manualLog !== null
      ? `${V.fmt(V.sci(3, currentLog(state)))} 前後 × ${state.terms}個（たし算・手動）`
      : state.sciMode
        ? `${V.fmt(V.sci(3, currentLog(state)))} 前後 × ${state.terms}個（たし算）`
        : `${state.digits}桁の数字 × ${state.terms}個（たし算）`],
    ...(state.unlocked.mul ? [['かけ算の項数', `${state.mulTerms}個`]] : []),
    ['演算ボーナス', `+${varietyBonus(state)}`],
    ['報酬の基礎値', `⌊log${sub10(state.logBase)}(合計) × ${REWARD_SCALE}⌋`],
    ['パーフェクトボーナス', state.perfectLevel ? `+${state.perfectLevel}` : 'なし'],
    ['部分点', state.partialLevel ? `${partialRate(state) * 100}%` : 'なし'],
    ['報酬倍率', `×${multiplier(state).toFixed(2)}`],
    ['所持Σ / 累計Σ', `${fmt(state.sigma)} / ${fmt(state.sigmaTotal)}`],
    ['Σによる報酬ボーナス', `+${(sigmaBonus(state) * 100).toFixed(0)}%`],
    ['基礎値の底上げ', state.perm.baseBoost ? `+${permBoost(state)}` : 'なし'],
    ['連続正解', state.comboLevel
      ? `${fmt(state.combo)} 連鎖（報酬 ×${comboMult(state).toFixed(2)}）` : 'なし'],
    ['一発勝負', state.allInCut ? `−${state.allInCut} 問（報酬 ×${allInMult(state).toFixed(2)}）` : 'なし'],
    ['利息', state.interestLevel ? `ラウンドごとに +${(interestRate(state) * 100).toFixed(0)}%` : 'なし'],
    ['指数的報酬', hasPowBoost(state) ? `基礎値の ${expRewardPow(state).toFixed(2)} 乗` : 'なし'],
    ['オート計算', state.auto
      ? (state.autoOn ? `入（${(autoDelay(state) / 1000).toFixed(1)} 秒に1問）` : '切')
      : 'なし'],
    ['転生回数', `${fmt(state.stats.prestiges)} 回`],
    ...(goalTier(state)
      ? [['称号', `${tierTitle(state)}（目標 ${goalTier(state)} / ${GOAL_TIERS.length}）`],
         ['次の目標', nextTier(state)
           ? `${towerStr(nextTier(state).tower)}（到達度 ${goalProgress(state).toFixed(2)}%）`
           : 'すべて達成！']]
      : [['最終目標への到達度',
          `${goalProgress(state).toFixed(2)}%（${towerStr(state.stats.bestTower)}）`]]),
    ['この周回の獲得', `${fmt(state.runEarned)} T`],
  ];
  el.stats.innerHTML = rows
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('');
}

function renderAll() {
  el.points.textContent = fmt(state.points);
  el.idleProblems.textContent = roundSize(state);
  renderUpgrades();
  renderOps();
  renderAuto();
  renderAllIn();
  renderCombo();
  renderRespec();
  renderPrestige();
  renderChallenges();
  renderLab();
  renderLooks();
  renderStats();
  renderAchievements();
}

/* ---------------------------------------------------------------
 * セーブ / ロード
 * ------------------------------------------------------------- */
function save() {
  checkAchievements();
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  } catch (e) {
    /* file:// などで保存できない環境では黙って諦める */
  }
}

function load() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    state = Object.assign(newState(), data);
    state.unlocked = Object.assign({ add: true, sub: false, mul: false, div: false, pow: false }, data.unlocked);
    state.enabled  = Object.assign({ add: true, sub: false, mul: false, div: false, pow: false }, data.enabled);
    state.stats    = Object.assign({ rounds: 0, earned: 0, correct: 0, answered: 0, best: 0,
                                     prestiges: 0, bestTower: -Infinity, goal: false }, data.stats);
    if (state.stats.bestTower === null) state.stats.bestTower = -Infinity;
    // 目標の段階ができる前のセーブは、自己最高までの目標をまとめて達成済みにする
    if (state.stats.goalTier === undefined) {
      state.stats.goalTier = 0;
      reachTiers(state, state.stats.bestTower);
    }
    state.stats = Object.assign({ perfects: 0, bestStreak: 0, bought: 0 }, state.stats);
    state.ach = Object.assign({}, data.ach);
    state.chDone = Object.assign({}, data.chDone);
    if (!challengeOf(state.challenge)) state.challenge = null;
    state.lab  = Object.assign({ done: {}, cur: null }, data.lab);
    state.lab.done = Object.assign({}, state.lab.done);
    state.look = Object.assign({ theme: 'default', effect: 'flash' }, data.look);
    state.perm     = Object.assign(
      { sigmaPower: 0, baseBoost: 0, startCash: 0, keep: 0, startDigits: 0, startProblems: 0,
        sigmaExp: 0, skip: 0, expMul: 0, powExp: 0, expEff: 0, expDiscount: 0 },
      data.perm);
    // 昔のセーブの「演算の持ち越し」を「引き継ぎ」に読みかえる
    if (data.perm && data.perm.carryOps && !state.perm.keep) state.perm.keep = 1;
  } catch (e) {
    state = newState();
  }
}

/* ---------------------------------------------------------------
 * イベント
 * ------------------------------------------------------------- */
document.getElementById('btn-start').addEventListener('click', startRound);
document.getElementById('btn-to-upgrade').addEventListener('click', () => showScreen('upgrade'));
document.getElementById('allin-minus').addEventListener('click', () => changeAllIn(-1));
document.getElementById('allin-plus').addEventListener('click', () => changeAllIn(1));
el.autoToggle.addEventListener('change', () => {
  setAuto(el.autoToggle.checked);
});

// オートの入/切。ヘッダーのボタン・チェックボックス・Esc キーの全部がここを通る
function setAuto(on) {
  if (!autoUsable(state)) return;
  state.autoOn = on;
  if (!on) clearTimeout(autoTimer);   // 次の1問が走る前に確実に止める
  save();
  renderAll();
}
el.autoStop.addEventListener('click', () => setAuto(!state.autoOn));
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Escape' || editing || !autoUsable(state) || !state.autoOn) return;
  ev.preventDefault();
  setAuto(false);
});
document.getElementById('btn-edit-expr').addEventListener('click', startEdit);
document.getElementById('btn-expr-apply').addEventListener('click', applyEdit);
document.getElementById('btn-expr-cancel').addEventListener('click', cancelEdit);
document.getElementById('btn-to-prestige').addEventListener('click', () => showScreen('prestige'));
document.getElementById('btn-prestige-back').addEventListener('click', () => showScreen('upgrade'));
document.getElementById('btn-prestige-calc').addEventListener('click', startRound);
el.btnPrestige.addEventListener('click', () => {
  if (sigmaGain(state) < 1) return;
  el.prestigeConfirm.classList.remove('hidden');
  el.btnPrestige.disabled = true;
});
document.getElementById('btn-prestige-yes').addEventListener('click', doPrestige);
document.getElementById('btn-prestige-no').addEventListener('click', () => {
  el.prestigeConfirm.classList.add('hidden');
  el.btnPrestige.disabled = false;
});
document.getElementById('btn-to-calc').addEventListener('click', startRound);
el.labChip.addEventListener('click', () => showScreen('lab'));
document.getElementById('btn-lab-back').addEventListener('click', () => showScreen('upgrade'));
// 解いている途中で研究を見に来たときは、そのラウンドに戻る
document.getElementById('btn-lab-calc').addEventListener('click', () => {
  if (round && round.index < round.problems.length) showScreen('calc');
  else startRound();
});

function trySubmit() {
  if (locked || !round || round.index >= round.problems.length) return;
  submitAnswer(el.input.value);
}

el.form.addEventListener('submit', ev => {
  ev.preventDefault();
  trySubmit();
});

// 環境によっては input 内の Enter が submit を発火しないので明示的に拾う
el.input.addEventListener('keydown', ev => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    trySubmit();
  }
});

/* ---------------------------------------------------------------
 * テンキー（マウス・指での入力）
 * ------------------------------------------------------------- */
const MAX_INPUT_LEN = 15;

// スマホ・タブレットでは、画面内のテンキーを使うので
// OS のソフトキーボードがせり上がってこないようにする。
// （物理キーボードからの入力はそのまま使える）
const TOUCH_DEVICE = window.matchMedia
  ? window.matchMedia('(pointer: coarse)').matches
  : 'ontouchstart' in window;

if (TOUCH_DEVICE) el.input.setAttribute('inputmode', 'none');

// ボタンを押しても入力欄のフォーカスを外さない（キーボード併用のため）
el.keypad.addEventListener('mousedown', ev => ev.preventDefault());

el.keypad.addEventListener('click', ev => {
  const btn = ev.target.closest('.key');
  if (!btn) return;
  pressKey(btn.dataset.key);
});

function renderCombo() {
  const on = state.comboLevel > 0;
  el.combo.classList.toggle('hidden', !on);
  if (!on) return;
  el.combo.textContent = `${fmt(state.combo)} 連鎖 ×${comboMult(state).toFixed(2)}` +
    (state.combo >= comboCap(state) ? ' 上限' : '');
}

function renderAllIn() {
  el.allInRow.classList.toggle('hidden', !state.allIn);
  if (!state.allIn) return;
  el.allInValue.textContent = `${state.allInCut} 問減らす`;
  el.allInInfo.innerHTML =
    `1ラウンド <b>${roundSize(state)}</b> 問　／　報酬 ×${allInMult(state).toFixed(2)}`;
}

function changeAllIn(d) {
  const next = state.allInCut + d;
  if (next < 0 || state.problems - next < 1) return;
  state.allInCut = next;
  save();
  renderAll();
}

// 案内文の出し分け（「.」「E」キーはいつでも使える）
function renderKeypad() {
  const base = TOUCH_DEVICE
    ? '画面のテンキーで入力します'
    : 'マウスでもキーボードでも入力できます（Enter キーで決定）';
  const p = round && round.problems[round.index];
  const bigInt = !useSci(state) && p && V.isSci(p.answer);
  el.playHint.textContent = base +
    (useSci(state) ? '　／　E は ×10ⁿ（3E50 = 3×10⁵⁰）' : '') +
    (bigInt ? '　／　答えが大きいので、上から7桁が合っていれば正解' : '');
}

// いま入力している文字列がどんな数なのかを下に出す
function renderPreview() {
  const text = normalizeInput(el.input.value);
  const v = text === '' ? null : V.parse(text);
  el.preview.innerHTML = (v === null || !/[eE]/.test(text)) ? '' : `= ${fmtH(v)}`;
}

function pressKey(key) {
  if (locked) return;                 // ○× を見せている間は受けつけない
  if (key === 'enter') { trySubmit(); return; }
  if (key === 'clear') { el.input.value = ''; }
  else if (key === 'back') { el.input.value = el.input.value.slice(0, -1); }
  else if (el.input.value.length < MAX_INPUT_LEN) { el.input.value += key; }
  renderPreview();
  el.input.focus();
}

document.getElementById('btn-respec').addEventListener('click', () => {
  el.respecText.innerHTML =
    `買ったアップグレードをすべて白紙に戻し、<b>${fmt(spentOnUpgrades(state))} T</b> を返します。` +
    `<br>Σ・永続強化・これまでの記録はそのまま残ります。`;
  el.respecConfirm.classList.remove('hidden');
});
document.getElementById('btn-respec-yes').addEventListener('click', () => {
  el.respecConfirm.classList.add('hidden');
  doRespec();
});
document.getElementById('btn-respec-no').addEventListener('click', () => {
  el.respecConfirm.classList.add('hidden');
});
document.getElementById('btn-reset').addEventListener('click', () => {
  el.resetConfirm.classList.remove('hidden');
});
document.getElementById('btn-reset-yes').addEventListener('click', () => {
  el.resetConfirm.classList.add('hidden');
  doReset();
});
document.getElementById('btn-reset-no').addEventListener('click', () => {
  el.resetConfirm.classList.add('hidden');
});

/* ---------------------------------------------------------------
 * 起動
 * ------------------------------------------------------------- */
load();
checkResearch();       // 閉じている間に終わった研究を受け取る
showScreen('calc');    // はじめは計算画面だけ
showCalcView('idle');
renderAll();
setInterval(tickLab, 1000);
