import { applyNewTacticalVolatilityCap, computeVolatilitySeries, volatilityEntryCap, type VolatilityPoint } from "./dividendRegime";

export type DividendLadderBar = {
  date: string;
  close: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
};

export type DividendLadderFactors = {
  dividendYield: number | null;
  dividendDate?: string;
  governmentBond10Y: number | null;
  rateDate?: string;
  verified?: boolean;
};

export type LadderPhase = "standard" | "cold-start" | "core-tactical";

export type EnhancedLadderOptions = {
  coldStartDate?: string;
  coldStartTradingDays?: number;
  immediateCore?: boolean;
  /** Suppress only for the preserved v4 replay control. Live evaluation is guarded by default. */
  enableVolatilityGuard?: boolean;
  volatilityPoint?: VolatilityPoint;
};

export type LadderDecision = {
  ready: boolean;
  close: number | null;
  ma250: number | null;
  distance: number | null;
  slope20: number | null;
  volumeRatio: number | null;
  belowMaDays: number;
  belowMaSince: string | null;
  priceBuyFloor: number;
  durationBuyFloor: number;
  dividendYield: number | null;
  governmentBond10Y: number | null;
  dividendSpread: number | null;
  factorCap: number;
  factorMode: "strict" | "degraded" | "not-backtested";
  buyFloor: number;
  sellCap: number;
  target: number | null;
  action: "buy" | "sell" | "hold" | "review";
  label: string;
  gates: string[];
  phase: LadderPhase;
  matchedRules: string[];
  pendingRules: string[];
  coldStartTradingDays: number | null;
  rebound20Pct: number | null;
  nextTarget: number | null;
  nextDeadlineTradingDay: number | null;
  volatility20: number | null;
  volatilityPercentile: number | null;
  volatilityReferenceCount: number;
  volatilityReady: boolean;
  volatilityEntryCap: number;
};

export type LadderTrade = {
  signalDate: string;
  date: string;
  side: "买入" | "卖出";
  price: number;
  units: number;
  target: number;
  reason: string;
};

export type LadderBacktest = {
  ready: boolean;
  usableBars: number;
  shortSample: boolean;
  enhanced: { total: number; annual: number; maxDrawdown: number; trades: number; equity: number[] };
  volatilityGuarded: { total: number; annual: number; maxDrawdown: number; trades: number; equity: number[] };
  immediateCore: { total: number; annual: number; maxDrawdown: number; trades: number; equity: number[] };
  ladder: { total: number; annual: number; maxDrawdown: number; trades: number; equity: number[] };
  baseline: { total: number; annual: number; maxDrawdown: number; trades: number; equity: number[] };
  buyHold: { total: number; annual: number; maxDrawdown: number; equity: number[] };
  trades: LadderTrade[];
};

const WINDOW = 250;
const WARMUP_INDEX = 269; // A 20-day MA250 slope first becomes available here.
type EvaluationMode = "live" | "duration-backtest" | "price-only-v1";

function average(values: number[]) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function validNumber(value: number | undefined): value is number { return typeof value === "number" && Number.isFinite(value); }

export function targetPosition(distance: number, currentPosition = 0) {
  const buyFloor = distance <= -.15 ? 1 : distance <= -.10 ? .75 : distance <= -.05 ? .5 : distance < 0 ? .25 : 0;
  const sellCap = distance >= .07 ? 0 : distance >= .02 ? .1 : distance >= -.03 ? .25 : distance >= -.08 ? .5 : distance >= -.13 ? .75 : 1;
  const normalizedPosition = Math.min(1, Math.max(0, currentPosition));
  return { buyFloor, sellCap, target: Math.min(Math.max(normalizedPosition, buyFloor), sellCap) };
}

export function durationConfirmedFloor(distance: number, belowMaDays: number) {
  if (distance <= -.15 && belowMaDays >= 40) return 1;
  if (distance <= -.10 && belowMaDays >= 20) return .75;
  if (distance <= -.05 && belowMaDays >= 10) return .5;
  if (distance < 0 && belowMaDays >= 3) return .25;
  return 0;
}

export function dividendSpreadCap(spread: number | null) {
  if (spread === null || !Number.isFinite(spread)) return .25;
  return spread < .015 ? .25 : spread < .025 ? .5 : spread < .03 ? .75 : 1;
}

export function enhancedDurationFloor(distance: number, belowMaDays: number) {
  if (distance <= -.08 && belowMaDays >= 15) return 1;
  if (distance <= -.03 && belowMaDays >= 5) return .75;
  return .5;
}

export function enhancedDividendSpreadCap(spread: number | null, verified = true) {
  if (spread === null || !Number.isFinite(spread) || !verified) return .75;
  return spread < .015 ? .5 : spread < .03 ? .75 : 1;
}

export function isExecutableOpen(bar: DividendLadderBar) {
  if (!validNumber(bar.open) || bar.open! <= 0 || !validNumber(bar.volume) || bar.volume! <= 0) return false;
  return !(validNumber(bar.high) && validNumber(bar.low) && bar.open === bar.high && bar.high === bar.low);
}

