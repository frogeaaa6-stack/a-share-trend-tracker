import assert from "node:assert/strict";
import test from "node:test";
import { buildTencentFqklineUrl, mergeTencentPages, parseEastmoney, parseTencent, previousTencentPageEnd } from "../lib/market/providers.ts";
import { normalizeDays, normalizeSymbol } from "../lib/market/symbols.ts";
import { crossValidate, sanitizeBars } from "../lib/market/validation.ts";

const testBars = Array.from({ length: 30 }, (_, index) => {
  const date = `2026-07-${String(index + 1).padStart(2, "0")}`;
  const open = 4.1 + index / 100;
  const close = open + 0.01;
  return { date, open, close, high: close + 0.02, low: open - 0.02, volume: 1_000_000 + index * 10_000, amount: 4_000_000 + index * 50_000 };
});

const eastmoneyFixture = { data: { klines: testBars.map((bar) => [bar.date, bar.open, bar.close, bar.high, bar.low, bar.volume, bar.amount].join(",")) } };

const tencentFixture = { data: { sh510300: { qfqday: testBars.map((bar) => [bar.date, bar.open, bar.close, bar.high, bar.low, bar.volume]) } } };

test("normalizes only canonical symbols and constrains lookback", () => {
  assert.deepEqual(normalizeSymbol("510300.sh"), { symbol: "510300.SH", code: "510300", exchange: "SH", eastmoneySecid: "1.510300", tencentSymbol: "sh510300" });
  assert.throws(() => normalizeSymbol("https://example.com"));
  assert.equal(normalizeDays(undefined), 120);
  assert.equal(normalizeDays(2000), 2000);
  assert.throws(() => normalizeDays(2));
  assert.throws(() => normalizeDays(2001));
});

test("parses two provider fixtures and publishes matching days", () => {
  const symbol = normalizeSymbol("510300.SH");
  const result = crossValidate(
    { provider: "eastmoney", requestUrl: "fixture", raw: eastmoneyFixture, bars: parseEastmoney(eastmoneyFixture) },
    { provider: "tencent", requestUrl: "fixture", raw: tencentFixture, bars: parseTencent(tencentFixture, symbol) },
  );
  assert.equal(result.verified, true);
  assert.equal(result.bars.length, 30);
  assert.equal(result.quality.conflictDays, 0);
  assert.equal(result.quality.grade, "A");
  assert.equal(result.quality.overlapDays, 30);
  assert.equal(result.quality.agreementPct, 100);
  assert.equal(result.quality.maxPriceDiffBps, 0);
});

test("accepts Tencent daily fallback and isolates impossible dates, duplicates and critical conflicts", () => {
  const primary = parseEastmoney(eastmoneyFixture);
  const dailyFallback = { data: { sh510300: { day: tencentFixture.data.sh510300.qfqday } } };
  const secondary = parseTencent(dailyFallback, normalizeSymbol("510300.SH"));
  secondary[29] = { ...secondary[29], close: 5.5, high: 5.6 };
  primary.push(primary[0]);
  primary.push({ ...primary[0], date: "2026-02-30" });
  const sanitized = sanitizeBars(primary, "eastmoney");
  assert.equal(sanitized.bars.length, 30);
  assert.ok(sanitized.issues.some((issue) => issue.code === "DUPLICATE_DATE"));
  assert.ok(sanitized.issues.some((issue) => issue.code === "INVALID_BAR"));
  const result = crossValidate(
    { provider: "eastmoney", requestUrl: "fixture", raw: eastmoneyFixture, bars: primary },
    { provider: "tencent", requestUrl: "fixture", raw: tencentFixture, bars: secondary },
  );
  assert.equal(result.bars.length, 29);
  assert.equal(result.quality.conflictDays, 1);
  assert.ok(result.issues.some((issue) => issue.code === "OHLC_CONFLICT"));
  assert.equal(result.verified, false);
});

test("keeps a valid bar when Tencent's seventh field is corporate-action metadata", () => {
  const rows = tencentFixture.data.sh510300.qfqday.map((row) => [...row]);
  rows[12].push({ type: "dividend", note: "provider metadata, not turnover amount" });
  const raw = { data: { sh510300: { qfqday: rows } } };
  const parsed = parseTencent(raw, normalizeSymbol("510300.SH"));

  assert.equal(parsed.length, 30);
  assert.equal(parsed[12].amount, undefined);
  const result = crossValidate(
    { provider: "eastmoney", requestUrl: "fixture", raw: eastmoneyFixture, bars: parseEastmoney(eastmoneyFixture) },
    { provider: "tencent", requestUrl: "fixture", raw, bars: parsed },
  );
  assert.equal(result.verified, true);
  assert.equal(result.bars.length, 30);
});

test("merges overlapping Tencent pages without duplicate boundary dates", () => {
  const latestPage = [
    { ...testBars[2], close: 9.99 },
    testBars[3],
    testBars[4],
  ];
  const previousPage = [testBars[0], testBars[1], testBars[2]];

  const merged = mergeTencentPages([latestPage, previousPage], 5);
  assert.deepEqual(merged.map((bar) => bar.date), testBars.slice(0, 5).map((bar) => bar.date));
  assert.equal(merged[2].close, 9.99, "the most recent page owns an overlapping boundary row");
});

test("builds a bounded Tencent history page ending before the prior page", () => {
  assert.equal(previousTencentPageEnd("2026-03-01"), "2026-02-28");
  assert.equal(previousTencentPageEnd("2024-03-01"), "2024-02-29");
  const url = new URL(buildTencentFqklineUrl("sh510300", 640, "2024-02-29"));
  assert.equal(url.searchParams.get("param"), "sh510300,day,,2024-02-29,640,qfq");
});
