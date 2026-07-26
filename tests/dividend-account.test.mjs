import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateDividendAccount,
  DIVIDEND_STRATEGY_CAPITAL,
} from "../lib/strategy/dividendAccount.ts";

const trade = (overrides) => ({
  id: crypto.randomUUID(),
  tradeDate: "2026-07-20",
  side: "buy",
  price: 1.2,
  units: 10_000,
  amount: null,
  fee: 5,
  note: "",
  createdAt: "2026-07-20T08:00:00.000Z",
  ...overrides,
});

test("starts the separate live strategy with fixed 50,000 capital", () => {
  const summary = calculateDividendAccount([]);
  assert.equal(summary.capital, DIVIDEND_STRATEGY_CAPITAL);
  assert.equal(summary.cash, 50_000);
  assert.equal(summary.units, 0);
  assert.equal(summary.totalPnl, 0);
  assert.equal(summary.allocation, 0);
  assert.equal(summary.costBasis, 0);
  assert.equal(summary.strategyAllocation, 0);
});

test("replays real fills with weighted cost, fees and marked profit", () => {
  const buy = trade({});
  const sell = trade({
    id: crypto.randomUUID(),
    tradeDate: "2026-07-22",
    side: "sell",
    price: 1.3,
    units: 4_000,
    fee: 5,
    createdAt: "2026-07-22T08:00:00.000Z",
  });
  const summary = calculateDividendAccount([sell, buy], 1.25);
  assert.equal(summary.cash, 43_190);
  assert.equal(summary.units, 6_000);
  assert.equal(summary.averageCost, 1.2005);
  assert.equal(summary.realizedPnl, 393);
  assert.equal(summary.unrealizedPnl, 297);
  assert.equal(summary.accountEquity, 50_690);
  assert.equal(summary.totalPnl, 690);
  assert.equal(summary.costBasis, 7_203);
  assert.equal(summary.strategyAllocation, .1441);
});

test("keeps the executed strategy tier independent from daily market moves", () => {
  const fills = [trade({ price: 1.25, units: 20_000, fee: 5 })];
  const down = calculateDividendAccount(fills, 1);
  const up = calculateDividendAccount(fills, 1.5);
  assert.equal(down.strategyAllocation, .5);
  assert.equal(up.strategyAllocation, .5);
  assert.notEqual(down.allocation, up.allocation);
});

test("adds actual cash distributions to the dividend strategy return", () => {
  const summary = calculateDividendAccount([
    trade({}),
    trade({
      id: crypto.randomUUID(),
      tradeDate: "2026-07-21",
      side: "dividend",
      price: 0,
      units: 0,
      amount: 280,
      fee: 0,
      createdAt: "2026-07-21T08:00:00.000Z",
    }),
  ], 1.2);
  assert.equal(summary.dividendIncome, 280);
  assert.equal(summary.cash, 38_275);
  assert.equal(summary.totalPnl, 275);
});

test("rejects fills that exceed the live account cash or position", () => {
  assert.throws(
    () => calculateDividendAccount([trade({ price: 6, units: 10_000 })]),
    /超过当时可用现金/,
  );
  assert.throws(
    () => calculateDividendAccount([trade({ side: "sell", units: 100 })]),
    /超过当时持仓/,
  );
});