function belowMaStreak(bars: DividendLadderBar[]) {
  const closes = bars.map((bar) => bar.close);
  const prefix = [0];
  for (const close of closes) prefix.push(prefix.at(-1)! + close);
  let days = 0;
  let since: string | null = null;
  for (let index = closes.length - 1; index >= WINDOW - 1; index -= 1) {
    const ma = (prefix[index + 1] - prefix[index + 1 - WINDOW]) / WINDOW;
    if (closes[index] >= ma) break;
    days += 1;
    since = bars[index].date;
  }
  return { days, since };
}

function emptyDecision(label: string): LadderDecision {
  return {
    ready: false,
    close: null,
    ma250: null,
    distance: null,
    slope20: null,
    volumeRatio: null,
    belowMaDays: 0,
    belowMaSince: null,
    priceBuyFloor: 0,
    durationBuyFloor: 0,
    dividendYield: null,
    governmentBond10Y: null,
    dividendSpread: null,
    factorCap: .25,
    factorMode: "degraded",
    buyFloor: 0,
    sellCap: 1,
    target: null,
    action: "review",
    label,
    gates: ["MA250 与 20 日斜率尚未就绪"],
    phase: "standard",
    matchedRules: [],
    pendingRules: ["等待至少 270 条日线，以计算 MA250 及其 20 日斜率"],
    coldStartTradingDays: null,
    rebound20Pct: null,
    nextTarget: null,
    nextDeadlineTradingDay: null,
    volatility20: null,
    volatilityPercentile: null,
    volatilityReferenceCount: 0,
    volatilityReady: false,
    volatilityEntryCap: .75,
  };
}

export function evaluateDividendLadder(
  bars: DividendLadderBar[],
  currentPosition = 0,
  quality: { verified: boolean; stale: boolean } = { verified: true, stale: false },
  factors: DividendLadderFactors | null = null,
  mode: EvaluationMode = "live",
  suppliedVolatilityPoint?: VolatilityPoint,
): LadderDecision {
  const last = bars.length - 1;
  if (last < WARMUP_INDEX) return emptyDecision("数据不足，至少需要 270 条日线");
  const closes = bars.map((bar) => bar.close);
  const volatilityPoint = suppliedVolatilityPoint ?? computeVolatilitySeries(closes)[last];
  const volatilityCap = volatilityEntryCap(volatilityPoint);
  const close = closes[last], ma250 = average(closes.slice(last - WINDOW + 1, last + 1));
  const priorMa250 = average(closes.slice(last - WINDOW + 1 - 20, last + 1 - 20));
  const distance = close / ma250 - 1, slope20 = ma250 / priorMa250 - 1;
  const volumes = bars.slice(last - 20, last).map((bar) => bar.volume).filter((volume): volume is number => validNumber(volume) && volume > 0);
  const volumeRatio = volumes.length === 20 && validNumber(bars[last].volume) ? bars[last].volume! / average(volumes) : null;
  const streak = belowMaStreak(bars);
  const pricePositions = targetPosition(distance, currentPosition);
  const durationBuyFloor = mode === "price-only-v1"
    ? pricePositions.buyFloor
    : durationConfirmedFloor(distance, streak.days);
  const dividendYield = factors?.dividendYield ?? null;
  const governmentBond10Y = factors?.governmentBond10Y ?? null;
  const dividendSpread = dividendYield !== null && governmentBond10Y !== null ? dividendYield - governmentBond10Y : null;
  const factorMode = mode === "duration-backtest" || mode === "price-only-v1"
    ? "not-backtested"
    : dividendSpread === null ? "degraded" : "strict";
  const factorCap = factorMode === "not-backtested" ? 1 : dividendSpreadCap(dividendSpread);
  const buyFloor = Math.min(durationBuyFloor, factorCap);
  const normalizedPosition = Math.min(1, Math.max(0, currentPosition));
  const composedTarget = Math.min(Math.max(normalizedPosition, buyFloor), pricePositions.sellCap);
  const gates: string[] = [];
  let target = composedTarget;
  const buying = target > currentPosition + .0001;
  if (buying && (!quality.verified || quality.stale)) gates.push("新买入仅限非过期的双源验证数据");
  if (buying && factorMode === "degraded") gates.push("股息率或十年国债利率缺失，降级模式最多新增至 25%");
  if (!buying && pricePositions.buyFloor > durationBuyFloor) {
    const needed = distance <= -.15 ? 40 : distance <= -.10 ? 20 : distance <= -.05 ? 10 : 3;
    gates.push(`连续低于 MA250 仅 ${streak.days} 日，尚未达到 ${needed} 日确认门槛`);
  }
  if (buying && slope20 < -.02) gates.push("MA250 20 日斜率低于 -2%");
  if (buying && target > .25 && !(closes[last] > closes[last - 1] && closes[last - 1] >= closes[last - 2])) gates.push("加仓至 25% 以上需要前一日不再下跌且最新收涨");
  const pause = bars.slice(Math.max(1, last - 2), last + 1).some((bar, offset) => {
    const index = Math.max(1, last - 2) + offset;
    const ret = bar.close / closes[index - 1] - 1;
    const trailingVolumes = bars.slice(Math.max(0, index - 20), index).map((item) => item.volume).filter((volume): volume is number => validNumber(volume) && volume > 0);
    return ret <= -.03 && trailingVolumes.length === 20 && validNumber(bar.volume) && bar.volume! >= average(trailingVolumes) * 1.8;
  });
  if (buying && pause) gates.push("近 3 个交易日出现放量长阴，暂停新买入 3 个交易日");
  if (buying && distance <= -.20) gates.push("偏离 MA250 达到 -20%，停止摊平并人工复核");
  if (buying && gates.length) target = currentPosition;
  if (target < currentPosition - .0001 && (!quality.verified || quality.stale)) gates.push("历史缓存或未通过双源验证：卖出提示仅供人工复核");
  const action = target > currentPosition + .0001 ? "buy" : target < currentPosition - .0001 ? "sell" : gates.length ? "review" : "hold";
  const label = action === "buy"
    ? `${currentPosition <= .0001 && target <= .25 ? "初步建仓" : "分批加仓"}至${Math.round(target * 100)}%`
    : action === "sell"
      ? `调降至${Math.round(target * 100)}%`
      : action === "review"
        ? "人工复核，暂不新增仓位"
        : `维持${Math.round(target * 100)}%`;
  return {
    ready: true,
    close,
    ma250,
    distance,
    slope20,
    volumeRatio,
    belowMaDays: streak.days,
    belowMaSince: streak.since,
    priceBuyFloor: pricePositions.buyFloor,
    durationBuyFloor,
    dividendYield,
    governmentBond10Y,
    dividendSpread,
    factorCap,
    factorMode,
    buyFloor,
    sellCap: pricePositions.sellCap,
    target,
    action,
    label,
    gates,
    phase: "standard",
    matchedRules: [],
    pendingRules: gates.slice(),
    coldStartTradingDays: null,
    rebound20Pct: null,
    nextTarget: null,
    nextDeadlineTradingDay: null,
    volatility20: volatilityPoint.rv20,
    volatilityPercentile: volatilityPoint.percentile,
    volatilityReferenceCount: volatilityPoint.referenceCount,
    volatilityReady: volatilityPoint.ready,
    volatilityEntryCap: volatilityCap,
  };
}

