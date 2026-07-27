import { getJsonWithRetry, ProviderError, type ProviderRequestDependencies } from "./providers";
import { normalizeSymbol } from "./symbols";
import type { MarketBar, MarketIssue, ProviderResponse, Quality } from "./types";

const START = "09:30";
const END = "11:30";
const WARNING_DIFF = .0015;
const CRITICAL_DIFF = .005;
const WARNING_TURNOVER_DIFF = .001;
const CRITICAL_TURNOVER_DIFF = .02;

export type NoonSnapshot = MarketBar & { snapshotTime: "11:30"; rowCount: number; provider: "eastmoney" | "tencent" };
export type NoonValidation = { verified: boolean; snapshot?: NoonSnapshot; quality: Quality; issues: MarketIssue[]; sources: ProviderResponse[] };

function finite(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : Number.NaN; }
function valid(snapshot: NoonSnapshot) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.date) || snapshot.rowCount !== 121) return "missing trading date or incomplete morning minutes";
  if (![snapshot.open, snapshot.high, snapshot.low, snapshot.close, snapshot.volume, snapshot.amount ?? 0].every((value) => Number.isFinite(value) && value >= 0)) return "invalid price, volume, or amount";
  if (snapshot.open <= 0 || snapshot.high < Math.max(snapshot.open, snapshot.close) || snapshot.low > Math.min(snapshot.open, snapshot.close) || snapshot.high < snapshot.low) return "inconsistent OHLC";
  return undefined;
}
function inMorning(time: string) { return /^\d{2}:\d{2}$/.test(time) && time >= START && time <= END; }
function expectedMorningTime(index: number) {
  const minute = 9 * 60 + 30 + index;
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}
function createSnapshot(
  date: string,
  rows: Array<{ time: string; open: number; close: number; high: number; low: number; volume: number; amount: number }>,
  provider: NoonSnapshot["provider"],
  turnoverMode: "incremental" | "cumulative",
): NoonSnapshot {
  const morning = rows.filter((row) => inMorning(row.time));
  if (
    morning.length !== 121
    || morning.some((row, index) => row.time !== expectedMorningTime(index))
  ) {
    throw new ProviderError("upstream minute payload does not contain a complete 09:30–11:30 session", provider, { kind: "payload", code: "MISSING_NOON_SESSION", retryable: true });
  }
  const last = morning.at(-1)!;
  const volume = turnoverMode === "incremental"
    ? morning.reduce((sum, row) => sum + row.volume, 0)
    : last.volume;
  const amount = turnoverMode === "incremental"
    ? morning.reduce((sum, row) => sum + row.amount, 0)
    : last.amount;
  const snapshot: NoonSnapshot = { date, snapshotTime: "11:30", rowCount: morning.length, provider, open: morning[0].open, high: Math.max(...morning.map((row) => row.high)), low: Math.min(...morning.map((row) => row.low)), close: last.close, volume, amount };
  const reason = valid(snapshot);
  if (reason) throw new ProviderError(`invalid noon snapshot: ${reason}`, provider, { kind: "payload", code: "INVALID_NOON_SNAPSHOT", retryable: true });
  return snapshot;
}

export function parseEastmoneyNoon(raw: unknown, date: string): NoonSnapshot {
  const trends = (raw as { data?: { trends?: unknown[] } })?.data?.trends;
  if (!Array.isArray(trends)) throw new ProviderError("upstream payload has no minute trends", "eastmoney", { kind: "payload", code: "MISSING_MINUTE_ROWS", retryable: true });
  const rows = trends.filter((row): row is string => typeof row === "string").map((row) => {
    const [stamp, open, close, high, low, volume, amount] = row.split(",");
    return { stamp, open: finite(open), close: finite(close), high: finite(high), low: finite(low), volume: finite(volume), amount: finite(amount) };
  }).filter((row) => row.stamp.startsWith(`${date} `)).map((row) => ({ ...row, time: row.stamp.slice(11, 16) }));
  return createSnapshot(date, rows, "eastmoney", "incremental");
}

export function parseTencentNoon(raw: unknown, date: string, tencentSymbol = "sh512890"): NoonSnapshot {
  const root = (raw as { data?: Record<string, unknown> })?.data?.[tencentSymbol] as
    | { date?: unknown; data?: unknown }
    | undefined;
  const block = root?.data && typeof root.data === "object" && !Array.isArray(root.data)
    ? root.data as { date?: unknown; data?: unknown[] }
    : root as { date?: unknown; data?: unknown[] } | undefined;
  if (block?.date !== date.replaceAll("-", "") || !Array.isArray(block.data)) throw new ProviderError("Tencent minute response is not for the requested Shanghai date", "tencent", { kind: "payload", code: "MISSING_NOON_DATE", retryable: true });
  let open = Number.NaN, high = Number.NEGATIVE_INFINITY, low = Number.POSITIVE_INFINITY;
  const rows = block.data.filter((row): row is string => typeof row === "string").map((row) => {
    const [hhmm, price, volume, amount] = row.trim().split(/\s+/);
    const time = /^\d{4}$/.test(hhmm) ? `${hhmm.slice(0, 2)}:${hhmm.slice(2)}` : "";
    const close = finite(price);
    if (inMorning(time) && Number.isFinite(close)) { if (!Number.isFinite(open)) open = close; high = Math.max(high, close); low = Math.min(low, close); }
    return { time, open, close, high, low, volume: finite(volume), amount: finite(amount) };
  });
  return createSnapshot(date, rows, "tencent", "cumulative");
}

