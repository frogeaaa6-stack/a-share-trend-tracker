import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  ALIPAY_LINKED_FUND_CODE,
  ALIPAY_LINKED_FUND_NAME,
  ALIPAY_HOLDING_MAX_JSON_BYTES,
  alipayHoldingFingerprint,
  alipayHoldingPayloadWithinLimit,
  normalizeAlipayHoldingDraft,
  parseAlipayHoldingCsv,
  reconcileAlipayHolding,
  trustedAlipayHoldingOrigin,
} from "../lib/strategy/alipayHoldingImport.ts";

const valid = (overrides = {}) => ({
  source: "manual",
  asOfDate: "2026-07-24",
  fundCode: "007467",
  fundName: ALIPAY_LINKED_FUND_NAME,
  units: "1234.567891",
  nav: "1.2345",
  navDate: "2026-07-23",
  marketValue: "1524.15",
  ...overrides,
});

test("007467 snapshot permits fractional fund units and uses the strict linked-fund whitelist", () => {
  const draft = normalizeAlipayHoldingDraft(valid());
  assert.equal(draft.fundCode, ALIPAY_LINKED_FUND_CODE);
  assert.equal(draft.fundName, ALIPAY_LINKED_FUND_NAME);
  assert.equal(draft.units, 1234.567891);
  assert.equal(draft.orderInfo, null);
  assert.equal(draft.confirmationInfo, null);
  assert.equal(draft.verificationNote, null);
  assert.throws(() => normalizeAlipayHoldingDraft(valid({ fundCode: "512890" })), /只允许导入 007467/);
});

test("required holding fields and sensitive Alipay credentials are rejected", () => {
  assert.throws(() => normalizeAlipayHoldingDraft(valid({ units: "" })), /持有份额/);
  assert.throws(() => normalizeAlipayHoldingDraft(valid({ password: "never-store" })), /不得导入支付宝账号/);
  assert.throws(() => normalizeAlipayHoldingDraft(valid({ cookie: "never-store" })), /不得导入支付宝账号/);
  assert.throws(() => normalizeAlipayHoldingDraft(valid({ verificationStatus: "verified" })), /核验状态无效/);
  assert.throws(() => normalizeAlipayHoldingDraft(valid({ verificationStatus: "discrepancy" })), /核验状态无效/);
  assert.throws(() => normalizeAlipayHoldingDraft(valid({ fundName: "华泰柏瑞中证红利低波ETF联接A" })), /必须严格/);
  assert.throws(() => normalizeAlipayHoldingDraft(valid({ orderInfo: "13800138000" })), /不接收订单/);
  assert.throws(() => normalizeAlipayHoldingDraft(valid({ confirmationInfo: "张三 已确认" })), /不接收订单/);
  assert.throws(() => normalizeAlipayHoldingDraft(valid({ verificationNote: "身份证110101199001011234" })), /不接收订单/);
});

test("Fund E reconciliation reports a discrepancy without replacing the original snapshot", () => {
  const draft = normalizeAlipayHoldingDraft(valid({ fundEAccountUnits: "1234.5", fundEAccountMarketValue: "1500" }));
  const result = reconcileAlipayHolding(draft);
  assert.equal(result.status, "discrepancy");
  assert.equal(result.unitsDifference, .067891);
  assert.equal(result.marketValueDifference, 24.15);
});

test("server derives verification and NAV-only market value without using 512890", () => {
  const pending = normalizeAlipayHoldingDraft(valid({ marketValue: "", verificationStatus: "fund-e-delayed-review" }));
  assert.equal(pending.marketValue, 1524.07);
  assert.equal(pending.verificationStatus, "fund-e-delayed-review");
  const verified = normalizeAlipayHoldingDraft(valid({ fundEAccountUnits: "1234.567891", fundEAccountMarketValue: "1524.15" }));
  assert.equal(verified.verificationStatus, "verified");
  assert.throws(() => normalizeAlipayHoldingDraft(valid({ marketValue: "100" })), /差异过大/);
});