function ma250SlopeAt(closes: number[], index: number) {
  if (index < WARMUP_INDEX) return null;
  const ma = average(closes.slice(index - WINDOW + 1, index + 1));
  const prior = average(closes.slice(index - WINDOW + 1 - 20, index + 1 - 20));
  return ma / prior - 1;
}

const COLD_START_STAGES = [
  { target: .2, distance: -.02, belowMaDays: 5, attemptDay: 21, deadlineDay: 63 },
  { target: .35, distance: -.05, belowMaDays: 10, attemptDay: 63, deadlineDay: 105 },
  { target: .5, distance: -.08, belowMaDays: 15, attemptDay: 126, deadlineDay: 168 },
] as const;

function coldStartElapsed(
  bars: DividendLadderBar[],
  last: number,
  options: EnhancedLadderOptions,
) {
  if (validNumber(options.coldStartTradingDays)) return Math.max(0, Math.floor(options.coldStartTradingDays));
  if (!options.coldStartDate) return 0;
  const exactIndex = bars.findIndex((bar) => bar.date === options.coldStartDate);
  if (exactIndex >= 0) return Math.max(0, last - exactIndex);
  const nextIndex = bars.findIndex((bar) => bar.date > options.coldStartDate!);
  return nextIndex >= 0 && nextIndex <= last ? last - nextIndex : 0;
}

function reboundFrom20DayLow(bars: DividendLadderBar[], last: number) {
  const recent = bars.slice(Math.max(0, last - 19), last + 1);
  const low = Math.min(...recent.map((bar) => validNumber(bar.low) && bar.low! > 0 ? bar.low! : bar.close));
  return low > 0 ? bars[last].close / low - 1 : null;
}

