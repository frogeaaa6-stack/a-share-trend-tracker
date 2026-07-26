import assert from "node:assert/strict";
import test from "node:test";
import { backtestDividendLadder, dividendSpreadCap, durationConfirmedFloor, enhancedDividendSpreadCap, enhancedDurationFloor, evaluateDividendLadder, evaluateEnhancedDividendLadder, isExecutableOpen, targetPosition } from "../lib/strategy/dividendLadder.ts";

function bars(length = 800, start = 100) {
  return Array.from({ length }, (_, index) => {
    const close = start * (1 - index * .00005);
    return { date: `2023-${String(Math.floor(index / 20) + 1).padStart(2, "0")}-${String(index % 20 + 1).padStart(2, "0")}`, open: close * 1.001, high: close * 1.004, low: close * .996, close, volume: 1_000_000 };
  });
}

test("ladder target applies the buy floor and recovery sell cap", () => {
  assert.deepEqual(targetPosition(-.16), { buyFloor: 1, sellCap: 1, target: 1 });
  assert.deepEqual(targetPosition(-.10), { buyFloor: .75, sellCap: .75, target: .75 });
  assert.deepEqual(targetPosition(-.013), { buyFloor: .25, sellCap: .25, target: .25 });
  assert.deepEqual(targetPosition(.03), { buyFloor: 0, sellCap: .1, target: 0 });
  assert.deepEqual(targetPosition(-.04, .5), { buyFloor: .25, sellCap: .5, target: .5 });
  assert.deepEqual(targetPosition(-.09, .75), { buyFloor: .5, sellCap: .75, target: .75 });
});

test("decision enforces verified, non-stale data for new buys but permits sell instructions", () => {
  const data = bars(270);
  const buy = evaluateDividendLadder(data, 0, { verified: false, stale: false });
  assert.equal(buy.action, "review");
  assert.ok(buy.gates.some((gate) => gate.includes("双源验证")));
  const sell = evaluateDividendLadder(data, .75, { verified: false, stale: true });
  assert.equal(sell.action, "sell");
});

test("duration confirmation delays early buys and scales at 3/10/20/40 days", () => {
  assert.equal(durationConfirmedFloor(-.01, 2), 0);
  assert.equal(durationConfirmedFloor(-.01, 3), .25);
  assert.equal(durationConfirmedFloor(-.06, 9), .25);
  assert.equal(durationConfirmedFloor(-.06, 10), .5);
  assert.equal(durationConfirmedFloor(-.11, 20), .75);
  assert.equal(durationConfirmedFloor(-.16, 40), 1);
});

test("dividend spread caps only new buys and does not force a sale", () => {
  assert.equal(dividendSpreadCap(.0149), .25);
  assert.equal(dividendSpreadCap(.015), .5);
  assert.equal(dividendSpreadCap(.025), .75);
  assert.equal(dividendSpreadCap(.03), 1);
  const data = Array.from({ length: 310 }, (_, index) => {
    const close = index < 270 ? 100 : 80;
    return { date: `D${index}`, open: close, high: close * 1.01, low: close * .99, close, volume: 1_000_000 };
  });
  const decision = evaluateDividendLadder(data, .75, undefined, { dividendYield: .03, governmentBond10Y: .02, verified: true });
  assert.equal(decision.factorCap, .25);
  assert.equal(decision.target, .75);
  assert.equal(decision.action, "hold");
});

test("hybrid profile cold-starts instead of immediately buying the 50% core", () => {
  assert.equal(enhancedDurationFloor(.02, 0), .5);
  assert.equal(enhancedDurationFloor(-.04, 4), .5);
  assert.equal(enhancedDurationFloor(-.04, 5), .75);
  assert.equal(enhancedDurationFloor(-.09, 14), .75);
  assert.equal(enhancedDurationFloor(-.09, 15), 1);
  assert.equal(enhancedDividendSpreadCap(.014, true), .5);
  assert.equal(enhancedDividendSpreadCap(.02, true), .75);
  assert.equal(enhancedDividendSpreadCap(.03, true), 1);
  assert.equal(enhancedDividendSpreadCap(.03, false), .75);
  const data = bars(300, 100);
  const decision = evaluateEnhancedDividendLadder(data, 0, undefined, { dividendYield: .048, governmentBond10Y: .018, verified: true });
  assert.equal(decision.target, 0);
  assert.equal(decision.phase, "cold-start");
  assert.equal(decision.coldStartTradingDays, 0);
  assert.equal(decision.nextTarget, .2);
  assert.equal(decision.nextDeadlineTradingDay, 63);
  assert.ok(decision.pendingRules.some((rule) => rule.includes("第 21 个交易日")));
});