export function validateNoonSnapshots(primaryResponse: ProviderResponse, secondaryResponse: ProviderResponse, date: string): NoonValidation {
  const primary = primaryResponse.bars[0] as NoonSnapshot | undefined;
  const secondary = secondaryResponse.bars[0] as NoonSnapshot | undefined;
  const issues: MarketIssue[] = [];
  if (!primary || !secondary || primary.date !== date || secondary.date !== date || primary.snapshotTime !== END || secondary.snapshotTime !== END) {
    return { verified: false, quality: { score: 0, grade: "D", coverage: 0, overlapDays: 0, matchedDays: 0, conflictDays: 1, agreementPct: 0, maxPriceDiffBps: 0 }, issues: [{ code: "NOON_SESSION_INCOMPLETE", severity: "error", message: "Both providers must supply the requested date through 11:30." }], sources: [primaryResponse, secondaryResponse] };
  }
  const fields = ["open", "high", "low", "close"] as const;
  const maxDiff = Math.max(...fields.map((field) => Math.abs(primary[field] - secondary[field]) / Math.max(Math.abs(primary[field]), Math.abs(secondary[field]), .000001)));
  const volumeDiff = Math.abs(primary.volume - secondary.volume) / Math.max(primary.volume, secondary.volume, 1);
  const amountDiff = Math.abs((primary.amount ?? 0) - (secondary.amount ?? 0)) / Math.max(primary.amount ?? 0, secondary.amount ?? 0, 1);
  const maxPriceDiffBps = Math.round(maxDiff * 1_000_000) / 100;
  if (maxDiff > CRITICAL_DIFF) issues.push({ code: "NOON_OHLC_CONFLICT", severity: "error", date, message: "Noon OHLC disagreement exceeds 50 bps; snapshot was rejected.", details: { maxPriceDiffBps } });
  else if (maxDiff > WARNING_DIFF) issues.push({ code: "NOON_OHLC_WARNING", severity: "warning", date, message: "Noon OHLC differs by more than 15 bps but not more than 50 bps.", details: { maxPriceDiffBps } });
  const turnoverConflict = volumeDiff > CRITICAL_TURNOVER_DIFF || amountDiff > CRITICAL_TURNOVER_DIFF;
  const turnoverWarning = volumeDiff > WARNING_TURNOVER_DIFF || amountDiff > WARNING_TURNOVER_DIFF;
  if (turnoverConflict) issues.push({ code: "NOON_TURNOVER_CONFLICT", severity: "error", date, message: "Noon cumulative volume or amount disagreement exceeds 2%; snapshot was rejected.", details: { volumeDiffPct: volumeDiff * 100, amountDiffPct: amountDiff * 100 } });
  else if (turnoverWarning) issues.push({ code: "NOON_TURNOVER_WARNING", severity: "warning", date, message: "Noon cumulative turnover differs across sources.", details: { volumeDiffPct: volumeDiff * 100, amountDiffPct: amountDiff * 100 } });
  const verified = maxDiff <= CRITICAL_DIFF && !turnoverConflict;
  const hasWarning = maxDiff > WARNING_DIFF || turnoverWarning;
  return { verified, snapshot: verified ? primary : undefined, quality: { score: verified ? hasWarning ? 90 : 100 : 0, grade: verified ? hasWarning ? "B" : "A" : "D", coverage: 100, overlapDays: 1, matchedDays: verified ? 1 : 0, conflictDays: verified ? 0 : 1, agreementPct: verified ? 100 : 0, maxPriceDiffBps }, issues, sources: [primaryResponse, secondaryResponse] };
}

export async function fetchNoonSnapshots(symbolValue: string, date: string, dependencies: ProviderRequestDependencies = {}) {
  return Promise.all([fetchEastmoneyNoon(symbolValue, date, dependencies), fetchTencentNoon(symbolValue, date, dependencies)]);
}

export async function fetchEastmoneyNoon(symbolValue: string, date: string, dependencies: ProviderRequestDependencies = {}): Promise<ProviderResponse> {
  const symbol = normalizeSymbol(symbolValue);
  const eastmoneyUrl = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?${new URLSearchParams({ secid: symbol.eastmoneySecid, fields1: "f1,f2,f3,f4,f5,f6,f7,f8", fields2: "f51,f52,f53,f54,f55,f56,f57,f58", ndays: "1", iscr: "0", iscca: "0" })}`;
  const eastmoney = await getJsonWithRetry(eastmoneyUrl, "eastmoney", (raw) => parseEastmoneyNoon(raw, date), dependencies);
  return { provider: "eastmoney", requestUrl: eastmoneyUrl, raw: eastmoney.raw, bars: [eastmoney.value], attempts: eastmoney.attempts };
}

export async function fetchTencentNoon(symbolValue: string, date: string, dependencies: ProviderRequestDependencies = {}): Promise<ProviderResponse> {
  const symbol = normalizeSymbol(symbolValue);
  const tencentUrl = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${symbol.tencentSymbol}`;
  const tencent = await getJsonWithRetry(tencentUrl, "tencent", (raw) => parseTencentNoon(raw, date, symbol.tencentSymbol), dependencies);
  return { provider: "tencent", requestUrl: tencentUrl, raw: tencent.raw, bars: [tencent.value], attempts: tencent.attempts };
}