export function evaluateEnhancedDividendLadder(
  bars: DividendLadderBar[],
  currentPosition = 0,
  quality: { verified: boolean; stale: boolean } = { verified: true, stale: false },
  factors: DividendLadderFactors | null = null,
  historicalBacktest = false,
  options: EnhancedLadderOptions = {},
): LadderDecision {
  const last = bars.length - 1;
  if (last < WARMUP_INDEX) return emptyDecision("数据不足，至少需要 270 条日线");
  const closes = bars.map((bar) => bar.close);
  const volatilityPoint = options.volatilityPoint ?? computeVolatilitySeries(closes)[last];
  const volatilityCap = volatilityEntryCap(volatilityPoint);
  const volatilityGuardEnabled = options.enableVolatilityGuard !== false;
  const close = closes[last];
  const ma250 = average(closes.slice(last - WINDOW + 1, last + 1));
  const slope20 = ma250SlopeAt(closes, last)!;
  const distance = close / ma250 - 1;
  const volumes = bars.slice(last - 20, last).map((bar) => bar.volume).filter((volume): volume is number => validNumber(volume) && volume > 0);
  const volumeRatio = volumes.length === 20 && validNumber(bars[last].volume) ? bars[last].volume! / average(volumes) : null;
  const streak = belowMaStreak(bars);
  const rebound20Pct = reboundFrom20DayLow(bars, last);
  const dividendYield = factors?.dividendYield ?? null;
  const governmentBond10Y = factors?.governmentBond10Y ?? null;
  const dividendSpread = dividendYield !== null && governmentBond10Y !== null ? dividendYield - governmentBond10Y : null;
  const factorMode = historicalBacktest
    ? "not-backtested"
    : dividendSpread !== null && factors?.verified ? "strict" : "degraded";
  const factorCap = historicalBacktest ? 1 : enhancedDividendSpreadCap(dividendSpread, factors?.verified === true);
  const normalizedPosition = Math.min(1, Math.max(0, currentPosition));
  const phase: LadderPhase = normalizedPosition < .5 ? "cold-start" : "core-tactical";
  const matchedRules: string[] = [];
  const pendingRules: string[] = [];
  const gates: string[] = [];

  if (phase === "cold-start") {
    const coldStartTradingDays = coldStartElapsed(bars, last, options);
    const nextStage = options.immediateCore
      ? { target: .5, distance: 0, belowMaDays: 0, attemptDay: 0, deadlineDay: 0 }
      : COLD_START_STAGES.find((stage) => normalizedPosition < stage.target - .0001) ?? COLD_START_STAGES.at(-1)!;
    const priceCondition = options.immediateCore
      || (distance <= nextStage.distance && streak.days >= nextStage.belowMaDays);
    const timeAttempt = options.immediateCore || coldStartTradingDays >= nextStage.attemptDay;
    const hardDeadline = options.immediateCore || coldStartTradingDays >= nextStage.deadlineDay;
    const reboundPause = !options.immediateCore
      && rebound20Pct !== null
      && rebound20Pct >= .06
      && distance > -.03;
    const eligible = hardDeadline || (!reboundPause && (priceCondition || timeAttempt));
    const priceBuyFloor = COLD_START_STAGES.reduce<number>(
      (floor, stage) => distance <= stage.distance && streak.days >= stage.belowMaDays ? stage.target : floor,
      0,
    );
    const durationBuyFloor = eligible ? nextStage.target : normalizedPosition;
    let target = eligible ? Math.max(normalizedPosition, nextStage.target) : normalizedPosition;

    matchedRules.push("核心仓尚未达到 50%，当前只执行冷启动分批规则");
    pendingRules.push("卖出侧：核心仓尚未完成，当前没有机动仓可机械回收；核心止盈层仅作人工观察");
    if (options.immediateCore) {
      matchedRules.push("对照模式命中：立即建立 50% 核心仓");
    } else {
      if (priceCondition) {
        matchedRules.push(`价格加速命中：距 MA250 ${Math.round(distance * 10000) / 100}% ≤ ${nextStage.distance * 100}%，连续跌破 ${streak.days} 日 ≥ ${nextStage.belowMaDays} 日`);
      } else {
        pendingRules.push(`价格加速未命中：需距 MA250 ≤ ${nextStage.distance * 100}% 且连续跌破 ≥ ${nextStage.belowMaDays} 日`);
      }
      if (hardDeadline) {
        matchedRules.push(`硬截止命中：冷启动第 ${coldStartTradingDays} 个交易日已达到第 ${nextStage.deadlineDay} 日`);
      } else if (timeAttempt) {
        matchedRules.push(`时间兜底命中：冷启动第 ${coldStartTradingDays} 个交易日已达到第 ${nextStage.attemptDay} 日`);
      } else {
        pendingRules.push(`时间兜底待命：第 ${nextStage.attemptDay} 个交易日尝试，第 ${nextStage.deadlineDay} 个交易日硬截止`);
      }
      if (reboundPause && !hardDeadline) {
        pendingRules.push(`反弹过滤生效：较 20 日低点反弹 ${(rebound20Pct! * 100).toFixed(2)}%，且距 MA250 高于 -3%，暂缓非强制建仓`);
      } else if (reboundPause && hardDeadline) {
        matchedRules.push(`硬截止优先：20 日低点反弹 ${(rebound20Pct! * 100).toFixed(2)}% 的暂缓条件被硬截止覆盖`);
      } else if (rebound20Pct !== null) {
        matchedRules.push(`反弹过滤通过：20 日低点反弹 ${(rebound20Pct * 100).toFixed(2)}%，未触发暂缓`);
      }
    }

    const buying = target > normalizedPosition + .0001;
    if (buying && (!quality.verified || quality.stale)) {
      gates.push("新买入仅限非过期的双源验证数据");
      pendingRules.push("数据护栏未通过：需要非过期的双源验证行情");
      target = normalizedPosition;
    } else if (quality.verified && !quality.stale) {
      matchedRules.push("数据护栏通过：行情已双源验证且未过期");
    }
    const action = target > normalizedPosition + .0001 ? "buy" : gates.length ? "review" : "hold";
    const label = action === "buy"
      ? `${options.immediateCore ? "建立核心仓" : "冷启动分批建仓"}至${Math.round(target * 100)}%`
      : action === "review"
        ? "冷启动数据护栏未通过，维持当前仓位"
        : reboundPause && !hardDeadline
          ? `反弹过滤生效，暂缓${Math.round(nextStage.target * 100)}%核心仓`
          : `等待${Math.round(nextStage.target * 100)}%核心仓条件`;
    return {
      ready: true,
      close,
      ma250,
      distance,
      slope20,
      volumeRatio,
      belowMaDays: streak.days,
      belowMaSince: streak.since,
      priceBuyFloor,
      durationBuyFloor,
      dividendYield,
      governmentBond10Y,
      dividendSpread,
      factorCap,
      factorMode,
      buyFloor: durationBuyFloor,
      sellCap: 1,
      target,
      action,
      label,
      gates,
      phase,
      matchedRules,
      pendingRules,
      coldStartTradingDays,
      rebound20Pct,
      nextTarget: nextStage.target,
      nextDeadlineTradingDay: nextStage.deadlineDay,
      volatility20: volatilityPoint.rv20,
      volatilityPercentile: volatilityPoint.percentile,
      volatilityReferenceCount: volatilityPoint.referenceCount,
      volatilityReady: volatilityPoint.ready,
      volatilityEntryCap: volatilityCap,
    };
  }

  matchedRules.push("50% 核心仓已完成，75% / 100% 机动仓规则已启用");
  const priceBuyFloor = distance <= -.08 ? 1 : distance <= -.03 ? .75 : .5;
  const durationBuyFloor = enhancedDurationFloor(distance, streak.days);
  const sellCap = distance >= -.01 ? .5 : distance >= -.06 ? .75 : 1;
  const riskCap = distance <= -.18 ? .5 : slope20 < -.02 ? .75 : 1;
  let candidate = Math.max(normalizedPosition, durationBuyFloor);
  if (candidate > normalizedPosition + .0001) candidate = Math.max(normalizedPosition, Math.min(candidate, factorCap));
  const beforeVolatilityCap = candidate;
  if (volatilityGuardEnabled) candidate = applyNewTacticalVolatilityCap(normalizedPosition, candidate, volatilityCap);
  let target = Math.min(candidate, sellCap, riskCap);
  if (durationBuyFloor > normalizedPosition + .0001 && factorCap < durationBuyFloor) {
    pendingRules.push(factorCap < normalizedPosition
      ? `股息利差许可上限 ${Math.round(factorCap * 100)}%，仅阻止新增，已有 ${Math.round(normalizedPosition * 100)}% 保持`
      : `股息利差上限限制新增机动仓：新增最多 ${Math.round(factorCap * 100)}%`);
  } else {
    matchedRules.push(`股息利差上限允许最高 ${Math.round(factorCap * 100)}% 仓位`);
  }
  if (volatilityGuardEnabled && beforeVolatilityCap > candidate + .0001) {
    pendingRules.push(volatilityPoint.ready && volatilityPoint.percentile !== null
      ? volatilityCap < normalizedPosition
        ? `波动率分位许可上限 ${Math.round(volatilityCap * 100)}%，仅阻止新增，已有 ${Math.round(normalizedPosition * 100)}% 保持（分位 ${(volatilityPoint.percentile * 100).toFixed(1)}%）`
        : `波动率分位上限限制新增机动仓：新增最多 ${Math.round(volatilityCap * 100)}%（分位 ${(volatilityPoint.percentile * 100).toFixed(1)}%）`
      : volatilityCap < normalizedPosition
        ? `波动率历史不足/未就绪：许可上限 ${Math.round(volatilityCap * 100)}%，仅阻止新增，已有 ${Math.round(normalizedPosition * 100)}% 保持`
        : `波动率历史不足/未就绪：新增机动仓暂最多 ${Math.round(volatilityCap * 100)}%`);
  } else if (volatilityGuardEnabled && candidate > normalizedPosition + .0001 && candidate > .5) {
    matchedRules.push(`波动率护栏通过：新增机动仓上限 ${Math.round(volatilityCap * 100)}%`);
  } else if (!volatilityGuardEnabled) {
    matchedRules.push("v4 对照回测：波动率新增机动仓上限未启用");
  }
  if (sellCap < normalizedPosition - .0001) matchedRules.push(`恢复卖出规则命中：仓位上限降至 ${Math.round(sellCap * 100)}%`);
  else if (normalizedPosition > .75) pendingRules.push(`卖出一级待命：距 MA250 回升至 -6% 时，100% 回收至 75%（当前 ${(distance * 100).toFixed(2)}%）`);
  if (sellCap >= .75 && normalizedPosition > .5) pendingRules.push(`卖出二级待命：距 MA250 回升至 -1% 时，75% 回收至 50%（当前 ${(distance * 100).toFixed(2)}%）`);
  if (normalizedPosition <= .5) matchedRules.push("卖出侧：当前没有机动仓可回收，50% 核心仓不因普通反弹机械卖出");
  if (riskCap < normalizedPosition - .0001) matchedRules.push(`风险上限命中：仓位上限降至 ${Math.round(riskCap * 100)}%`);
  const buying = target > normalizedPosition + .0001;
  const tacticalBuying = buying && target > .5;
  if (distance <= -.03 && streak.days >= 5) matchedRules.push("第一机动档价格与持续时间命中：距 MA250 ≤ -3%，连续跌破 ≥ 5 日");
  else pendingRules.push(`第一机动档待命：需距 MA250 ≤ -3% 且连续跌破 ≥ 5 日（当前 ${(distance * 100).toFixed(2)}%、${streak.days} 日）`);
  if (distance <= -.08 && streak.days >= 15) matchedRules.push("第二机动档价格与持续时间命中：距 MA250 ≤ -8%，连续跌破 ≥ 15 日");
  else pendingRules.push(`第二机动档待命：需距 MA250 ≤ -8% 且连续跌破 ≥ 15 日（当前 ${(distance * 100).toFixed(2)}%、${streak.days} 日）`);
  if (buying && (!quality.verified || quality.stale)) {
    gates.push("新买入仅限非过期的双源验证数据");
    pendingRules.push("数据护栏未通过：需要非过期的双源验证行情");
  } else if (quality.verified && !quality.stale) {
    matchedRules.push("数据护栏通过：行情已双源验证且未过期");
  }
  if (tacticalBuying && slope20 < -.02) {
    gates.push("MA250 20 日斜率低于 -2%，禁止新增机动仓");
    pendingRules.push("趋势护栏未通过：MA250 20 日斜率需不低于 -2%");
  } else if (tacticalBuying) {
    matchedRules.push("趋势护栏通过：MA250 20 日斜率不低于 -2%");
  }
  const recentSlopes = Array.from({ length: 5 }, (_, offset) => ma250SlopeAt(closes, last - 4 + offset));
  if (tacticalBuying && recentSlopes.some((slope) => slope === null || slope < -.01)) {
    gates.push("最近 5 日的 MA250 斜率尚未全部回到 -1% 以上");
    pendingRules.push("趋势修复护栏未通过：最近 5 日 MA250 20 日斜率需全部不低于 -1%");
  } else if (tacticalBuying) {
    matchedRules.push("趋势修复护栏通过：最近 5 日 MA250 20 日斜率均不低于 -1%");
  }
  if (tacticalBuying && !(closes[last] > closes[last - 1] && closes[last - 1] >= closes[last - 2])) {
    gates.push("新增机动仓需要前一日不再下跌且最新收涨");
    pendingRules.push("止跌护栏未通过：需要前一日不再下跌且最新一日收涨");
  } else if (tacticalBuying) {
    matchedRules.push("止跌护栏通过：前一日不再下跌且最新一日收涨");
  }
  const panic = bars.slice(Math.max(1, last - 2), last + 1).some((bar, offset) => {
    const index = Math.max(1, last - 2) + offset;
    const ret = bar.close / closes[index - 1] - 1;
    const trailingVolumes = bars.slice(Math.max(0, index - 20), index).map((item) => item.volume).filter((volume): volume is number => validNumber(volume) && volume > 0);
    return ret <= -.03 && trailingVolumes.length === 20 && validNumber(bar.volume) && bar.volume! >= average(trailingVolumes) * 1.8;
  });
  if (tacticalBuying && panic) {
    gates.push("近 3 个交易日出现放量长阴，暂停新增机动仓");
    pendingRules.push("成交护栏未通过：近 3 个交易日出现放量长阴");
  } else if (tacticalBuying) {
    matchedRules.push("成交护栏通过：近 3 个交易日未出现放量长阴");
  }
  if (tacticalBuying && distance <= -.18) {
    gates.push("偏离 MA250 达到 -18%，停止摊平并回到 50% 核心仓");
    pendingRules.push("极端风险护栏触发：停止摊平并回到 50% 核心仓");
  } else if (tacticalBuying) {
    matchedRules.push("极端风险护栏通过：距 MA250 尚未达到 -18%");
  }
  if (!buying && priceBuyFloor > durationBuyFloor) {
    const needed = distance <= -.08 ? 15 : distance <= -.03 ? 5 : 0;
    if (needed) {
      const gate = `连续低于 MA250 仅 ${streak.days} 日，尚未达到 ${needed} 日机动仓门槛`;
      gates.push(gate);
      pendingRules.push(gate);
    }
  }
  if (buying && gates.length) target = normalizedPosition;
  if (target < normalizedPosition - .0001 && (!quality.verified || quality.stale)) gates.push("历史缓存或未通过双源验证：卖出提示仅供人工复核");
  const action = target > normalizedPosition + .0001 ? "buy" : target < normalizedPosition - .0001 ? "sell" : gates.length ? "review" : "hold";
  const label = action === "buy"
    ? `${target <= .5 ? "建立核心仓" : "增加机动仓"}至${Math.round(target * 100)}%`
    : action === "sell"
      ? `收缩机动仓至${Math.round(target * 100)}%`
      : action === "review"
        ? "护栏未通过，维持当前仓位"
        : `维持${Math.round(target * 100)}%`;
  return {
    ready: true,
    close,
    ma250,
    distance,
    slope20,
    volumeRatio,
    belowMaDays: streak.days,
    belowMaSince: streak.since,
    priceBuyFloor,
    durationBuyFloor,
    dividendYield,
    governmentBond10Y,
    dividendSpread,
    factorCap,
    factorMode,
    buyFloor: Math.min(durationBuyFloor, factorCap),
    sellCap: Math.min(sellCap, riskCap),
    target,
    action,
    label,
    gates,
    phase,
    matchedRules,
    pendingRules,
    coldStartTradingDays: null,
    rebound20Pct,
    nextTarget: null,
    nextDeadlineTradingDay: null,
    volatility20: volatilityPoint.rv20,
    volatilityPercentile: volatilityPoint.percentile,
    volatilityReferenceCount: volatilityPoint.referenceCount,
    volatilityReady: volatilityPoint.ready,
    volatilityEntryCap: volatilityCap,
  };
}

