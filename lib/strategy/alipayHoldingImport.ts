export const ALIPAY_LINKED_FUND_CODE = "007467";
export const ALIPAY_LINKED_FUND_NAME = "华泰柏瑞中证红利低波ETF联接C";
export const ALIPAY_HOLDING_BUDGET = 50_000;
export const ALIPAY_HOLDING_MAX_JSON_BYTES = 16_384;

export type AlipayHoldingSource = "manual" | "csv" | "screenshot" | "pdf" | "fund-e-account";
export type AlipayVerificationStatus = "pending-review" | "verified" | "discrepancy" | "fund-e-delayed-review";

export type AlipayHoldingSnapshot = {
  id: string;
  source: AlipayHoldingSource;
  asOfDate: string;
  fundCode: typeof ALIPAY_LINKED_FUND_CODE;
  fundName: string;
  units: number;
  nav: number | null;
  navDate: string | null;
  marketValue: number | null;
  holdingCost: number | null;
  holdingProfit: number | null;
  orderInfo: string | null;
  confirmationInfo: string | null;
  fileHash: string | null;
  verificationStatus: AlipayVerificationStatus;
  verificationNote: string | null;
  contentFingerprint: string;
  fundEAccountUnits: number | null;
  fundEAccountMarketValue: number | null;
  createdAt: string;
};

export type AlipayHoldingDraft = Omit<AlipayHoldingSnapshot, "id" | "createdAt" | "contentFingerprint">;

export type AlipayHoldingReconciliation = {
  unitsDifference: number | null;
  marketValueDifference: number | null;
  status: AlipayVerificationStatus;
};

function round(value: number, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function validHoldingDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function trustedAlipayHoldingOrigin(requestUrl: string, origin: string | null) {
  if (!origin) return false;
  try {
    const request = new URL(requestUrl);
    const source = new URL(origin);
    return new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(request.hostname)
      && request.origin === source.origin;
  } catch { return false; }
}

export function alipayHoldingPayloadWithinLimit(text: string) {
  return new TextEncoder().encode(text).byteLength <= ALIPAY_HOLDING_MAX_JSON_BYTES;
}

export function reconcileAlipayHolding(snapshot: Pick<AlipayHoldingSnapshot, "units" | "marketValue" | "fundEAccountUnits" | "fundEAccountMarketValue" | "verificationStatus">): AlipayHoldingReconciliation {
  if (snapshot.fundEAccountUnits === null && snapshot.fundEAccountMarketValue === null) {
    return { unitsDifference: null, marketValueDifference: null, status: snapshot.verificationStatus };
  }
  const unitsDifference = snapshot.fundEAccountUnits === null ? null : round(snapshot.units - snapshot.fundEAccountUnits);
  const marketValueDifference = snapshot.marketValue === null || snapshot.fundEAccountMarketValue === null
    ? null
    : round(snapshot.marketValue - snapshot.fundEAccountMarketValue, 2);
  if (unitsDifference === null && marketValueDifference === null) {
    return { unitsDifference, marketValueDifference, status: "pending-review" };
  }
  const differs = (unitsDifference !== null && Math.abs(unitsDifference) > .000001)
    || (marketValueDifference !== null && Math.abs(marketValueDifference) > .01);
  return { unitsDifference, marketValueDifference, status: differs ? "discrepancy" : "verified" };
}

export function alipayHoldingFingerprint(draft: AlipayHoldingDraft) {
  return JSON.stringify({
    source: draft.source, asOfDate: draft.asOfDate, fundCode: draft.fundCode, fundName: draft.fundName, units: draft.units,
    nav: draft.nav, navDate: draft.navDate, marketValue: draft.marketValue, holdingCost: draft.holdingCost, holdingProfit: draft.holdingProfit,
    orderInfo: draft.orderInfo, confirmationInfo: draft.confirmationInfo, fileHash: draft.fileHash, verificationStatus: draft.verificationStatus,
    fundEAccountUnits: draft.fundEAccountUnits, fundEAccountMarketValue: draft.fundEAccountMarketValue,
  });
}

export function parseAlipayHoldingCsv(value: string): Record<string, string> {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let quoted = false;
  const content = value.replace(/^\uFEFF/, "");
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) { if (char === '"' && content[index + 1] === '"') { cell += '"'; index += 1; } else if (char === '"') quoted = false; else cell += char; continue; }
    if (char === '"') { quoted = true; continue; }
    if (char === ",") { row.push(cell); cell = ""; continue; }
    if (char === "\n") { row.push(cell.replace(/\r$/, "")); if (row.some((value) => value !== "")) rows.push(row); row = []; cell = ""; continue; }
    cell += char;
  }
  if (quoted) throw new Error("CSV 引号未闭合");
  row.push(cell.replace(/\r$/, "")); if (row.some((entry) => entry !== "")) rows.push(row);
  if (rows.length !== 2) throw new Error(rows.length < 2 ? "CSV 需要表头和一行数据" : "首版一次只允许导入一条快照");
  const header = rows[0].map((entry) => entry.trim().toLowerCase());
  if (["asofdate", "fundcode", "fundname", "units"].some((entry) => !header.includes(entry))) throw new Error("CSV 缺少必填表头：asOfDate,fundCode,fundName,units");
  return Object.fromEntries(header.map((key, index) => [key, rows[1][index]?.trim() ?? ""]));
}

