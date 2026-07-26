export type VolatilityPoint = {
  rv20: number | null;
  rv60: number | null;
  percentile: number | null;
  acceleration: number | null;
  referenceCount: number;
  ready: boolean;
};

export type RegimeBar = { date?: string; close: number };

export type DividendFactorPoint = {
  date: string;
  dividendYield: number | null;
  governmentBond10Y: number | null;
};

export type PriceVolatilityRegimePoint = {
  date: string;
  distance: number | null;
  pricePercentile: number | null;
  volatility: VolatilityPoint;
  states: Array<"price-low" | "price-deep-low" | "volatility-stress">;
  confirmedStates: Array<"price-low" | "price-deep-low" | "volatility-stress">;
  confirmedAt: Partial<Record<"price-low" | "price-deep-low" | "volatility-stress", string>>;
  incomplete: boolean;
};

export type RegimeSegment = {
  state: "price-low" | "price-deep-low" | "volatility-stress";
  start: string;
  end: string;
  endDate: string;
  confirmedAt: string;
  closedAt: string | null;
  incomplete: boolean;
  qualifyingDays: number;
  segments: Array<{ start: string; end: string; qualifyingDays: number }>;
};

export type PriceVolatilityRegimeResult = {
  readiness: "ready" | "spread-history-insufficient" | "incomplete";
  jointStatesEnabled: boolean;
  points: PriceVolatilityRegimePoint[];
  intervals: RegimeSegment[];
};

export type DurableBreakLabel = {
  index: number;
  date: string;
  horizon: 10 | 20;
  breakIndex: number | null;
  label: boolean;
  eligible: boolean;
  observable: boolean;
};

export type ShadowRiskResult = {
  status: "insufficient-evidence";
  probability: null;
  modelKind: "price-volatility";
  riskBand: "unavailable" | "already-below" | "low" | "elevated" | "high";
  primaryFactor: "distance" | "volatility-percentile" | null;
  evidence: { distance: number | null; volatilityPercentile: number | null; volatility20: number | null };
  labels: DurableBreakLabel[];
};

const VOLATILITY_WINDOW = 756;
const MIN_REFERENCE = 252;
const MA_WINDOW = 250;
const REGIME_NAMES = ["price-low", "price-deep-low", "volatility-stress"] as const;
type RegimeName = typeof REGIME_NAMES[number];

function closesFrom(input: number[] | RegimeBar[]) {
  return input.map((value) => typeof value === "number" ? value : value.close);
}

