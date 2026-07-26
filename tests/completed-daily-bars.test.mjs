import assert from "node:assert/strict";
import test from "node:test";
import {
  canServeCompleteOnly,
  completedDailyBarError,
  shanghaiCalendarDate,
} from "../lib/market/completedDailyBars.ts";

test("uses the Shanghai date and rejects an intraday bar from T-1 alerts", () => {
  const shanghaiNoon = new Date("2026-07-24T04:00:00.000Z");
  assert.equal(shanghaiCalendarDate(shanghaiNoon), "2026-07-24");
  assert.match(completedDailyBarError("2026-07-24", true, shanghaiNoon), /T-1/);
  assert.match(completedDailyBarError("2026-07-24", false, shanghaiNoon), /15:10/);
  assert.equal(completedDailyBarError("2026-07-23", true, shanghaiNoon), null);
});

test("accepts today's daily bar only after close for non-scheduled alerts", () => {
  const afterClose = new Date("2026-07-24T07:15:00.000Z");
  assert.equal(completedDailyBarError("2026-07-24", false, afterClose), null);
  assert.match(completedDailyBarError("2026-07-24", true, afterClose), /T-1/);
});

test("never serves a complete-only fallback containing the excluded date", () => {
  assert.equal(canServeCompleteOnly("2026-07-23", "2026-07-24"), true);
  assert.equal(canServeCompleteOnly("2026-07-24", "2026-07-24"), false);
  assert.equal(canServeCompleteOnly(undefined, "2026-07-24"), false);
});
