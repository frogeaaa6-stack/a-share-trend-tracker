import assert from "node:assert/strict";
import test from "node:test";
import { parseEastmoneyNoon, parseTencentNoon, validateNoonSnapshots } from "../lib/market/noonSnapshot.ts";

const date = "2026-07-27";
function times() {
  return Array.from({ length: 121 }, (_, index) => {
    const minute = 9 * 60 + 30 + index;
    return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  });
}
function eastmoney(rows = times()) {
  return {
    data: {
      trends: rows.map((time, index) => {
        const last = index === rows.length - 1;
        const volume = last ? 3_855_425 - (rows.length - 1) * 10 : 10;
        const amount = last ? 448_280_357 - (rows.length - 1) * 1_000 : 1_000;
        return `${date} ${time},1.161,1.163,1.168,1.158,${volume},${amount},1.16`;
      }),
    },
  };
}
function tencent(rows = times(), last = "1.163") {
  return { data: { sh512890: { data: { date: "20260727", data: rows.map((time, index) => `${time.replace(":", "")} ${index === rows.length - 1 ? last : "1.161"} 3855425 448280357`) } } } };
}
function response(provider, snapshot) {
  return { provider, requestUrl: "fixture", raw: {}, bars: [snapshot], attempts: 1 };
}

test("parses and dual-source validates a complete 11:30 noon snapshot", () => {
  const primary = parseEastmoneyNoon(eastmoney(), date);
  const secondary = parseTencentNoon(tencent(), date);
  assert.equal(primary.rowCount, 121);
  assert.equal(primary.open, 1.161);
  assert.equal(primary.high, 1.168);
  assert.equal(primary.low, 1.158);
  assert.equal(primary.close, 1.163);
  assert.equal(primary.volume, 3_855_425, "Eastmoney per-minute volume is summed through 11:30");
  assert.equal(primary.amount, 448_280_357, "Eastmoney per-minute amount is summed through 11:30");
  const result = validateNoonSnapshots(response("eastmoney", primary), response("tencent", secondary), date);
  assert.equal(result.verified, true);
  assert.equal(result.snapshot?.provider, "eastmoney");
});

test("rejects missing date or 11:30 minute", () => {
  assert.throws(() => parseEastmoneyNoon(eastmoney(times().slice(0, -1)), date), /complete 09:30/);
  assert.throws(() => parseEastmoneyNoon(eastmoney(times().filter((time) => time !== "10:15")), date), /complete 09:30/);
  assert.throws(() => parseTencentNoon({ data: { sh512890: { data: { date: "20260726", data: [] } } } }, date), /requested Shanghai date/);
});

test("accepts a lower-precision Tencent snapshot at 8–17 bps, warns, and keeps Eastmoney canonical", () => {
  const primary = parseEastmoneyNoon(eastmoney(), date);
  // Tencent minute rows have one price column. Model its lower OHLC precision
  // by moving each OHLC field together, which must remain below the 50 bp gate.
  const secondary = {
    ...primary,
    provider: "tencent",
    open: 1.163,
    high: 1.170,
    low: 1.160,
    close: 1.165,
    volume: primary.volume * 1.01,
  };
  const result = validateNoonSnapshots(response("eastmoney", primary), response("tencent", secondary), date);
  assert.equal(result.verified, true);
  assert.equal(result.quality.grade, "B");
  assert.ok(result.quality.maxPriceDiffBps > 15 && result.quality.maxPriceDiffBps < 50);
  assert.ok(result.issues.some((issue) => issue.code === "NOON_OHLC_WARNING" && issue.severity === "warning"));
  assert.ok(result.issues.some((issue) => issue.code === "NOON_TURNOVER_WARNING" && issue.severity === "warning"));
  assert.equal(result.snapshot, primary, "published noon values always originate from Eastmoney");
});

test("rejects noon OHLC disagreement above 50 bps", () => {
  const primary = parseEastmoneyNoon(eastmoney(), date);
  const secondary = parseTencentNoon(tencent(times(), "1.180"), date);
  const result = validateNoonSnapshots(response("eastmoney", primary), response("tencent", secondary), date);
  assert.equal(result.verified, false);
  assert.equal(result.quality.grade, "D");
  assert.ok(result.issues.some((issue) => issue.code === "NOON_OHLC_CONFLICT" && issue.severity === "error"));
});

test("rejects noon cumulative turnover disagreement above 2 percent", () => {
  const primary = parseEastmoneyNoon(eastmoney(), date);
  const secondary = {
    ...parseTencentNoon(tencent(), date),
    volume: primary.volume * 1.03,
    amount: primary.amount * 1.03,
  };
  const result = validateNoonSnapshots(response("eastmoney", primary), response("tencent", secondary), date);
  assert.equal(result.verified, false);
  assert.equal(result.quality.grade, "D");
  assert.ok(result.issues.some((issue) => issue.code === "NOON_TURNOVER_CONFLICT" && issue.severity === "error"));
});