function performance(equity: number[]) {
  const start = equity[0] || 1, end = equity.at(-1) || start;
  let peak = start, maxDrawdown = 0;
  for (const value of equity) { peak = Math.max(peak, value); maxDrawdown = Math.min(maxDrawdown, value / peak - 1); }
  const total = end / start - 1;
  return { total, annual: equity.length > 1 ? (1 + total) ** (252 / (equity.length - 1)) - 1 : 0, maxDrawdown, equity };
}

function simulateEnhancedLadder(
  bars: DividendLadderBar[],
  initialCapital: number,
  fee: number,
  lot: number,
  immediateCore = false,
  enableVolatilityGuard = false,
) {
  let cash = initialCapital, units = 0, strategyPosition = 0, queued: { target: number; signalDate: string } | null = null;
  const equity: number[] = [], trades: LadderTrade[] = [];
  const coldStartDate = bars[WARMUP_INDEX].date;
  // Precomputing is safe because every point's reference excludes its own and future days.
  const volatilitySeries = computeVolatilitySeries(bars);
  const firstDecision = evaluateEnhancedDividendLadder(
    bars.slice(0, WARMUP_INDEX + 1),
    0,
    undefined,
    null,
    true,
    { coldStartDate, immediateCore, enableVolatilityGuard, volatilityPoint: volatilitySeries[WARMUP_INDEX] },
  );
  if ((firstDecision.action === "buy" || firstDecision.action === "sell") && firstDecision.target !== null) queued = { target: firstDecision.target, signalDate: bars[WARMUP_INDEX].date };
  for (let i = WARMUP_INDEX + 1; i < bars.length; i++) {
    const bar = bars[i];
    if (queued && isExecutableOpen(bar)) {
      const accountAtOpen = cash + units * bar.open!;
      const desiredUnits = Math.floor((accountAtOpen * queued.target) / (bar.open! * lot)) * lot;
      if (desiredUnits > units) {
        const affordable = Math.floor(cash / (bar.open! * (1 + fee) * lot)) * lot;
        const purchased = Math.min(desiredUnits - units, affordable);
        if (purchased > 0) {
          cash -= purchased * bar.open! * (1 + fee);
          units += purchased;
          trades.push({ signalDate: queued.signalDate, date: bar.date, side: "买入", price: bar.open!, units: purchased, target: queued.target, reason: "T 日收盘核心+机动仓信号，T+1 开盘执行" });
        }
      } else if (desiredUnits < units) {
        const sold = units - desiredUnits;
        if (sold > 0) {
          cash += sold * bar.open! * (1 - fee);
          units -= sold;
          trades.push({ signalDate: queued.signalDate, date: bar.date, side: "卖出", price: bar.open!, units: sold, target: queued.target, reason: "T 日收盘机动仓回收信号，T+1 开盘执行" });
        }
      }
      strategyPosition = queued.target;
    }
    queued = null;
    equity.push(cash + units * bar.close);
    const decision = evaluateEnhancedDividendLadder(
      bars.slice(0, i + 1),
      strategyPosition,
      undefined,
      null,
      true,
      { coldStartDate, immediateCore, enableVolatilityGuard, volatilityPoint: volatilitySeries[i] },
    );
    if ((decision.action === "buy" || decision.action === "sell") && decision.target !== null) queued = { target: decision.target, signalDate: bar.date };
  }
  return { ...performance(equity), trades, tradeCount: trades.length };
}

