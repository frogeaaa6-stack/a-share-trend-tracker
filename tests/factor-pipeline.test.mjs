import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { dividendSpreadCap, parseChinaBondHistory, parseCsiDividendWorkbook, parseSinaHistory } from "../lib/factors/dividendLadderFactors.ts";
import { assembleDividendLadderFactorHistory } from "../lib/factors/dividendLadderFactorHistory.ts";

test("parses official CSI D/P2 workbook as a decimal yield", () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["日期Date", "指数代码Index Code", "", "", "", "", "", "", "D/P1", "D/P2"],
    ["20260724", "H30269", "", "", "", "", "", "", "4.82", "4.76"],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "估值");
  const array = XLSX.write(workbook, { type: "array", bookType: "xls" });
  assert.deepEqual(parseCsiDividendWorkbook(array), [{ date: "2026-07-24", value: .0476 }]);
});

test("parses ChinaBond 10Y table and wrapped Sina secondary response", () => {
  const html = "<table><tr><td>中债国债收益率曲线</td><td>2026-07-24</td><td>1</td><td>1</td><td>1</td><td>1</td><td>1</td><td>1</td><td>1.7282</td><td>2</td></tr></table>";
  assert.deepEqual(parseChinaBondHistory(html), [{ date: "2026-07-24", value: .017282 }]);
  const sina = { code: 0, result: { data: [{ d: "2026-07-24", c: "1.725" }] } };
  assert.deepEqual(parseSinaHistory(sina), [{ date: "2026-07-24", value: .01725 }]);
});

test("factor cap uses the four declared dividend spread bands", () => {
  assert.equal(dividendSpreadCap(null), .25);
  assert.equal(dividendSpreadCap(.01), .25);
  assert.equal(dividendSpreadCap(.02), .5);
  assert.equal(dividendSpreadCap(.027), .75);
  assert.equal(dividendSpreadCap(.031), 1);
});

test("factor history only produces a spread for an exact same-date D/P2 and rate observation", () => {
  const history = assembleDividendLadderFactorHistory(
    [{ date: "2026-07-23", value: .047 }, { date: "2026-07-24", value: .0476 }],
    [{ date: "2026-07-22", value: .017 }, { date: "2026-07-24", value: .017282 }],
  );
  assert.deepEqual(history.spread, [
    { date: "2026-07-23", value: null },
    { date: "2026-07-24", value: .030318 },
  ]);
  assert.equal(history.historyStart, "2026-07-22");
  assert.equal(history.historyEnd, "2026-07-24");
  assert.equal(history.coverage.sameDaySpreadObservations, 1);
  assert.match(history.limitations.join(" "), /2019 至今/);
});
