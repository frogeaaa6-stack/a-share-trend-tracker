import assert from "node:assert/strict";
import test from "node:test";
import {
  applyNewTacticalVolatilityCap,
  computeDurableMaBreakLabels,
  computePriceVolatilityRegimes,
  computeVolatilitySeries,
  computePriceVolatilityShadowRisk,
  volatilityEntryCap,
} from "../lib/strategy/dividendRegime.ts";
import { backtestDividendLadder } from "../lib/strategy/dividendLadder.ts";

function bars(length = 900, start = 100) {
  return Array.from({ length }, (_, index) => {
    const close = start * (1 + Math.sin(index / 9) * .006 + index * .00004);
    return { date: `D${index}`, open: close * 1.001, high: close * 1.01, low: close * .99, close, volume: 1_000_000 };
  });
}

test("volatility percentile is point-in-time and becomes ready with exactly 252 prior observations", () => {
  const closes = bars(600).map((bar) => bar.close);
  const short = computeVolatilitySeries(closes.slice(0, 300));
  const long = computeVolatilitySeries(closes);
  assert.equal(short[271].ready, false);
  assert.equal(short[271].referenceCount, 251);
  assert.equal(short[272].ready, true);
  assert.equal(short[272].referenceCount, 252);
  assert.deepEqual(long[299], short[299], "future prices must not alter T's volatility point");
});

test("volatility entry cap honors the 75th and 90th percentile boundaries", () => {
  assert.equal(volatilityEntryCap({ ready: false, percentile: null }), .75);
  assert.equal(volatilityEntryCap({ ready: true, percentile: .749999 }), 1);
  assert.equal(volatilityEntryCap({ ready: true, percentile: .75 }), .75);
  assert.equal(volatilityEntryCap({ ready: true, percentile: .899999 }), .75);
  assert.equal(volatilityEntryCap({ ready: true, percentile: .9 }), .5);
});

test("volatility guard caps only a new tactical tranche and never reduces existing exposure", () => {
  assert.equal(applyNewTacticalVolatilityCap(.5, .75, .5), .5);
  assert.equal(applyNewTacticalVolatilityCap(1, 1, .5), 1);
  assert.equal(applyNewTacticalVolatilityCap(.5, .5, .5), .5);
  assert.equal(applyNewTacticalVolatilityCap(.2, .5, .5), .5, "cold-start/core 50% is unaffected");
});

test("joint regimes fail closed when same-day spread history is insufficient", () => {
  const data = bars(600);
  const regimes = computePriceVolatilityRegimes(data, data.slice(0, 251).map((bar) => ({ date: bar.date, dividendYield: .04, governmentBond10Y: .02 })));
  assert.equal(regimes.readiness, "spread-history-insufficient");
  assert.equal(regimes.jointStatesEnabled, false);
});

test("durable annual-line break labels require confirmation and drop the unobservable tail", () => {
  const data = bars(360, 100).map((bar, index) => ({ ...bar, close: index < 280 ? 100 : 90 }));
  const labels = computeDurableMaBreakLabels(data);
  assert.ok(labels.some((label) => label.label && label.horizon === 20));
  assert.ok(labels.filter((label) => label.index >= data.length - 22).every((label) => !label.observable && !label.label && label.breakIndex === null));
  assert.ok(labels.filter((label) => label.label === false).some((label) => !label.eligible || !label.observable), "training callers must exclude non-eligible/non-observable negatives");
  const shadow = computePriceVolatilityShadowRisk(data);
  assert.equal(shadow.status, "insufficient-evidence");
  assert.equal(shadow.probability, null);
  assert.equal(shadow.modelKind, "price-volatility");
});

test("backtest retains v4 enhanced control beside v5 volatility-guarded curve", () => {
  const report = backtestDividendLadder(bars());
  assert.equal(typeof report.enhanced.total, "number");
  assert.equal(typeof report.volatilityGuarded.total, "number");
});