function simulateLadder(
  bars: DividendLadderBar[],
  initialCapital: number,
  fee: number,
  lot: number,
  mode: EvaluationMode,
) {
  let cash = initialCapital, units = 0, strategyPosition = 0, queued: { target: number; signalDate: string } | null = null;
  const equity: number[] = [], trades: LadderTrade[] = [];
  const volatilitySeries = computeVolatilitySeries(bars);
  const firstDecision = evaluateDividendLadder(bars.slice(0, WARMUP_INDEX + 1), 0, undefined, null, mode, volatilitySeries[WARMUP_INDEX]);
  if ((firstDecision.action === "buy" || firstDecision.action === "sell") && firstDecision.target !== null) queued = { target: firstDecision.target, signalDate: bars[WARMUP_INDEX].date };
  for (let i = WARMUP_INDEX + 1; i < bars.length; i++) {
    const bar = bars[i];
    if (queued && isExecutableOpen(bar)) {
      const accountAtOpen = cash + units * bar.open!;
      const desiredUnits = Math.floor((accountAtOpen * queued.target) / (bar.open! * lot)) * lot;
      if (desiredUnits > units) {
        const affordable = Math.floor(cash / (bar.open! * (1 + fee) * lot)) * lot;
        const purchased = Math.min(desiredUnits - units, affordable);
        if (purchased > 0) {
          cash -= purchased * bar.open! * (1 + fee);
          units += purchased;
          trades.push({ signalDate: queued.signalDate, date: bar.date, side: "买入", price: bar.open!, units: purchased, target: queued.target, reason: "T 日收盘红利低波分档信号，T+1 开盘执行" });
        }
      } else if (desiredUnits < units) {
        const sold = units - desiredUnits;
        if (sold > 0) {
          cash += sold * bar.open! * (1 - fee);
          units -= sold;
          trades.push({ signalDate: queued.signalDate, date: bar.date, side: "卖出", price: bar.open!, units: sold, target: queued.target, reason: "T 日收盘恢复分档信号，T+1 开盘执行" });
        }
      }
      strategyPosition = queued.target;
    }
    queued = null;
    equity.push(cash + units * bar.close);
    const decision = evaluateDividendLadder(bars.slice(0, i + 1), strategyPosition, undefined, null, mode, volatilitySeries[i]);
    if ((decision.action === "buy" || decision.action === "sell") && decision.target !== null) queued = { target: decision.target, signalDate: bar.date };
  }
  return { ...performance(equity), trades, tradeCount: trades.length };
}