test("cold-start time fallbacks build the core in 20/35/50% stages", () => {
  const data = bars(300, 100);
  const first = evaluateEnhancedDividendLadder(data, 0, undefined, null, true, { coldStartTradingDays: 21 });
  assert.equal(first.action, "buy");
  assert.equal(first.target, .2);
  assert.ok(first.matchedRules.some((rule) => rule.includes("时间兜底命中")));

  const second = evaluateEnhancedDividendLadder(data, .2, undefined, null, true, { coldStartTradingDays: 63 });
  assert.equal(second.target, .35);
  assert.equal(second.nextTarget, .35);
  assert.equal(second.nextDeadlineTradingDay, 105);

  const third = evaluateEnhancedDividendLadder(data, .35, undefined, null, true, { coldStartTradingDays: 126 });
  assert.equal(third.target, .5);
  assert.equal(third.nextDeadlineTradingDay, 168);
});

test("cold-start elapsed trading days can be derived from a persisted start date", () => {
  const data = bars(300, 100);
  const decision = evaluateEnhancedDividendLadder(
    data,
    0,
    undefined,
    null,
    true,
    { coldStartDate: data[data.length - 22].date },
  );
  assert.equal(decision.coldStartTradingDays, 21);
  assert.equal(decision.target, .2);
});

test("20-day rebound pauses normal cold-start attempts but hard deadlines override it", () => {
  const data = bars(300, 100);
  for (let index = data.length - 20; index < data.length; index += 1) {
    const close = 94 + (index - (data.length - 20)) * .32;
    Object.assign(data[index], { open: close, high: close * 1.004, low: close * .996, close });
  }
  const paused = evaluateEnhancedDividendLadder(data, 0, undefined, null, true, { coldStartTradingDays: 21 });
  assert.equal(paused.action, "hold");
  assert.equal(paused.target, 0);
  assert.ok(paused.rebound20Pct >= .06);
  assert.ok(paused.pendingRules.some((rule) => rule.includes("反弹过滤生效")));

  const forced = evaluateEnhancedDividendLadder(data, 0, undefined, null, true, { coldStartTradingDays: 63 });
  assert.equal(forced.action, "buy");
  assert.equal(forced.target, .2);
  assert.ok(forced.matchedRules.some((rule) => rule.includes("硬截止命中")));
  assert.ok(forced.matchedRules.some((rule) => rule.includes("硬截止优先")));
  assert.equal(evaluateEnhancedDividendLadder(data, .2, undefined, null, true, { coldStartTradingDays: 105 }).target, .35);
  assert.equal(evaluateEnhancedDividendLadder(data, .35, undefined, null, true, { coldStartTradingDays: 168 }).target, .5);
});

test("price acceleration advances each cold-start stage before its time fallback", () => {
  const firstData = bars(300, 100);
  for (let index = firstData.length - 6; index < firstData.length; index += 1) {
    Object.assign(firstData[index], { open: 95, high: 95.3, low: 94.7, close: 95 });
  }
  const first = evaluateEnhancedDividendLadder(firstData, 0, undefined, null, true);
  assert.equal(first.target, .2);
  assert.ok(first.matchedRules.some((rule) => rule.includes("价格加速命中")));

  const secondData = bars(300, 100);
  for (let index = secondData.length - 11; index < secondData.length; index += 1) {
    Object.assign(secondData[index], { open: 90, high: 90.3, low: 89.7, close: 90 });
  }
  assert.equal(evaluateEnhancedDividendLadder(secondData, .2, undefined, null, true).target, .35);

  const thirdData = bars(300, 100);
  for (let index = thirdData.length - 16; index < thirdData.length; index += 1) {
    Object.assign(thirdData[index], { open: 82, high: 82.3, low: 81.7, close: 82 });
  }
  assert.equal(evaluateEnhancedDividendLadder(thirdData, .35, undefined, null, true).target, .5);
});