export function normalizeAlipayHoldingDraft(body: Record<string, unknown>): AlipayHoldingDraft {
  const forbiddenFields = ["account", "accountId", "password", "cookie", "verificationCode", "smsCode", "faceData", "token"];
  if (forbiddenFields.some((field) => Object.prototype.hasOwnProperty.call(body, field))) throw new Error("不得导入支付宝账号、密码、Cookie、验证码、短信或人脸信息");
  const source = body.source;
  if (source !== "manual" && source !== "csv" && source !== "screenshot" && source !== "pdf" && source !== "fund-e-account") {
    throw new Error("来源只能是手工录入、CSV、截图、PDF 或基金E账户");
  }
  if (!validHoldingDate(body.asOfDate)) throw new Error("截至日期必须使用有效的 YYYY-MM-DD 格式");
  if (body.asOfDate > new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" })) throw new Error("不能导入未来日期的持仓");
  if (body.fundCode !== ALIPAY_LINKED_FUND_CODE) throw new Error("只允许导入 007467 华泰柏瑞中证红利低波ETF联接C");
  if (body.fundName !== ALIPAY_LINKED_FUND_NAME) throw new Error("基金名称必须严格为华泰柏瑞中证红利低波ETF联接C");
  if (body.units === undefined || body.units === null || body.units === "") throw new Error("持有份额必须是有效的非负数");
  const units = Number(body.units);
  if (!Number.isFinite(units) || units < 0 || units > 1_000_000_000) throw new Error("持有份额必须是有效的非负数");
  const optionalNumber = (value: unknown, label: string, maximum: number, nonNegative = false) => {
    if (value === undefined || value === null || value === "") return null;
    const number = Number(value);
    if (!Number.isFinite(number) || Math.abs(number) > maximum || (nonNegative && number < 0)) throw new Error(`${label}格式无效`);
    return number;
  };
  const nav = optionalNumber(body.nav, "单位净值", 100_000, true);
  const marketValue = optionalNumber(body.marketValue, "市值", 1_000_000_000, true);
  const holdingCost = optionalNumber(body.holdingCost, "持有成本", 1_000_000_000, true);
  const holdingProfit = optionalNumber(body.holdingProfit, "持有收益", 1_000_000_000);
  const navDate = body.navDate === undefined || body.navDate === null || body.navDate === "" ? null : body.navDate;
  if (navDate !== null && !validHoldingDate(navDate)) throw new Error("净值日期必须使用有效的 YYYY-MM-DD 格式");
  const fileHash = body.fileHash === undefined || body.fileHash === null || body.fileHash === "" ? null : typeof body.fileHash === "string" ? body.fileHash.trim() : null;
  if (fileHash !== null && !/^[a-f0-9]{64}$/i.test(fileHash)) throw new Error("文件哈希必须是 SHA-256 十六进制值");
  if ((source === "csv" || source === "screenshot" || source === "pdf") && !fileHash) throw new Error("文件导入只保存 SHA-256，请先选择文件");
  const requestedStatus = body.verificationStatus;
  if (requestedStatus !== undefined && requestedStatus !== "pending-review" && requestedStatus !== "fund-e-delayed-review") {
    throw new Error("核验状态无效");
  }
  for (const field of ["orderInfo", "confirmationInfo", "verificationNote"]) {
    if (body[field] !== undefined && body[field] !== null && body[field] !== "") throw new Error("首版不接收订单、确认或自由核验文本");
  }
  const resolvedMarketValue = marketValue === null && nav !== null ? round(units * nav, 2) : marketValue === null ? null : round(marketValue, 2);
  if (marketValue !== null && nav !== null && Math.abs(marketValue - units * nav) > Math.max(1, units * nav * .05)) throw new Error("市值与份额×净值差异过大，请复核后再导入");
  const suppliedComparison = body.fundEAccountUnits !== undefined && body.fundEAccountUnits !== null && body.fundEAccountUnits !== ""
    || body.fundEAccountMarketValue !== undefined && body.fundEAccountMarketValue !== null && body.fundEAccountMarketValue !== "";
  const pendingStatus: AlipayVerificationStatus = suppliedComparison ? "pending-review" : requestedStatus === "fund-e-delayed-review" ? "fund-e-delayed-review" : "pending-review";
  const draft: AlipayHoldingDraft = {
    source,
    asOfDate: body.asOfDate,
    fundCode: ALIPAY_LINKED_FUND_CODE,
    fundName: ALIPAY_LINKED_FUND_NAME,
    units: round(units),
    nav: nav === null ? null : round(nav),
    navDate: navDate as string | null,
    marketValue: resolvedMarketValue,
    holdingCost: holdingCost === null ? null : round(holdingCost, 2),
    holdingProfit: holdingProfit === null ? null : round(holdingProfit, 2),
    orderInfo: null,
    confirmationInfo: null,
    fileHash: fileHash?.toLowerCase() ?? null,
    verificationStatus: source === "screenshot" || source === "pdf" ? "pending-review" : pendingStatus,
    verificationNote: null,
    fundEAccountUnits: optionalNumber(body.fundEAccountUnits, "基金E账户份额", 1_000_000_000, true),
    fundEAccountMarketValue: optionalNumber(body.fundEAccountMarketValue, "基金E账户市值", 1_000_000_000, true),
  };
  return { ...draft, verificationStatus: reconcileAlipayHolding(draft).status };
}