export function backtestDividendLadder(bars: DividendLadderBar[], options: { initialCapital?: number; commissionBps?: number; lotSize?: number } = {}): LadderBacktest {
  const initialCapital = options.initialCapital ?? 100000, fee = (options.commissionBps ?? 8) / 10000, lot = options.lotSize ?? 100;
  const empty = { total: 0, annual: 0, maxDrawdown: 0, trades: 0, equity: [] };
  if (bars.length <= WARMUP_INDEX + 1) return { ready: false, usableBars: 0, shortSample: true, enhanced: empty, volatilityGuarded: empty, immediateCore: empty, ladder: empty, baseline: empty, buyHold: { total: 0, annual: 0, maxDrawdown: 0, equity: [] }, trades: [] };
  // Keep `enhanced` as the v4 control. The new v5 curve is explicitly separate.
  const enhancedRun = simulateEnhancedLadder(bars, initialCapital, fee, lot, false, false);
  const volatilityGuardedRun = simulateEnhancedLadder(bars, initialCapital, fee, lot, false, true);
  const immediateCoreRun = simulateEnhancedLadder(bars, initialCapital, fee, lot, true, false);
  const duration = simulateLadder(bars, initialCapital, fee, lot, "duration-backtest");
  const baselineRun = simulateLadder(bars, initialCapital, fee, lot, "price-only-v1");
  let holdCash = initialCapital, holdUnits = 0, holdStarted = false;
  const holdEquity: number[] = [];
  for (let i = WARMUP_INDEX + 1; i < bars.length; i++) {
    const bar = bars[i];
    if (!holdStarted && isExecutableOpen(bar)) { const lots = Math.floor(holdCash / (bar.open! * (1 + fee) * lot)); holdUnits = lots * lot; holdCash -= holdUnits * bar.open! * (1 + fee); holdStarted = true; }
    holdEquity.push(holdCash + holdUnits * bar.close);
  }
  return {
    ready: true,
    usableBars: duration.equity.length,
    shortSample: duration.equity.length < 750,
    enhanced: { total: enhancedRun.total, annual: enhancedRun.annual, maxDrawdown: enhancedRun.maxDrawdown, trades: enhancedRun.tradeCount, equity: enhancedRun.equity },
    volatilityGuarded: { total: volatilityGuardedRun.total, annual: volatilityGuardedRun.annual, maxDrawdown: volatilityGuardedRun.maxDrawdown, trades: volatilityGuardedRun.tradeCount, equity: volatilityGuardedRun.equity },
    immediateCore: { total: immediateCoreRun.total, annual: immediateCoreRun.annual, maxDrawdown: immediateCoreRun.maxDrawdown, trades: immediateCoreRun.tradeCount, equity: immediateCoreRun.equity },
    ladder: { total: duration.total, annual: duration.annual, maxDrawdown: duration.maxDrawdown, trades: duration.tradeCount, equity: duration.equity },
    baseline: { total: baselineRun.total, annual: baselineRun.annual, maxDrawdown: baselineRun.maxDrawdown, trades: baselineRun.tradeCount, equity: baselineRun.equity },
    buyHold: performance(holdEquity),
    trades: duration.trades,
  };
}
