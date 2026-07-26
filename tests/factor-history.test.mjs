import assert from "node:assert/strict";
import test from "node:test";
import { assembleDividendLadderFactorHistory } from "../lib/factors/dividendLadderFactorHistory.ts";

test("short official history reports evidence limits instead of backfilling a long series", () => {
  const history = assembleDividendLadderFactorHistory(
    [{ date: "2026-07-24", value: .0476 }],
    [],
  );
  assert.equal(history.status, "partial");
  assert.equal(history.spread[0].value, null);
  assert.equal(history.coverage.dividendObservations, 1);
  assert.equal(history.coverage.sameDaySpreadObservations, 0);
  assert.match(history.limitations.join(" "), /不能构造长期股息率回测/);
});