function sampleStd(values: number[]) {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function percentileMidrank(reference: number[], value: number) {
  const lower = reference.filter((item) => item < value).length;
  const equal = reference.filter((item) => item === value).length;
  return (lower + equal / 2) / reference.length;
}

function rollingMean(values: number[], index: number, width: number) {
  if (index < width - 1) return null;
  const window = values.slice(index - width + 1, index + 1);
  return window.every((value) => Number.isFinite(value) && value > 0)
    ? window.reduce((sum, value) => sum + value, 0) / width
    : null;
}

/**
 * Every percentile at T uses only volatility observations available strictly
 * before T.  That is intentional: it keeps both live evaluation and replay
 * free of future leakage.
 */
export function computeVolatilitySeries(input: number[] | RegimeBar[]): VolatilityPoint[] {
  const closes = closesFrom(input);
  const logReturns = closes.map((close, index) => index > 0 && close > 0 && closes[index - 1] > 0
    ? Math.log(close / closes[index - 1])
    : null);
  const rv20: Array<number | null> = closes.map((_, index) => {
    const values = logReturns.slice(Math.max(1, index - 19), index + 1).filter((value): value is number => value !== null);
    return values.length === 20 ? sampleStd(values)! * Math.sqrt(252) : null;
  });
  const rv60: Array<number | null> = closes.map((_, index) => {
    const values = logReturns.slice(Math.max(1, index - 59), index + 1).filter((value): value is number => value !== null);
    return values.length === 60 ? sampleStd(values)! * Math.sqrt(252) : null;
  });
  return closes.map((_, index) => {
    const value = rv20[index];
    // The reference is [T-756, T), never includes today's completed RV20.
    const reference = rv20.slice(Math.max(0, index - VOLATILITY_WINDOW), index).filter((item): item is number => item !== null);
    const ready = value !== null && reference.length >= MIN_REFERENCE;
    return {
      rv20: value,
      rv60: rv60[index],
      percentile: ready ? percentileMidrank(reference, value) : null,
      acceleration: value !== null && rv60[index] !== null ? value / rv60[index]! - 1 : null,
      referenceCount: reference.length,
      ready,
    };
  });
}

export function volatilityEntryCap(point: Pick<VolatilityPoint, "ready" | "percentile">) {
  if (!point.ready || point.percentile === null) return .75;
  if (point.percentile < .75) return 1;
  if (point.percentile < .9) return .75;
  return .5;
}

/** A cap is an entry permission, not a liquidation signal. */
export function applyNewTacticalVolatilityCap(currentPosition: number, candidate: number, cap: number) {
  return candidate > currentPosition && candidate > .5 ? Math.min(candidate, cap) : candidate;
}

function distanceSeries(closes: number[]) {
  return closes.map((close, index) => {
    const ma = rollingMean(closes, index, MA_WINDOW);
    return ma === null ? null : close / ma - 1;
  });
}

function hasEnoughSpreadHistory(bars: RegimeBar[], factors: DividendFactorPoint[]) {
  const available = new Set(factors.filter((point) => point.dividendYield !== null && point.governmentBond10Y !== null).map((point) => point.date));
  return bars.filter((bar) => available.has(bar.date ?? "")).length >= MIN_REFERENCE;
}

function confirmedStates(raw: Array<Set<RegimeName>>, known: Array<Set<RegimeName>>, dates: string[]) {
  const result = raw.map(() => new Set<RegimeName>());
  const confirmedAt = raw.map((): Partial<Record<RegimeName, string>> => ({}));
  const incomplete = raw.map(() => false);
  for (const state of REGIME_NAMES) {
    let active = false, run = 0, falseRun = 0, missingRun = 0;
    for (let index = 0; index < raw.length; index += 1) {
      const hit = raw[index].has(state);
      if (!active) {
        run = hit ? run + 1 : 0;
        if (run >= 3) {
          active = true;
          const date = dates[index];
          for (let fill = index - 2; fill <= index; fill += 1) { result[fill].add(state); confirmedAt[fill][state] = date; }
        }
        continue;
      }
      if (hit) { falseRun = 0; missingRun = 0; result[index].add(state); continue; }
      if (known[index].has(state)) {
        falseRun += 1; missingRun = 0;
        if (falseRun >= 3) { active = false; run = 0; continue; }
        result[index].add(state); // active until the third known-false day confirms exit
        continue;
      }
      missingRun += 1; falseRun = 0;
      if (missingRun > 5) { active = false; run = 0; incomplete[index] = true; continue; }
      result[index].add(state); // display joins short missing gaps, retaining raw segments below
    }
  }
  return { result, confirmedAt, incomplete };
}

function buildIntervals(points: PriceVolatilityRegimePoint[]) {
  const intervals: RegimeSegment[] = [];
  for (const state of REGIME_NAMES) {
    let open: RegimeSegment | null = null;
    let gap = 0;
    for (const point of points) {
      const hit = point.confirmedStates.includes(state) && !point.incomplete;
      const qualifying = point.states.includes(state);
      if (hit) {
        if (!open) open = { state, start: point.date, end: point.date, endDate: point.date, confirmedAt: point.confirmedAt[state] ?? point.date, closedAt: null, incomplete: false, qualifyingDays: 0, segments: [] };
        if (qualifying) {
          if (gap > 0 || open.segments.length === 0) open.segments.push({ start: point.date, end: point.date, qualifyingDays: 0 });
          const segment = open.segments.at(-1)!;
          segment.end = point.date; segment.qualifyingDays += 1; open.qualifyingDays += 1;
        }
        open.end = point.date; open.endDate = point.date; gap = qualifying ? 0 : gap + 1;
      } else if (open) {
        open.closedAt = point.date;
        open.incomplete = point.incomplete;
        if (open.qualifyingDays >= 5) intervals.push(open);
        open = null; gap = 0;
      }
    }
    if (open && open.qualifyingDays >= 5) intervals.push(open);
  }
  return intervals.sort((a, b) => a.start.localeCompare(b.start));
}

export function computePriceVolatilityRegimes(bars: RegimeBar[], factorPoints: DividendFactorPoint[] = []): PriceVolatilityRegimeResult {
  const closes = bars.map((bar) => bar.close);
  const distances = distanceSeries(closes);
  const volatility = computeVolatilitySeries(closes);
  const raw = distances.map((distance, index) => {
    const reference = distances.slice(Math.max(0, index - VOLATILITY_WINDOW), index).filter((item): item is number => item !== null);
    const pricePercentile = distance !== null && reference.length >= MIN_REFERENCE ? percentileMidrank(reference, distance) : null;
    const states = new Set<RegimeName>();
    if (distance !== null && pricePercentile !== null && pricePercentile <= .1) states.add("price-deep-low");
    else if (distance !== null && pricePercentile !== null && pricePercentile <= .2 && distance < 0) states.add("price-low");
    if (volatility[index].ready && volatility[index].percentile! >= .9) states.add("volatility-stress");
    const known = new Set<RegimeName>();
    if (distance !== null && pricePercentile !== null) { known.add("price-low"); known.add("price-deep-low"); }
    if (volatility[index].ready) known.add("volatility-stress");
    return { pricePercentile, states, known };
  });
  const jointStatesEnabled = hasEnoughSpreadHistory(bars, factorPoints);
  const confirmed = confirmedStates(raw.map((item) => item.states), raw.map((item) => item.known), bars.map((bar, index) => bar.date ?? String(index)));
  const points = bars.map((bar, index) => ({
    date: bar.date ?? String(index),
    distance: distances[index],
    pricePercentile: raw[index].pricePercentile,
    volatility: volatility[index],
    states: [...raw[index].states],
    confirmedStates: [...confirmed.result[index]],
    confirmedAt: confirmed.confirmedAt[index],
    incomplete: confirmed.incomplete[index],
  }));
  const intervals = buildIntervals(points);
  return {
    readiness: jointStatesEnabled ? "ready" : "spread-history-insufficient",
    jointStatesEnabled,
    points,
    intervals,
  };
}

export function computeDurableMaBreakLabels(bars: RegimeBar[]): DurableBreakLabel[] {
  const distances = distanceSeries(bars.map((bar) => bar.close));
  return ([10, 20] as const).flatMap((horizon) => distances.map((distance, index) => {
    const eligible = distance !== null && distance >= 0;
    const observable = index + 22 < distances.length;
    if (!eligible || !observable) return { index, date: bars[index].date ?? String(index), horizon, breakIndex: null, label: false, eligible, observable };
    let breakIndex: number | null = null;
    for (let candidate = index + 1; candidate <= Math.min(index + horizon, distances.length - 4); candidate += 1) {
      if (distances[candidate - 1] !== null && distances[candidate - 1]! >= 0 && distances[candidate] !== null && distances[candidate]! < 0) {
        const below = distances.slice(candidate + 1, candidate + 4).filter((item) => item !== null && item < 0).length;
        if (below >= 2) { breakIndex = candidate; break; }
      }
    }
    return { index, date: bars[index].date ?? String(index), horizon, breakIndex, label: breakIndex !== null, eligible, observable };
  }));
}

export function computePriceVolatilityShadowRisk(bars: RegimeBar[]): ShadowRiskResult {
  const regimes = computePriceVolatilityRegimes(bars);
  const point = regimes.points.at(-1);
  const volatilityPercentile = point?.volatility.percentile ?? null;
  const distance = point?.distance ?? null;
  const riskBand = distance === null ? "unavailable"
    : distance < 0 ? "already-below"
      : volatilityPercentile !== null && volatilityPercentile >= .9 ? "high" : "low";
  const primaryFactor = distance === null ? null
    : volatilityPercentile !== null && volatilityPercentile >= .9 ? "volatility-percentile" : "distance";
  return {
    status: "insufficient-evidence",
    probability: null,
    modelKind: "price-volatility",
    riskBand,
    primaryFactor,
    evidence: { distance, volatilityPercentile, volatility20: point?.volatility.rv20 ?? null },
    labels: computeDurableMaBreakLabels(bars),
  };
}