test("CSV accepts BOM and escaped standard quotes but rejects multiple snapshots", () => {
  const single = parseAlipayHoldingCsv(`\uFEFFasOfDate,fundCode,fundName,units\n2026-07-24,007467,"${ALIPAY_LINKED_FUND_NAME}",0`);
  assert.equal(single.fundname, ALIPAY_LINKED_FUND_NAME);
  assert.throws(() => parseAlipayHoldingCsv("asOfDate,fundCode,fundName,units\n2026-07-24,007467,a,1\n2026-07-25,007467,b,2"), /一次只允许/);
});

test("complete normalized content controls idempotency and hash conflicts", () => {
  const first = normalizeAlipayHoldingDraft(valid({ fileHash: "a".repeat(64), holdingCost: "1000" }));
  const same = normalizeAlipayHoldingDraft(valid({ fileHash: "a".repeat(64), holdingCost: "1000" }));
  const corrected = normalizeAlipayHoldingDraft(valid({ fileHash: "a".repeat(64), holdingCost: "1001" }));
  assert.equal(alipayHoldingFingerprint(first), alipayHoldingFingerprint(same));
  assert.notEqual(alipayHoldingFingerprint(first), alipayHoldingFingerprint(corrected));
});

test("requires exact same origin and limits the UTF-8 request body, even without Content-Length", () => {
  assert.equal(trustedAlipayHoldingOrigin("http://localhost:3000/api/strategy/alipay-holding", "http://localhost:3000"), true);
  assert.equal(trustedAlipayHoldingOrigin("http://localhost:3000/api/strategy/alipay-holding", "http://127.0.0.1:3000"), false);
  assert.equal(trustedAlipayHoldingOrigin("https://localhost:3000/api/strategy/alipay-holding", "http://localhost:3000"), false);
  assert.equal(trustedAlipayHoldingOrigin("http://localhost:3000/api/strategy/alipay-holding", null), false);
  assert.equal(alipayHoldingPayloadWithinLimit("中".repeat(Math.ceil(ALIPAY_HOLDING_MAX_JSON_BYTES / 3))), false);
  assert.equal(alipayHoldingPayloadWithinLimit("中".repeat(10)), true);
});

test("preview remains zero-write and confirmation endpoint is append-only/idempotent", async () => {
  const route = await readFile(new URL("../app/api/strategy/alipay-holding/route.ts", import.meta.url), "utf8");
  const persistence = await readFile(new URL("../lib/strategy/alipayHoldingPersistence.ts", import.meta.url), "utf8");
  assert.match(route, /body\.action !== "confirm"/);
  assert.match(route, /idempotentReplay/);
  assert.match(route, /HOLDING_CONFLICT/);
  assert.match(route, /contentFingerprint/);
  assert.match(route, /alipayHoldingPayloadWithinLimit/);
  assert.match(persistence, /CREATE UNIQUE INDEX IF NOT EXISTS alipay_holding_snapshots_file_hash/);
  assert.match(persistence, /UPDATE alipay_holding_import_ledger SET ledger_version = ledger_version \+ 1/);
  assert.doesNotMatch(persistence, /\bUPDATE alipay_holding_snapshots\b|\bDELETE\b/);
});

test("Alipay import contains no network login, RPA or trade capability", async () => {
  const source = [
    await readFile(new URL("../app/api/strategy/alipay-holding/route.ts", import.meta.url), "utf8"),
    await readFile(new URL("../lib/strategy/alipayHoldingImport.ts", import.meta.url), "utf8"),
    await readFile(new URL("../lib/strategy/alipayHoldingPersistence.ts", import.meta.url), "utf8"),
  ].join("\n");
  assert.doesNotMatch(source, /https?:\/\/|fetch\(|axios|puppeteer|playwright|adb|selenium|submitOrder|redeem|subscribe/i);
});