test("cold-start still requires verified non-stale market data", () => {
  const data = bars(300, 100);
  const decision = evaluateEnhancedDividendLadder(
    data,
    0,
    { verified: false, stale: false },
    null,
    true,
    { coldStartTradingDays: 63 },
  );
  assert.equal(decision.action, "review");
  assert.equal(decision.target, 0);
  assert.ok(decision.gates.some((gate) => gate.includes("双源验证")));
});

test("tactical tranches and their guards activate only after the 50% core is complete", () => {
  const data = bars(300, 100);
  const tail = [96, 96, 96, 95, 95.5, 96];
  tail.forEach((close, offset) => {
    const index = data.length - tail.length + offset;
    Object.assign(data[index], { open: close, high: close * 1.004, low: close * .996, close });
  });
  const decision = evaluateEnhancedDividendLadder(
    data,
    .5,
    undefined,
    { dividendYield: .048, governmentBond10Y: .018, verified: true },
    false,
    { enableVolatilityGuard: false },
  );
  assert.equal(decision.phase, "core-tactical");
  assert.equal(decision.target, .75);
  assert.ok(decision.matchedRules.some((rule) => rule.includes("第一机动档")));
});

test("entry-only factor caps never turn an existing tactical holding into a sell", () => {
  const data = bars(300, 100);
  for (let index = data.length - 16; index < data.length; index += 1) {
    Object.assign(data[index], { open: 90, high: 90.4, low: 89.6, close: 90 });
  }
  const decision = evaluateEnhancedDividendLadder(
    data,
    .75,
    undefined,
    { dividendYield: .03, governmentBond10Y: .02, verified: true },
  );
  assert.equal(decision.phase, "core-tactical");
  assert.ok(decision.durationBuyFloor >= 1);
  assert.ok(decision.target >= .75);
  assert.notEqual(decision.action, "sell");
  assert.ok(decision.pendingRules.some((rule) => rule.includes("已有 75% 保持")));
  assert.ok(!decision.pendingRules.some((rule) => rule.includes("当前最多 50%")));
});

test("execution rejects unavailable or one-price opens", () => {
  assert.equal(isExecutableOpen({ date: "2026-01-01", close: 1, volume: 1 }), false);
  assert.equal(isExecutableOpen({ date: "2026-01-01", close: 1, open: 1, volume: 0 }), false);
  assert.equal(isExecutableOpen({ date: "2026-01-01", close: 1, open: 1, high: 1, low: 1, volume: 1 }), false);
  assert.equal(isExecutableOpen({ date: "2026-01-01", close: 1, open: 1, high: 1.01, low: .99, volume: 1 }), true);
});

test("backtest queues T close decisions for T+1 open without lookahead", () => {
  const data = bars();
  const report = backtestDividendLadder(data);
  assert.equal(report.ready, true);
  assert.equal(report.shortSample, true);
  assert.ok(report.trades.length > 0);
  const first = report.trades[0];
  const signalIndex = data.findIndex((bar) => bar.date === first.signalDate);
  const executionIndex = data.findIndex((bar) => bar.date === first.date);
  assert.equal(executionIndex, signalIndex + 1);
  assert.equal(first.price, data[executionIndex].open);
  assert.equal(first.units % 100, 0);
  assert.equal(typeof report.ladder.total, "number");
  assert.equal(typeof report.enhanced.total, "number");
  assert.equal(typeof report.volatilityGuarded.total, "number");
  assert.equal(typeof report.immediateCore.total, "number");
  assert.equal(typeof report.baseline.total, "number");
  assert.equal(typeof report.buyHold.maxDrawdown, "number");
});
