"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { backtestDividendLadder, evaluateEnhancedDividendLadder } from "../../lib/strategy/dividendLadder";
import { computePriceVolatilityRegimes, computePriceVolatilityShadowRisk, computeVolatilitySeries } from "../../lib/strategy/dividendRegime";
import {
  calculateDividendAccount,
  DIVIDEND_STRATEGY_CAPITAL,
  type DividendAccountSummary,
  type DividendAccountTrade,
} from "../../lib/strategy/dividendAccount";
import { parseAlipayHoldingCsv } from "../../lib/strategy/alipayHoldingImport";

type Point = { date: string; close: number; open?: number; high?: number; low?: number; volume?: number };
type Strategy = "trend" | "rsi";
type DataMode = "synthetic" | "csv" | "verified";
type AppView = "overview" | "assets" | "watchlist" | "dividend" | "data" | "lab";
type Trade = { side: "买入" | "卖出"; date: string; price: number; units: number; reason: string; fillBasis: "开盘价" | "收盘价回退"; pnl?: number };
type Report = { equity: number[]; drawdown: number[]; buys: number[]; sells: number[]; trades: Trade[]; total: number; annual: number; maxDD: number; sharpe: number; winRate: number; rounds: number; latestSignal: string; isHolding: boolean; nextExecution: string };
type SourceInfo = { provider: string; status: string; barCount: number };
type SyncView = {
  verified: boolean; cached: boolean; stale: boolean; asOf: string; symbol: string;
  adjustment: string; version: string; hash: string; score: number | null; grade: string;
  coverage: number | null; agreementPct: number | null; overlapDays: number | null; maxPriceDiffBps: number | null;
  conflicts: number; barsCount: number; sources: SourceInfo[]; usableSources: number;
};
type WatchItem = { symbol: string; label: string; addedAt: string };
type WatchSnapshot = {
  status: "idle" | "loading" | "verified" | "error";
  view?: SyncView;
  bars?: Point[];
  error?: string;
};
type FactorSnapshot = {
  asOf: string;
  indexCode: "H30269";
  dividend: { value: number; date: string; source: string; status: "official"; historyCount: number };
  rate: { value: number; date: string; source: string; secondaryValue: number | null; secondaryDate: string | null; differenceBps: number | null; verified: boolean };
  spread: { value: number; cap: number };
  limitations: string[];
};
type FactorHistorySnapshot = {
  indexCode: "H30269";
  status: "success" | "partial";
  historyStart: string | null;
  historyEnd: string | null;
  dividend: Array<{ date: string; value: number }>;
  rate: Array<{ date: string; value: number }>;
  spread: Array<{ date: string; value: number | null }>;
  coverage: { dividendObservations: number; rateObservations: number; sameDaySpreadObservations: number; dividendStart: string | null; dividendEnd: string | null; rateStart: string | null; rateEnd: string | null };
  limitations: string[];
};
type FeishuStatus = {
  enabled: boolean;
  configured: boolean;
  mode: "app_bot" | "custom_webhook";
  appCredentialsConfigured: boolean;
  receiverConfigured: boolean;
  receiveIdType: string;
  signed: boolean;
  keywordConfigured: boolean;
  destination: string | null;
  missing: string[];
};
type DividendAccountPayload = {
  strategyKey: string;
  symbol: string;
  fundName: string;
  capital: number;
  ledgerVersion: number;
  trackingStatus: "active" | "awaiting-first-trade";
  summary: DividendAccountSummary;
  trades: DividendAccountTrade[];
  accounting: string;
};
type DividendTradeDraft = {
  tradeDate: string;
  side: "buy" | "sell" | "dividend";
  price: string;
  units: string;
  fee: string;
  note: string;
};
type AlipayHoldingSource = "manual" | "csv" | "screenshot" | "pdf" | "fund-e-account";
type AlipayVerificationStatus = "pending-review" | "verified" | "discrepancy" | "fund-e-delayed-review";
type AlipayHoldingSnapshot = {
  id: string; source: AlipayHoldingSource; asOfDate: string; fundCode: "007467"; fundName: string; units: number;
  nav: number | null; navDate: string | null; marketValue: number | null; holdingCost: number | null; holdingProfit: number | null;
  orderInfo: string | null; confirmationInfo: string | null; fileHash: string | null; verificationStatus: AlipayVerificationStatus;
  verificationNote: string | null; contentFingerprint: string; fundEAccountUnits: number | null; fundEAccountMarketValue: number | null; createdAt: string;
};
type AlipayHoldingPayload = {
  fundCode: "007467"; capitalBudget: number; ledgerVersion: number; snapshots: AlipayHoldingSnapshot[]; current: AlipayHoldingSnapshot | null;
  reconciliation: { unitsDifference: number | null; marketValueDifference: number | null; status: AlipayVerificationStatus } | null; readOnlyBoundary: string;
};
type AlipayHoldingDraft = {
  source: AlipayHoldingSource; asOfDate: string; fundCode: "007467"; fundName: string; units: string; nav: string; navDate: string; marketValue: string;
  holdingCost: string; holdingProfit: string; fileHash: string; verificationStatus: AlipayVerificationStatus;
  fundEAccountUnits: string; fundEAccountMarketValue: string;
};

const sectorRows = [["半导体","+2.84%","up","中芯国际 · 北方华创"],["创新药","+1.96%","up","恒瑞医药 · 药明康德"],["人工智能","+1.52%","up","科大讯飞 · 寒武纪"],["红利低波","+0.42%","flat","长江电力 · 中国神华"],["新能源车","-0.68%","down","比亚迪 · 宁德时代"],["地产链","-1.24%","down","万科A · 东方雨虹"]] as const;
const assets = [["半导体设备ETF","159516","16.42","+2.84%","强势","半导体"],["芯片ETF","159995","1.087","+2.31%","强势","半导体"],["创新药ETF","159992","0.763","+1.96%","偏强","创新药"],["人工智能ETF","159819","1.142","+1.52%","偏强","人工智能"],["红利低波ETF","512890","1.362","+0.42%","中性","红利低波"],["新能源车ETF","515030","1.188","-0.68%","偏弱","新能源车"]] as const;
const watchlistStorageKey = "a-share-tracker.watchlist.v1";
const appViews: { id: AppView; label: string; hash: string }[] = [
  { id: "overview", label: "A股总览", hash: "#market" },
  { id: "assets", label: "标的雷达", hash: "#assets" },
  { id: "watchlist", label: "自选跟踪", hash: "#watchlist" },
  { id: "dividend", label: "红利低波", hash: "#dividend-ladder" },
  { id: "data", label: "真实数据", hash: "#real-data" },
  { id: "lab", label: "策略实验室", hash: "#lab" },
];
const viewByHash = Object.fromEntries(appViews.map((view) => [view.hash, view.id])) as Record<string, AppView>;
const defaultWatchlist: WatchItem[] = [{ symbol: "512890.SH", label: "红利低波ETF 华泰柏瑞", addedAt: "2026-07-25" }];
const knownLabels: Record<string, string> = {
  "512890.SH": "红利低波ETF 华泰柏瑞",
  "510300.SH": "沪深300ETF",
  "510050.SH": "上证50ETF",
  "159915.SZ": "创业板ETF",
  "159919.SZ": "沪深300ETF",
};

function makeData(): Point[] { const cursor = new Date(Date.UTC(2025, 0, 2)); let price = 100; return Array.from({ length: 260 }, (_, i) => { while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6) cursor.setUTCDate(cursor.getUTCDate() + 1); const date = cursor.toISOString().slice(0, 10); cursor.setUTCDate(cursor.getUTCDate() + 1); const previous = price, open = previous * (1 + Math.sin(i * .31) * .002); price *= 1 + .0007 + Math.sin(i * .19) * .012 + Math.cos(i * .047) * .006 + (i === 92 ? -.046 : 0) + (i === 186 ? .038 : 0); const close = Number(price.toFixed(2)), roundedOpen = Number(open.toFixed(2)); return { date, open: roundedOpen, high: Number((Math.max(roundedOpen, close) * (1.004 + Math.abs(Math.sin(i)) * .002)).toFixed(2)), low: Number((Math.min(roundedOpen, close) * (0.996 - Math.abs(Math.cos(i)) * .001)).toFixed(2)), close, volume: 8_000_000 + (i % 17) * 310_000 }; }); }
function sma(v: number[], i: number, n: number) { if (i < n - 1) return null; let sum = 0; for (let p = i - n + 1; p <= i; p++) sum += v[p]; return sum / n; }
function rsi(v: number[], i: number) { if (i < 14) return null; let gain = 0, loss = 0; for (let p = i - 13; p <= i; p++) { const diff = v[p] - v[p - 1]; if (diff >= 0) gain += diff; else loss -= diff; } return loss ? 100 - 100 / (1 + gain / loss) : 100; }
function nextWeekday(dateString: string) { const d = new Date(`${dateString}T00:00:00Z`); do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6); return d.toISOString().slice(0, 10); }
function emptyAlipayHoldingDraft(): AlipayHoldingDraft { return { source: "manual", asOfDate: "", fundCode: "007467", fundName: "华泰柏瑞中证红利低波ETF联接C", units: "", nav: "", navDate: "", marketValue: "", holdingCost: "", holdingProfit: "", fileHash: "", verificationStatus: "pending-review", fundEAccountUnits: "", fundEAccountMarketValue: "" }; }
async function sha256File(file: File) { const bytes = await crypto.subtle.digest("SHA-256", await file.arrayBuffer()); return Array.from(new Uint8Array(bytes)).map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function backtest(data: Point[], strategy: Strategy, bps: number, fast: number, slow: number, entry: number, exit: number): Report {
  const close = data.map((x) => x.close), fee = bps / 10000, trades: Trade[] = [], buys: number[] = [], sells: number[] = [], equity: number[] = [], wins: number[] = [];
  let cash = 100000, units = 0, entryCash = 0, queued: "buy" | "sell" | null = null;
  for (let i = 0; i < data.length; i++) {
    const markPrice = close[i], hasOpen = Number.isFinite(data[i].open) && (data[i].open ?? 0) > 0, executionPrice = hasOpen ? data[i].open! : markPrice, fillBasis = hasOpen ? "开盘价" : "收盘价回退";
    if (queued === "buy" && cash) { const lots = Math.floor(cash / (executionPrice * (1 + fee) * 100)); const boughtUnits = lots * 100; if (boughtUnits) { const buyCost = boughtUnits * executionPrice * (1 + fee); units = boughtUnits; entryCash = buyCost; cash -= buyCost; buys.push(i); trades.push({ side: "买入", date: data[i].date, price: executionPrice, units, fillBasis, reason: strategy === "trend" ? "前一日收盘确认趋势恢复" : "前一日收盘确认 RSI 回撤恢复" }); } }
    if (queued === "sell" && units) { const proceeds = units * executionPrice * (1 - fee); cash += proceeds; const pnl = proceeds / entryCash - 1; wins.push(pnl); sells.push(i); trades.push({ side: "卖出", date: data[i].date, price: executionPrice, units, fillBasis, pnl, reason: strategy === "trend" ? "前一日收盘确认趋势跌破" : "前一日收盘确认 RSI 止盈/趋势保护" }); units = 0; }
    queued = null; equity.push(cash + units * markPrice);
    if (i < Math.max(slow, 15) || i === data.length - 1) continue;
    const f = sma(close, i, fast), s = sma(close, i, slow), fp = sma(close, i - 1, fast), sp = sma(close, i - 1, slow), rr = rsi(close, i), rp = rsi(close, i - 1);
    const enterNow = strategy === "trend" ? Boolean(f && s && fp && sp && f > s && fp <= sp) : Boolean(rr && rp && s && rp < entry && rr >= entry && markPrice > s * .985);
    const exitNow = strategy === "trend" ? Boolean(f && s && (f < s || markPrice < f)) : Boolean(rr && s && (rr > exit || markPrice < s * .965));
    if (!units && enterNow) queued = "buy";
    if (units && exitNow) queued = "sell";
  }
  let peak = equity[0] || 1; const drawdown = equity.map((v) => { peak = Math.max(peak, v); return v / peak - 1; });
  const returns = equity.slice(1).map((v, i) => v / equity[i] - 1), avg = returns.reduce((a, b) => a + b, 0) / Math.max(1, returns.length), variance = returns.reduce((a, b) => a + (b - avg) ** 2, 0) / Math.max(1, returns.length - 1), total = equity.at(-1)! / equity[0] - 1;
  const last = data.length - 1, f = sma(close, last, fast), s = sma(close, last, slow), fp = sma(close, last - 1, fast), sp = sma(close, last - 1, slow), rr = rsi(close, last), rp = rsi(close, last - 1);
  const canEnter = strategy === "trend" ? Boolean(f && s && fp && sp && f > s && fp <= sp) : Boolean(rr && rp && s && rp < entry && rr >= entry && close[last] > s * .985);
  const canExit = strategy === "trend" ? Boolean(f && s && (f < s || close[last] < f)) : Boolean(rr && s && (rr > exit || close[last] < s * .965));
  const latestSignal = last < Math.max(slow, 15) ? "指标未就绪" : !units && canEnter ? "触发买入条件" : units && canExit ? "触发卖出条件" : "未触发";
  return { equity, drawdown, buys, sells, trades, total, annual: (1 + total) ** (252 / data.length) - 1, maxDD: Math.min(...drawdown), sharpe: variance ? avg / Math.sqrt(variance) * Math.sqrt(252) : 0, winRate: wins.length ? wins.filter((x) => x > 0).length / wins.length : 0, rounds: wins.length, latestSignal, isHolding: units > 0, nextExecution: nextWeekday(data[last].date) };
}
function percent(value: number, digits = 2) { return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`; }
type JsonObject = Record<string, unknown>;
const asObject = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const asNumber = (value: unknown): number | null => { const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN; return Number.isFinite(parsed) ? parsed : null; };
const asText = (value: unknown, fallback = "—") => typeof value === "string" && value.trim() ? value : fallback;
function canonicalDate(value: unknown) { const raw = String(value ?? "").trim(), match = raw.match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})$/); if (!match) return null; const [, y, m, d] = match, canonical = `${y}-${m}-${d}`, date = new Date(`${canonical}T00:00:00Z`); return date.getUTCFullYear() === Number(y) && date.getUTCMonth() + 1 === Number(m) && date.getUTCDate() === Number(d) ? canonical : null; }
function parseApiBars(raw: unknown): { bars: Point[]; error?: string } {
  if (!Array.isArray(raw)) return { bars: [], error: "响应未包含 bars 数组" };
  const seen = new Set<string>(), bars: Point[] = [];
  for (let i = 0; i < raw.length; i++) {
    const bar = asObject(raw[i]), date = canonicalDate(bar.date ?? bar.tradeDate ?? bar.trade_date), close = asNumber(bar.close);
    if (!date) return { bars: [], error: `bars 第 ${i + 1} 条日期无效` };
    if (seen.has(date)) return { bars: [], error: `bars 第 ${i + 1} 条日期重复：${date}` };
    if (close === null || close <= 0) return { bars: [], error: `bars 第 ${i + 1} 条 close 无效` };
    const point: Point = { date, close };
    for (const field of ["open", "high", "low"] as const) { const value = asNumber(bar[field]); if (bar[field] !== undefined && (value === null || value <= 0)) return { bars: [], error: `bars 第 ${i + 1} 条 ${field} 无效` }; if (value !== null) point[field] = value; }
    const volume = asNumber(bar.volume); if (bar.volume !== undefined && (volume === null || volume < 0)) return { bars: [], error: `bars 第 ${i + 1} 条 volume 无效` }; if (volume !== null) point.volume = volume;
    if (point.open !== undefined && point.high !== undefined && point.low !== undefined && (point.high < Math.max(point.open, point.close) || point.low > Math.min(point.open, point.close) || point.high < point.low)) {
      return { bars: [], error: `bars 第 ${i + 1} 条 OHLC 关系无效` };
    }
    seen.add(date); bars.push(point);
  }
  bars.sort((a, b) => a.date.localeCompare(b.date));
  return { bars };
}
function normalizeSyncPayload(payload: unknown): { view: SyncView; rawBars: unknown } {
  const root = asObject(payload), dataset = asObject(root.dataset), validation = asObject(root.validation), quality = asObject(validation.quality);
  const rawSources = Array.isArray(validation.sources) ? validation.sources : Array.isArray(root.sources) ? root.sources : [];
  const sources = rawSources.map((item) => { const source = asObject(item); return { provider: asText(source.provider ?? source.name), status: asText(source.status, "unknown"), barCount: asNumber(source.barCount ?? source.count) ?? 0 }; });
  const usableSources = sources.filter((source) => !/(fail|error|unavailable|offline|empty)/i.test(source.status) && source.barCount > 0).length;
  const issues = Array.isArray(validation.issues) ? validation.issues : [], issueConflicts = issues.filter((item) => /conflict|difference|mismatch|price_diff/i.test(`${asText(asObject(item).code, "")} ${asText(asObject(item).message, "")}`)).length;
  const issuePriceDiffs = issues.flatMap((item) => { const details = asObject(asObject(item).details), primary = asObject(details.eastmoney ?? details.primary), secondary = asObject(details.tencent ?? details.secondary); return ["open", "high", "low", "close"].map((field) => { const a = asNumber(primary[field]), b = asNumber(secondary[field]); return a !== null && b !== null ? Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), .000001) : null; }).filter((value): value is number => value !== null); });
  const conflicts = asNumber(quality.conflictDays ?? quality.conflicts ?? validation.conflictDays) ?? issueConflicts;
  const matched = asNumber(quality.matchedDays), overlapDays = asNumber(quality.overlapDays ?? quality.overlap_days), explicitAgreementPct = asNumber(quality.agreementPct ?? quality.agreement_pct), explicitPassRate = asNumber(quality.passRate ?? quality.pass_rate);
  const legacyMaxDiff = asNumber(quality.maxPriceDiff ?? quality.max_price_diff ?? validation.maxPriceDiff), explicitMaxDiffBps = asNumber(quality.maxPriceDiffBps ?? quality.max_price_diff_bps ?? validation.maxPriceDiffBps);
  const status = asText(root.status, "");
  const verified = validation.verified === true || root.verified === true || /^verified$/i.test(status);
  const rawBars = root.bars ?? asObject(root.data).bars;
  return { rawBars, view: {
    verified, cached: root.cached === true, stale: root.stale === true || root.fallback === true,
    asOf: asText(root.asOf ?? dataset.createdAt), symbol: asText(dataset.symbol ?? root.symbol),
    adjustment: asText(dataset.adjustment ?? root.adjustment), version: dataset.version !== undefined || root.version !== undefined ? String(dataset.version ?? root.version) : "—",
    hash: asText(dataset.hash ?? root.hash), score: asNumber(quality.score), grade: asText(quality.grade),
    coverage: asNumber(quality.coverage),
    agreementPct: explicitAgreementPct ?? (explicitPassRate !== null ? (explicitPassRate <= 1 ? explicitPassRate * 100 : explicitPassRate) : matched !== null && matched + conflicts > 0 ? matched / (matched + conflicts) * 100 : null),
    overlapDays: overlapDays ?? (matched !== null ? matched + conflicts : null),
    maxPriceDiffBps: explicitMaxDiffBps ?? (legacyMaxDiff !== null ? (legacyMaxDiff <= 1 ? legacyMaxDiff * 10000 : legacyMaxDiff) : issuePriceDiffs.length ? Math.max(...issuePriceDiffs) * 10000 : null),
    conflicts, barsCount: Array.isArray(rawBars) ? rawBars.length : 0, sources, usableSources,
  } };
}
async function fetchValidatedMarket(symbol: string, days = 260, minimumBars = 65, completeOnly = false) {
  const normalizedSymbol = symbol.trim().toUpperCase();
  if (!/^\d{6}\.(SH|SZ)$/.test(normalizedSymbol)) throw new Error("代码格式无效，请使用 510300.SH 或 159915.SZ 这类格式");
  const response = await fetch("/api/market/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol: normalizedSymbol, days, completeOnly }) });
  let payload: unknown = {};
  try { payload = await response.json(); } catch { /* handled as a readable response error below */ }
  if (!response.ok) { const error = asObject(payload); throw new Error(asText(error.error ?? error.message ?? error.code, `同步服务返回 ${response.status}`)); }
  const { view, rawBars } = normalizeSyncPayload(payload), parsed = parseApiBars(rawBars);
  if (parsed.bars.length) view.asOf = parsed.bars.at(-1)?.date ?? view.asOf;
  if (parsed.error) throw new Error(`响应校验失败：${parsed.error}`);
  const blockers: string[] = [];
  if (!view.verified) blockers.push("API 未返回 verified");
  if (view.usableSources < 2) blockers.push(`仅 ${view.usableSources} 个可用数据源`);
  if (view.conflicts > 0) blockers.push(`${view.conflicts} 个价格冲突`);
  if (view.symbol === "—") blockers.push("返回结果缺少证券代码");
  else if (view.symbol !== normalizedSymbol) blockers.push(`返回代码 ${view.symbol} 与请求不一致`);
  if (view.adjustment !== "qfq") blockers.push(`复权口径不是 qfq（当前为 ${view.adjustment}）`);
  if (view.version === "—" || view.hash === "—") blockers.push("缺少数据版本或 Hash");
  if (view.score === null || view.score < 85) blockers.push(`质量分不足（${view.score ?? "缺失"}）`);
  if (view.coverage === null || view.coverage < 95) blockers.push(`覆盖率不足（${view.coverage ?? "缺失"}）`);
  if (view.agreementPct === null || view.agreementPct < 98) blockers.push(`双源一致率不足（${view.agreementPct ?? "缺失"}）`);
  if (parsed.bars.length < minimumBars) blockers.push(`bars 仅 ${parsed.bars.length} 条（至少 ${minimumBars} 条）`);
  return { normalizedSymbol, view, bars: parsed.bars, blockers };
}
function ratioLabel(value: number | null) { if (value === null) return "—"; return `${(value <= 1 ? value * 100 : value).toFixed(1)}%`; }
function percentPointLabel(value: number | null) { return value === null ? "—" : `${value.toFixed(1)}%`; }
function bpsLabel(value: number | null) { return value === null ? "—" : `${value.toFixed(1)} bps`; }
function parseCsvText(text: string, minimum: number): { bars?: Point[]; error?: string } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/); if (lines.at(-1) === "") lines.pop();
  const fields = (lines[0] || "").split(",").map((field) => field.trim().toLowerCase());
  const index = (aliases: string[]) => fields.findIndex((field) => aliases.includes(field));
  const dateIndex = index(["date", "日期", "trade_date"]), closeIndex = index(["close", "收盘", "收盘价", "price"]);
  if (dateIndex < 0 || closeIndex < 0) return { error: "第 1 行必须含 date（或日期）和 close（或收盘价）列" };
  const optional = { open: index(["open", "开盘", "开盘价"]), high: index(["high", "最高", "最高价"]), low: index(["low", "最低", "最低价"]), volume: index(["volume", "vol", "成交量"]) };
  const seen = new Set<string>(), bars: Point[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(","), date = canonicalDate(cells[dateIndex]?.trim()), close = asNumber(cells[closeIndex]?.trim());
    if (!date) return { error: `第 ${i + 1} 行日期无效或不存在` };
    if (seen.has(date)) return { error: `第 ${i + 1} 行日期重复：${date}` };
    if (close === null || close <= 0) return { error: `第 ${i + 1} 行 close 必须为大于 0 的数字` };
    const point: Point = { date, close };
    for (const field of ["open", "high", "low"] as const) { const position = optional[field]; if (position >= 0) { const value = asNumber(cells[position]?.trim()); if (value === null || value <= 0) return { error: `第 ${i + 1} 行 ${field} 必须为大于 0 的数字` }; point[field] = value; } }
    if (optional.volume >= 0) { const value = asNumber(cells[optional.volume]?.trim()); if (value === null || value < 0) return { error: `第 ${i + 1} 行 volume 必须为非负数字` }; point.volume = value; }
    if (point.open !== undefined && point.high !== undefined && point.low !== undefined && (point.high < Math.max(point.open, point.close) || point.low > Math.min(point.open, point.close) || point.high < point.low)) {
      return { error: `第 ${i + 1} 行 OHLC 关系无效` };
    }
    seen.add(date); bars.push(point);
  }
  if (bars.length < minimum) return { error: `有效数据仅 ${bars.length} 条，至少需要 ${minimum} 条` };
  bars.sort((a, b) => a.date.localeCompare(b.date)); return { bars };
}

function Chart({ values, kind, buys = [], sells = [], label }: { values: number[]; kind: "equity" | "dd" | "price"; buys?: number[]; sells?: number[]; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { const canvas = ref.current, parent = canvas?.parentElement; if (!canvas || !parent) return; const paint = () => { const w = Math.max(280, parent.clientWidth - 2), h = 206, dpr = window.devicePixelRatio || 1, ctx = canvas.getContext("2d"); if (!ctx) return; canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.height = `${h}px`; ctx.scale(dpr, dpr); const pad = { x: 9, top: 13, bottom: 25 }, cw = w - 18, ch = h - pad.top - pad.bottom, min = kind === "dd" ? Math.min(-.015, ...values) : Math.min(...values) * .993, max = kind === "dd" ? 0 : Math.max(...values) * 1.007; const x = (i: number) => pad.x + i / Math.max(1, values.length - 1) * cw, y = (v: number) => pad.top + (max - v) / Math.max(.0001, max - min) * ch; ctx.clearRect(0, 0, w, h); ctx.strokeStyle = "rgba(165,190,225,.15)"; ctx.lineWidth = 1; for (let n = 0; n < 4; n++) { const yy = pad.top + ch * n / 3; ctx.beginPath(); ctx.moveTo(pad.x, yy); ctx.lineTo(w - pad.x, yy); ctx.stroke(); } const fill = ctx.createLinearGradient(0, 0, 0, h); fill.addColorStop(0, kind === "dd" ? "rgba(244,103,91,.28)" : "rgba(49,215,173,.26)"); fill.addColorStop(1, "rgba(49,215,173,0)"); ctx.beginPath(); values.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))); ctx.lineTo(x(values.length - 1), y(min)); ctx.lineTo(x(0), y(min)); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); ctx.beginPath(); values.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))); ctx.strokeStyle = kind === "dd" ? "#f4675b" : kind === "price" ? "#7ba7ff" : "#31d7ad"; ctx.lineWidth = 2; ctx.stroke(); if (kind === "price") { buys.forEach((i) => { ctx.fillStyle = "#31d7ad"; ctx.beginPath(); ctx.arc(x(i), y(values[i]), 4, 0, Math.PI * 2); ctx.fill(); }); sells.forEach((i) => { ctx.fillStyle = "#f4675b"; ctx.beginPath(); ctx.arc(x(i), y(values[i]), 4, 0, Math.PI * 2); ctx.fill(); }); } ctx.fillStyle = "#8291a9"; ctx.font = "10px system-ui"; ctx.fillText("起始", 9, h - 7); ctx.fillText("最新", w - 28, h - 7); }; paint(); const ob = new ResizeObserver(paint); ob.observe(parent); return () => ob.disconnect(); }, [values, kind, buys, sells]); return <div className="canvas"><canvas ref={ref} role="img" aria-label={label} /></div>;
}
function Metric({ name, value, cls = "" }: { name: string; value: string; cls?: string }) { return <article className="metric"><span>{name}</span><strong className={cls}>{value}</strong></article>; }

function readWatchlist(value: unknown): WatchItem[] | null {
  const store = asObject(value);
  if (store.version !== 1 || !Array.isArray(store.symbols)) return null;
  const seen = new Set<string>(), items: WatchItem[] = [];
  for (const rawItem of store.symbols.slice(0, 12)) {
    const item = asObject(rawItem), symbol = asText(item.symbol, "").toUpperCase();
    if (!/^\d{6}\.(SH|SZ)$/.test(symbol) || seen.has(symbol)) continue;
    seen.add(symbol);
    items.push({
      symbol,
      label: asText(item.label, knownLabels[symbol] ?? symbol).slice(0, 32),
      addedAt: canonicalDate(item.addedAt) ?? "2026-07-25",
    });
  }
  return items;
}

function summarizeWatchBars(bars: Point[], strategy: Strategy, cost: number, fast: number, slow: number, entry: number, exit: number) {
  const closes = bars.map((bar) => bar.close), last = closes.length - 1, latest = bars.at(-1);
  const trailing = (days: number) => last >= days ? closes[last] / closes[last - days] - 1 : null;
  const ma20 = sma(closes, last, 20), ma60 = sma(closes, last, 60);
  const trend = latest && ma20 !== null && ma60 !== null
    ? latest.close > ma20 && ma20 > ma60 ? "偏强" : latest.close < ma20 && ma20 < ma60 ? "偏弱" : "震荡"
    : "待计算";
  const report = backtest(bars, strategy, cost, fast, slow, entry, exit);
  const signal = report.latestSignal !== "未触发" ? report.latestSignal : report.isHolding ? "模型持有" : "模型空仓";
  return { latest, d1: trailing(1), d20: trailing(20), d60: trailing(60), trend, signal, report };
}

function WatchlistModule({
  strategy, cost, fast, slow, entry, exit, onUse,
}: {
  strategy: Strategy; cost: number; fast: number; slow: number; entry: number; exit: number;
  onUse: (item: WatchItem, bars: Point[], view: SyncView) => void;
}) {
  const [items, setItems] = useState<WatchItem[]>(defaultWatchlist);
  const [snapshots, setSnapshots] = useState<Record<string, WatchSnapshot>>({});
  const [codeInput, setCodeInput] = useState("");
  const [labelInput, setLabelInput] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [message, setMessage] = useState("进入页面后会自动刷新一次；自选列表仅保存在这台电脑的当前浏览器。");
  const initialRefresh = useRef(false);

  const refreshOne = useCallback(async (symbol: string) => {
    setSnapshots((current) => ({ ...current, [symbol]: { ...current[symbol], status: "loading", error: undefined } }));
    try {
      const result = await fetchValidatedMarket(symbol, 260, 65);
      if (result.blockers.length) throw new Error(result.blockers.join("；"));
      setSnapshots((current) => ({ ...current, [symbol]: { status: "verified", view: result.view, bars: result.bars } }));
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "未知错误";
      setSnapshots((current) => ({ ...current, [symbol]: { ...current[symbol], status: "error", error: detail } }));
      return false;
    }
  }, []);

  useEffect(() => {
    let restored: WatchItem[] | null = null, restoreMessage = "";
    try {
      const raw = window.localStorage.getItem(watchlistStorageKey);
      if (raw !== null) restored = readWatchlist(JSON.parse(raw));
    } catch {
      restoreMessage = "本机自选记录无法读取，当前使用默认列表。";
    }
    const timer = window.setTimeout(() => {
      if (restored) setItems(restored);
      if (restoreMessage) setMessage(restoreMessage);
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(watchlistStorageKey, JSON.stringify({ version: 1, symbols: items }));
    } catch {
      window.setTimeout(() => setMessage("浏览器未允许保存自选列表；本次页面仍可临时使用。"), 0);
    }
  }, [hydrated, items]);

  useEffect(() => {
    if (!hydrated || initialRefresh.current) return;
    initialRefresh.current = true;
    void (async () => {
      for (const item of items) await refreshOne(item.symbol);
      if (items.length) setMessage(`已自动刷新 ${items.length} 个自选标的。`);
    })();
  }, [hydrated, items, refreshOne]);

  const refreshAll = async () => {
    if (!items.length) { setMessage("请先添加一个沪深股票或 ETF 代码。"); return; }
    setRefreshingAll(true);
    let passed = 0;
    for (const item of items) if (await refreshOne(item.symbol)) passed++;
    setRefreshingAll(false);
    setMessage(`刷新完成：${passed}/${items.length} 个标的通过双源验证。`);
  };

  const addItem = async () => {
    const symbol = codeInput.trim().toUpperCase();
    if (!/^\d{6}\.(SH|SZ)$/.test(symbol)) { setMessage("代码格式无效，请输入 512890.SH 或 159915.SZ。"); return; }
    const label = labelInput.trim().slice(0, 32) || knownLabels[symbol] || symbol;
    const existing = items.some((item) => item.symbol === symbol);
    if (!existing && items.length >= 12) { setMessage("最多跟踪 12 个标的，请先移除不需要的项目。"); return; }
    if (existing) {
      setItems((current) => current.map((item) => item.symbol === symbol ? { ...item, label } : item));
      setMessage(`${symbol} 已在自选中，名称已更新并重新校验。`);
    } else {
      setItems((current) => [...current, { symbol, label, addedAt: new Date().toISOString().slice(0, 10) }]);
      setMessage(`${symbol} 已加入自选，正在进行双源校验。`);
    }
    setCodeInput(""); setLabelInput("");
    await refreshOne(symbol);
  };

  const removeItem = (item: WatchItem) => {
    const confirmed = window.confirm(`确认从自选跟踪中移除“${item.label}（${item.symbol}）”吗？\n\n只会删除本机浏览器中的自选记录，不会删除历史行情数据。`);
    if (!confirmed) return;
    setItems((current) => current.filter((candidate) => candidate.symbol !== item.symbol));
    setSnapshots((current) => {
      const next = { ...current };
      delete next[item.symbol];
      return next;
    });
    setMessage(`${item.symbol} 已从本机自选列表移除。`);
  };

  return <section className="section watchlist" id="watchlist">
    <div className="title"><div><p className="eyebrow">PERSONAL WATCHLIST / VERIFIED DAILY DATA</p><h2>我的自选跟踪</h2></div><span>进入页面自动刷新一次 · 最多 12 个</span></div>
    <div className="watch-panel">
      <form className="watch-toolbar" onSubmit={(event) => { event.preventDefault(); void addItem(); }}>
        <label><span>沪深代码</span><input value={codeInput} onChange={(event) => setCodeInput(event.target.value.toUpperCase())} placeholder="例如 512890.SH" aria-label="自选沪深代码"/></label>
        <label><span>自定义名称（可选）</span><input value={labelInput} onChange={(event) => setLabelInput(event.target.value)} placeholder="例如 红利低波" maxLength={32} aria-label="自选名称"/></label>
        <button type="submit">加入跟踪</button>
        <button className="secondary" type="button" onClick={() => void refreshAll()} disabled={refreshingAll}>{refreshingAll ? "刷新中…" : "刷新全部"}</button>
      </form>
      <p className="watch-message" role="status" aria-live="polite">{message}</p>
      <Table><thead><tr><th>标的</th><th>最新价</th><th>当日</th><th>20日</th><th>60日</th><th>趋势</th><th>策略状态</th><th>数据质量</th><th>操作</th></tr></thead><tbody>
        {items.map((item) => {
          const snapshot = snapshots[item.symbol], summary = snapshot?.bars ? summarizeWatchBars(snapshot.bars, strategy, cost, fast, slow, entry, exit) : null;
          const loading = snapshot?.status === "loading", verified = snapshot?.status === "verified" && snapshot.view && summary;
          return <tr key={item.symbol}>
            <td><b>{item.label}</b><small>{item.symbol}</small></td>
            <td><b>{summary?.latest ? summary.latest.close.toFixed(summary.latest.close < 10 ? 3 : 2) : "—"}</b><small>{summary?.latest?.date ?? "待刷新"}</small></td>
            <td className={summary?.d1 === null || summary?.d1 === undefined ? "" : summary.d1 >= 0 ? "green" : "red"}>{summary?.d1 === null || summary?.d1 === undefined ? "—" : percent(summary.d1)}</td>
            <td className={summary?.d20 === null || summary?.d20 === undefined ? "" : summary.d20 >= 0 ? "green" : "red"}>{summary?.d20 === null || summary?.d20 === undefined ? "—" : percent(summary.d20)}</td>
            <td className={summary?.d60 === null || summary?.d60 === undefined ? "" : summary.d60 >= 0 ? "green" : "red"}>{summary?.d60 === null || summary?.d60 === undefined ? "—" : percent(summary.d60)}</td>
            <td><mark className={summary?.trend === "偏强" ? "buy" : summary?.trend === "偏弱" ? "weak" : "neutral"}>{summary?.trend ?? "待计算"}</mark></td>
            <td><mark className={summary?.signal.includes("买入") || summary?.signal.includes("持有") ? "buy" : summary?.signal.includes("卖出") ? "sell" : "neutral"}>{summary?.signal ?? "待计算"}</mark></td>
            <td><b className={snapshot?.status === "error" ? "red" : verified ? "green" : ""}>{loading ? "双源校验中" : snapshot?.status === "error" ? "校验失败" : verified ? snapshot.view?.stale ? "历史合格缓存" : `${snapshot.view?.grade} / ${snapshot.view?.score}` : "待刷新"}</b><small title={snapshot?.error}>{snapshot?.error ?? (snapshot?.view ? `${snapshot.view.usableSources} 源 · 一致率 ${percentPointLabel(snapshot.view.agreementPct)}` : "仅合格数据可载入")}</small></td>
            <td><div className="watch-actions"><button type="button" onClick={() => void refreshOne(item.symbol)} disabled={loading}>刷新</button><button type="button" onClick={() => verified && snapshot.bars && snapshot.view && onUse(item, snapshot.bars, snapshot.view)} disabled={!verified}>载入回测</button><button className="danger" type="button" onClick={() => removeItem(item)}>移除</button></div></td>
          </tr>;
        })}
        {!items.length && <tr><td className="empty" colSpan={9}>还没有自选标的。输入沪深代码后即可开始跟踪。</td></tr>}
      </tbody></Table>
      <p className="watch-boundary">涨跌幅按前复权日线收盘价计算；策略状态使用当前实验室参数。双源验证失败的标的不会进入回测。这里跟踪的是日线，不是实时盘口。</p>
    </div>
  </section>;
}

function cash(value: number) { return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 0 }).format(value); }
function ladderPercent(value: number | null) { return value === null ? "—" : percent(value, 1); }
function naturalPercent(value: number | null, digits = 2) { return value === null ? "—" : `${(value * 100).toFixed(digits)}%`; }
function recentMa250DistanceFloor(bars: Point[], days = 3) {
  if (bars.length < 250 + days - 1) return null;
  const closes = bars.map((bar) => bar.close);
  const distances = Array.from({ length: days }, (_, offset) => {
    const index = bars.length - days + offset;
    const average = sma(closes, index, 250);
    return average ? closes[index] / average - 1 : null;
  });
  return distances.some((value) => value === null) ? null : Math.min(...distances as number[]);
}
function confirmationDate(bars: Point[], start: string) {
  const index = bars.findIndex((bar) => bar.date === start);
  return index < 0 ? "—" : bars[Math.min(bars.length - 1, index + 2)]?.date ?? "—";
}

async function fetchLadderFactors(): Promise<FactorSnapshot> {
  const response = await fetch("/api/factors/dividend-ladder", { cache: "no-store" });
  const body = await response.json() as FactorSnapshot & { error?: string };
  if (!response.ok) throw new Error(body.error || `因子接口返回 ${response.status}`);
  return body;
}

async function fetchLadderFactorHistory(): Promise<FactorHistorySnapshot> {
  const response = await fetch("/api/factors/dividend-ladder/history", { cache: "no-store" });
  const body = await response.json() as FactorHistorySnapshot & { error?: string };
  if (!response.ok) throw new Error(body.error || `因子历史接口返回 ${response.status}`);
  return body;
}

function DividendLadderModule() {
  const [bars, setBars] = useState<Point[]>([]);
  const [view, setView] = useState<SyncView | null>(null);
  const [factors, setFactors] = useState<FactorSnapshot | null>(null);
  const [factorHistory, setFactorHistory] = useState<FactorHistorySnapshot | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "warning" | "error">("idle");
  const [message, setMessage] = useState("进入页面后自动校验一次 512890.SH；仅本机展示，不会下单。");
  const [feishu, setFeishu] = useState<FeishuStatus | null>(null);
  const [feishuMessage, setFeishuMessage] = useState("正在检查本机飞书配置…");
  const [testingFeishu, setTestingFeishu] = useState(false);
  const [position, setPosition] = useState(0);
  const [coldStartDate, setColdStartDate] = useState("");
  const [account, setAccount] = useState<DividendAccountPayload | null>(null);
  const [accountMessage, setAccountMessage] = useState("正在读取 5 万元实盘账本…");
  const [savingTrade, setSavingTrade] = useState(false);
  const [alipayHolding, setAlipayHolding] = useState<AlipayHoldingPayload | null>(null);
  const [alipayDraft, setAlipayDraft] = useState<AlipayHoldingDraft>(emptyAlipayHoldingDraft);
  const [alipayPreview, setAlipayPreview] = useState<AlipayHoldingDraft | null>(null);
  const [alipayMessage, setAlipayMessage] = useState("尚未导入 007467 联接基金持仓快照。");
  const [savingAlipayHolding, setSavingAlipayHolding] = useState(false);
  const [tradeDraft, setTradeDraft] = useState<DividendTradeDraft>({
    tradeDate: "",
    side: "buy",
    price: "",
    units: "",
    fee: "",
    note: "",
  });
  const refreshed = useRef(false);
  const positionLoaded = useRef(false);
  const notificationAttempt = useRef("");
  const tradeSubmission = useRef<{ fingerprint: string; key: string } | null>(null);
  const loadAccount = useCallback(async () => {
    try {
      const response = await fetch("/api/strategy/dividend-account", { cache: "no-store" });
      const body = await response.json() as DividendAccountPayload & { error?: string };
      if (!response.ok) throw new Error(body.error || `实盘账本接口返回 ${response.status}`);
      setAccount(body);
      setAccountMessage(body.trackingStatus === "active"
        ? `已载入 ${body.trades.length} 笔真实成交；仓位、成本和盈亏均由成交重算。`
        : "尚未录入真实成交。5 万元已设为策略本金，但当前持仓、现金与盈亏仍待你提供成交记录后确认。");
    } catch (error) {
      setAccount(null);
      setAccountMessage(`实盘账本暂不可用：${error instanceof Error ? error.message : "未知错误"}。`);
    }
  }, []);
  const loadAlipayHolding = useCallback(async () => {
    try {
      const response = await fetch("/api/strategy/alipay-holding", { cache: "no-store" });
      const body = await response.json() as AlipayHoldingPayload & { error?: string };
      if (!response.ok) throw new Error(body.error || `持仓快照接口返回 ${response.status}`);
      setAlipayHolding(body);
      setAlipayMessage(body.current ? `已载入 ${body.snapshots.length} 条只读快照；最新数据截至 ${body.current.asOfDate}。` : "尚未导入 007467 联接基金持仓快照。");
    } catch (error) { setAlipayHolding(null); setAlipayMessage(`持仓快照暂不可用：${error instanceof Error ? error.message : "未知错误"}。`); }
  }, []);
  const loadFeishuStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/notifications/feishu", { cache: "no-store" });
      const body = await response.json() as FeishuStatus;
      setFeishu(body);
      setFeishuMessage(body.configured
        ? body.mode === "app_bot"
          ? `已连接${body.destination ?? "飞书自建应用机器人"}。`
          : `已连接${body.destination ?? "飞书机器人"}${body.signed ? "，签名校验已启用" : "，当前未启用签名校验"}。`
        : body.mode === "app_bot" && body.appCredentialsConfigured && !body.receiverConfigured
          ? `已识别自建应用凭据，还缺接收对象 ${body.receiveIdType}。`
          : `尚未完成本机配置${body.missing?.length ? `：${body.missing.join("、")}` : ""}。`);
    } catch {
      setFeishu(null);
      setFeishuMessage("无法读取飞书配置状态。");
    }
  }, []);
  const refresh = useCallback(async () => {
    setStatus("loading"); setMessage("正在校验 512890.SH 日线，并同步股息率与十年国债收益率…");
    try {
      const [result, factorResult, historyResult] = await Promise.all([
        fetchValidatedMarket("512890.SH", 2000, 270, true),
        fetchLadderFactors().then((value) => ({ value, error: null })).catch((error) => ({ value: null, error: error instanceof Error ? error.message : "因子获取失败" })),
        fetchLadderFactorHistory().then((value) => ({ value, error: null })).catch((error) => ({ value: null, error: error instanceof Error ? error.message : "因子历史获取失败" })),
      ]);
      setView(result.view);
      setFactors(factorResult.value);
      setFactorHistory(historyResult.value);
      if (result.blockers.length) { setBars(result.bars); setStatus("warning"); setMessage(`当前不生成新买入指令：${result.blockers.join("；")}。`); return; }
      setBars(result.bars); setStatus(result.view.stale ? "warning" : "success");
      setMessage(result.view.stale
        ? `已取得历史合格缓存（截至 ${result.view.asOf}），仅供人工复核。`
        : factorResult.value
          ? `日线双源验证通过；股息率与利率因子已更新至 ${factorResult.value.asOf}。`
          : `日线双源验证通过；因子暂不可用（${factorResult.error}），机动仓降级为最多 75%。`);
    } catch (error) { setStatus("error"); setMessage(`无法载入红利低波数据：${error instanceof Error ? error.message : "未知错误"}。保留当前页面，不以单源或合成数据代替。`); }
  }, []);
  useEffect(() => { if (refreshed.current) return; refreshed.current = true; void refresh(); }, [refresh]);
  useEffect(() => {
    const saved = Number(window.localStorage.getItem("a-share-tracker.dividend-position.v1"));
    const savedColdStartDate = window.localStorage.getItem("a-share-tracker.dividend-cold-start.v1") ?? "";
    const restoreTimer = window.setTimeout(() => {
      if (Number.isFinite(saved) && saved >= 0 && saved <= 100) setPosition(saved);
      if (/^\d{4}-\d{2}-\d{2}$/.test(savedColdStartDate)) setColdStartDate(savedColdStartDate);
      positionLoaded.current = true;
      void Promise.all([loadFeishuStatus(), loadAccount(), loadAlipayHolding()]);
    }, 0);

    return () => window.clearTimeout(restoreTimer);
  }, [loadAccount, loadAlipayHolding, loadFeishuStatus]);
  useEffect(() => {
    if (!positionLoaded.current) return;
    window.localStorage.setItem("a-share-tracker.dividend-position.v1", String(position));
    if (coldStartDate) window.localStorage.setItem("a-share-tracker.dividend-cold-start.v1", coldStartDate);
  }, [position, coldStartDate]);
  const accountSummary = useMemo(
    () => account ? calculateDividendAccount(account.trades, bars.at(-1)?.close ?? null) : null,
    [account, bars],
  );
  const hasRecordedTrades = Boolean(account?.trades.length);
  const previewAlipayHolding = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (alipayDraft.fundCode !== "007467") { setAlipayMessage("只允许导入 007467 华泰柏瑞中证红利低波ETF联接C。"); return; }
    if (!alipayDraft.asOfDate || alipayDraft.units === "") { setAlipayMessage("请填写截至日期和持有份额后再预览。"); return; }
    setAlipayPreview({ ...alipayDraft, source: alipayDraft.source === "screenshot" || alipayDraft.source === "pdf" ? alipayDraft.source : alipayDraft.source });
    setAlipayMessage("已在本机生成预览，尚未写入数据库。请核对后明确确认导入。");
  };
  const confirmAlipayHolding = async () => {
    if (!alipayPreview || !alipayHolding) return;
    setSavingAlipayHolding(true);
    try {
      const response = await fetch("/api/strategy/alipay-holding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...alipayPreview, action: "confirm", expectedLedgerVersion: alipayHolding.ledgerVersion, idempotencyKey: crypto.randomUUID() }) });
      const body = await response.json() as AlipayHoldingPayload & { error?: string; idempotentReplay?: boolean };
      if (!response.ok) throw new Error(body.error || `导入接口返回 ${response.status}`);
      setAlipayHolding(body); setAlipayPreview(null); setAlipayDraft(emptyAlipayHoldingDraft());
      setAlipayMessage(body.idempotentReplay ? "相同文件或快照已存在，未重复新增。" : "已追加保存只读持仓快照；原文件未上传，仅保存 SHA-256。" );
    } catch (error) { setAlipayMessage(`未写入快照：${error instanceof Error ? error.message : "未知错误"}。`); }
    finally { setSavingAlipayHolding(false); }
  };
  const importAlipayFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      const fileHash = await sha256File(file); const lower = file.name.toLowerCase();
      if (lower.endsWith(".csv")) { const record = parseAlipayHoldingCsv(await file.text()); const pick = (key: string) => record[key] ?? ""; const parsed: Partial<AlipayHoldingDraft> = { asOfDate: pick("asofdate"), fundCode: pick("fundcode") as "007467", fundName: pick("fundname"), units: pick("units"), nav: pick("nav"), navDate: pick("navdate"), marketValue: pick("marketvalue"), holdingCost: pick("holdingcost"), holdingProfit: pick("holdingprofit"), fundEAccountUnits: pick("fundeaccountunits"), fundEAccountMarketValue: pick("fundeaccountmarketvalue") }; setAlipayDraft((current) => ({ ...current, ...parsed, source: "csv", fileHash })); setAlipayMessage("已从 CSV 读取结构化字段并计算 SHA-256；请预览后确认。原文件不会上传。"); }
      else { setAlipayDraft((current) => ({ ...current, source: lower.endsWith(".pdf") ? "pdf" : "screenshot", fileHash })); setAlipayMessage("截图/PDF 仅作为待人工核对来源，未做 OCR；请手工填写字段、预览并确认。原文件不会上传。"); }
    } catch (error) { setAlipayMessage(`无法读取文件：${error instanceof Error ? error.message : "未知错误"}。`); }
    event.target.value = "";
  };
  const strategyPositionPercent = hasRecordedTrades && typeof accountSummary?.strategyAllocation === "number"
    ? Math.min(100, Math.max(0, accountSummary.strategyAllocation * 100))
    : position;
  useEffect(() => {
    if (positionLoaded.current && strategyPositionPercent < 50 && !coldStartDate && view?.asOf) setColdStartDate(view.asOf);
  }, [coldStartDate, strategyPositionPercent, view?.asOf]);
  const decision = useMemo(() => evaluateEnhancedDividendLadder(
    bars,
    strategyPositionPercent / 100,
    { verified: Boolean(view?.verified) && !view?.stale, stale: Boolean(view?.stale) },
    factors ? {
      dividendYield: factors.dividend.value,
      dividendDate: factors.dividend.date,
      governmentBond10Y: factors.rate.value,
      rateDate: factors.rate.date,
      verified: factors.rate.verified,
    } : null,
    false,
    { coldStartDate: coldStartDate || undefined },
  ), [bars, strategyPositionPercent, view, factors, coldStartDate]);
  const report = useMemo(() => backtestDividendLadder(bars, { initialCapital: DIVIDEND_STRATEGY_CAPITAL }), [bars]);
  const factorHistoryPoints = useMemo(() => {
    if (!factorHistory) return [];
    const rateByDate = new Map(factorHistory.rate.map((point) => [point.date, point.value]));
    return factorHistory.dividend.map((point) => ({ date: point.date, dividendYield: point.value, governmentBond10Y: rateByDate.get(point.date) ?? null }));
  }, [factorHistory]);
  const volatilitySeries = useMemo(() => computeVolatilitySeries(bars), [bars]);
  const latestVolatility = volatilitySeries.at(-1) ?? null;
  const regime = useMemo(() => computePriceVolatilityRegimes(bars, factorHistoryPoints), [bars, factorHistoryPoints]);
  const latestRegimePoint = regime.points.at(-1) ?? null;
  const shadowRisk = useMemo(() => computePriceVolatilityShadowRisk(bars), [bars]);
  const effectiveTradeDate = tradeDraft.tradeDate || view?.asOf || "";
  const currentFraction = strategyPositionPercent / 100;
  const executionTarget = decision.target === null
    ? null
    : decision.target > currentFraction
      ? Math.min(decision.target, currentFraction + .25)
      : Math.max(decision.target, currentFraction - .25);
  const targetValue = decision.target === null ? null : DIVIDEND_STRATEGY_CAPITAL * decision.target;
  const deltaValue = executionTarget === null ? null : DIVIDEND_STRATEGY_CAPITAL * (executionTarget - currentFraction);
  const sellUnitBasis = accountSummary?.averageCost ?? decision.close;
  const lots = decision.close && deltaValue
    ? Math.floor(Math.abs(deltaValue) / (deltaValue < 0 ? sellUnitBasis ?? decision.close : decision.close) / 100)
    : 0;
  const estimatedExecutionCash = decision.close ? lots * 100 * decision.close : 0;
  const stagedAction = decision.target !== null && executionTarget !== null && Math.abs(decision.target - executionTarget) > .0001
    ? `本次先${executionTarget > currentFraction ? "加至" : "降至"}${Math.round(executionTarget * 100)}%（战略目标 ${Math.round(decision.target * 100)}%）`
    : decision.label;
  const actionText = decision.action === "sell" && view?.stale ? `${stagedAction}（历史缓存，请人工复核）` : stagedAction;
  const threeDayDistanceFloor = useMemo(() => recentMa250DistanceFloor(bars), [bars]);
  const tacticalSellStatus = decision.distance === null
    ? "等待 MA250 指标就绪"
    : currentFraction > .75
      ? decision.distance >= -.06
        ? `卖出一级已触发：本批 100% → 75%，减少 ${cash(DIVIDEND_STRATEGY_CAPITAL * .25)} 的策略成本档位`
        : `卖出一级待命：距 MA250 回升至 -6% 即 100% → 75%；当前 ${naturalPercent(decision.distance)}`
      : currentFraction > .5
        ? decision.distance >= -.01
          ? `卖出二级已触发：本批 75% → 50%，减少 ${cash(DIVIDEND_STRATEGY_CAPITAL * .25)} 的策略成本档位`
          : `卖出二级待命：距 MA250 回升至 -1% 即 75% → 50%；当前 ${naturalPercent(decision.distance)}`
        : "当前没有机动仓可回收；50% 核心仓不因普通反弹机械卖出";
  const coreProfitObservation = threeDayDistanceFloor === null
    ? "等待连续 3 个可计算交易日"
    : threeDayDistanceFloor >= .1
      ? "核心止盈二级进入人工观察：连续 3 日均高于年线 10%，可评估 35% → 20%"
      : threeDayDistanceFloor >= .05
        ? "核心止盈一级进入人工观察：连续 3 日均高于年线 5%，可评估 50% → 35%"
        : `尚未进入核心止盈观察：近 3 日最低偏离 ${naturalPercent(threeDayDistanceFloor)}`;
  const recordTrade = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSavingTrade(true);
    setAccountMessage("正在核对现金、持仓与成交顺序…");
    const submittedTrade = { ...tradeDraft, tradeDate: effectiveTradeDate };
    const fingerprint = JSON.stringify(submittedTrade);
    let reloadAfterConflict = false;
    if (!tradeSubmission.current || tradeSubmission.current.fingerprint !== fingerprint) {
      tradeSubmission.current = { fingerprint, key: crypto.randomUUID() };
    }
    try {
      const response = await fetch("/api/strategy/dividend-account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...submittedTrade,
          idempotencyKey: tradeSubmission.current.key,
          expectedLedgerVersion: account?.ledgerVersion ?? 0,
          price: Number(tradeDraft.price),
          amount: tradeDraft.side === "dividend" ? Number(tradeDraft.price) : undefined,
          units: Number(tradeDraft.units),
          fee: tradeDraft.fee ? Number(tradeDraft.fee) : 0,
        }),
      });
      const body = await response.json() as DividendAccountPayload & { error?: string };
      reloadAfterConflict = response.status === 409;
      if (!response.ok) throw new Error(body.error || `实盘账本接口返回 ${response.status}`);
      setAccount(body);
      tradeSubmission.current = null;
      setAccountMessage(`已记入 ${submittedTrade.tradeDate} 的${tradeDraft.side === "buy" ? "真实买入成交" : tradeDraft.side === "sell" ? "真实卖出成交" : "现金分红"}；账户指标已重新计算。`);
      setTradeDraft((current) => ({ ...current, price: "", units: "", fee: "", note: "" }));
    } catch (error) {
      if (reloadAfterConflict) await loadAccount();
      setAccountMessage(`未记入：${error instanceof Error ? error.message : "成交信息无效"}。`);
    } finally {
      setSavingTrade(false);
    }
  }, [account, effectiveTradeDate, loadAccount, tradeDraft]);
  const testFeishu = useCallback(async () => {
    setTestingFeishu(true);
    try {
      const response = await fetch("/api/notifications/feishu", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "test", currentPosition: currentFraction, coldStartDate: coldStartDate || undefined }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || `测试接口返回 ${response.status}`);
      setFeishuMessage("测试消息已发送，请到飞书群确认。");
    } catch (error) {
      setFeishuMessage(`测试失败：${error instanceof Error ? error.message : "未知错误"}。`);
    } finally {
      setTestingFeishu(false);
    }
  }, [coldStartDate, currentFraction]);
  useEffect(() => {
    if (
      !feishu?.configured
      || status !== "success"
      || (decision.action !== "buy" && decision.action !== "sell")
      || executionTarget === null
      || decision.target === null
      || decision.close === null
      || decision.ma250 === null
      || decision.distance === null
      || (decision.action === "buy" ? executionTarget <= currentFraction : executionTarget >= currentFraction)
      || !view?.asOf
    ) return;
    const attemptKey = [view.asOf, decision.action, currentFraction, coldStartDate, executionTarget, decision.target, decision.belowMaSince ?? "core"].join("|");
    if (notificationAttempt.current === attemptKey) return;
    notificationAttempt.current = attemptKey;
    void fetch("/api/notifications/feishu", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: decision.action, currentPosition: currentFraction, coldStartDate: coldStartDate || undefined }),
    }).then(async (response) => {
      const body = await response.json() as { sent?: boolean; deduplicated?: boolean; error?: string };
      if (!response.ok) throw new Error(body.error || `提醒接口返回 ${response.status}`);
      const actionName = decision.action === "buy" ? "买入" : "卖出";
      setFeishuMessage(body.sent ? `新的${actionName}批次已发送到飞书。` : body.deduplicated ? `该${actionName}批次已提醒过，本次不重复发送。` : "飞书提醒未发送。");
    }).catch((error) => {
      setFeishuMessage(`自动提醒失败：${error instanceof Error ? error.message : "未知错误"}。`);
    });
  }, [coldStartDate, currentFraction, decision, executionTarget, feishu, status, view]);
  return <section className="section ladder-section" id="dividend-ladder">
    <div className="title"><div><p className="eyebrow">HYBRID COLD START + TACTICAL LADDER / 512890.SH</p><h2>红利低波收益增强仓位</h2></div><span>交易日 12:00 本地飞书调度已启用 · 只使用完整 T-1 日线</span></div>
    <div className="ladder-panel">
      <div className="ladder-topline"><p>先用 20% → 35% → 50% 完成核心仓冷启动；价格足够便宜可提前，等待过久则按期限兜底。核心仓完成后才启用 75% / 100% 机动仓。不会连接券商或发送订单。</p><button type="button" onClick={() => void refresh()} disabled={status === "loading"}>{status === "loading" ? "校验中…" : "手动刷新"}</button></div>
      <div className={`sync-feedback ${status}`} role="status" aria-live="polite"><i />{message}</div>
      <div className="live-account">
        <div className="live-account-head">
          <div><p className="eyebrow">LIVE ACCOUNT / APPEND-ONLY FILLS</p><h3>红利低波独立实盘账户</h3></div>
          <span>策略本金固定 {cash(DIVIDEND_STRATEGY_CAPITAL)} · 真实成交与回测完全分开</span>
        </div>
        <div className={`account-feedback ${hasRecordedTrades ? "active" : "pending"}`} role="status">{accountMessage}</div>
        <div className="account-metrics">
          <div><span>策略本金</span><b>{cash(DIVIDEND_STRATEGY_CAPITAL)}</b></div>
          <div><span>可用现金</span><b>{hasRecordedTrades && accountSummary ? cash(accountSummary.cash) : "待录入"}</b></div>
          <div><span>真实持仓</span><b>{hasRecordedTrades && accountSummary ? `${accountSummary.units.toLocaleString("zh-CN")} 份` : "待录入"}</b></div>
          <div><span>策略成本档位</span><b>{hasRecordedTrades && accountSummary ? `${(accountSummary.strategyAllocation * 100).toFixed(1)}% · ${cash(accountSummary.costBasis)}` : "待录入"}</b></div>
          <div><span>移动平均成本</span><b>{hasRecordedTrades && accountSummary?.averageCost ? `¥${accountSummary.averageCost.toFixed(4)}` : "—"}</b></div>
          <div><span>累计现金分红</span><b>{hasRecordedTrades && accountSummary ? cash(accountSummary.dividendIncome) : "—"}</b></div>
          <div><span>账户权益</span><b>{hasRecordedTrades && accountSummary?.accountEquity !== null ? cash(accountSummary!.accountEquity!) : "待行情/成交"}</b></div>
          <div><span>累计盈亏</span><b className={accountSummary?.totalPnl !== null && (accountSummary?.totalPnl ?? 0) < 0 ? "red" : "green"}>{hasRecordedTrades && accountSummary?.totalPnl !== null ? cash(accountSummary!.totalPnl!) : "—"}</b></div>
        </div>
        <form className="trade-entry" onSubmit={recordTrade}>
          <label>成交日期<input required type="date" value={effectiveTradeDate} onChange={(event) => setTradeDraft((current) => ({ ...current, tradeDate: event.target.value }))}/></label>
          <label>类型<select value={tradeDraft.side} onChange={(event) => setTradeDraft((current) => ({ ...current, side: event.target.value as "buy" | "sell" | "dividend", units: event.target.value === "dividend" ? "" : current.units, fee: event.target.value === "dividend" ? "" : current.fee }))}><option value="buy">买入</option><option value="sell">卖出</option><option value="dividend">现金分红</option></select></label>
          <label>{tradeDraft.side === "dividend" ? "到账金额" : "成交价"}<input required type="number" min=".001" step=".001" inputMode="decimal" value={tradeDraft.price} onChange={(event) => setTradeDraft((current) => ({ ...current, price: event.target.value }))} placeholder={tradeDraft.side === "dividend" ? "实际到账金额" : "例如 1.234"}/></label>
          <label>成交份额<input required={tradeDraft.side !== "dividend"} disabled={tradeDraft.side === "dividend"} type="number" min="1" step="1" inputMode="numeric" value={tradeDraft.units} onChange={(event) => setTradeDraft((current) => ({ ...current, units: event.target.value }))} placeholder={tradeDraft.side === "dividend" ? "分红无需填写" : "券商成交份额"}/></label>
          <label>费用<input disabled={tradeDraft.side === "dividend"} type="number" min="0" step=".01" inputMode="decimal" value={tradeDraft.fee} onChange={(event) => setTradeDraft((current) => ({ ...current, fee: event.target.value }))} placeholder={tradeDraft.side === "dividend" ? "分红按 0" : "未填按 0"}/></label>
          <label className="trade-note">备注<input maxLength={200} value={tradeDraft.note} onChange={(event) => setTradeDraft((current) => ({ ...current, note: event.target.value }))} placeholder="例如：核心仓第一批"/></label>
          <button type="submit" disabled={savingTrade}>{savingTrade ? "核对中…" : tradeDraft.side === "dividend" ? "记入现金分红" : "记入真实成交"}</button>
        </form>
        <p className="account-boundary">账本只追加券商真实成交，不写入回测交易；若此前已经买入，请先按时间顺序补录历史成交。每笔记录会校验可用现金和可卖份额，目前不提供删除，避免误改实盘历史。</p>
        {Boolean(account?.trades.length) && <div className="trade-ledger"><Table><thead><tr><th>日期</th><th>类型</th><th>成交价 / 到账</th><th>份额</th><th>费用</th><th>备注</th></tr></thead><tbody>{account!.trades.slice(0, 10).map((trade) => <tr key={trade.id}><td>{trade.tradeDate}</td><td><mark className={trade.side === "buy" ? "buy" : trade.side === "sell" ? "sell" : "neutral"}>{trade.side === "buy" ? "买入" : trade.side === "sell" ? "卖出" : "现金分红"}</mark></td><td>{trade.side === "dividend" ? cash(trade.amount ?? 0) : `¥${trade.price.toFixed(4)}`}</td><td>{trade.side === "dividend" ? "—" : trade.units.toLocaleString("zh-CN")}</td><td>{trade.side === "dividend" ? "—" : `¥${trade.fee.toFixed(2)}`}</td><td>{trade.note || "—"}</td></tr>)}</tbody></Table></div>}
      </div>
      <div className="alipay-import">
        <div className="live-account-head"><div><p className="eyebrow">READ-ONLY HOLDING IMPORT / 007467</p><h3>支付宝 / 蚂蚁财富联接基金快照</h3></div><span>与 512890 策略信号、成交账本和行情估值完全隔离</span></div>
        <p className="account-boundary">只读取你主动提供的数据：不登录支付宝，不读取账号、密码、Cookie、验证码或短信；不申购、不赎回、不发送订单。截图和 PDF 不做 OCR，只能作为待人工核对来源。</p>
        <div className="account-feedback pending" role="status">{alipayMessage}</div>
        <div className="account-metrics">
          <div><span>007467 当前份额</span><b>{alipayHolding?.current ? `${alipayHolding.current.units.toLocaleString("zh-CN", { maximumFractionDigits: 6 })} 份` : "待导入"}</b></div>
          <div><span>净值 / 日期</span><b>{alipayHolding?.current?.nav ? `¥${alipayHolding.current.nav.toFixed(4)} · ${alipayHolding.current.navDate ?? "待填"}` : "待导入"}</b></div>
          <div><span>持仓市值</span><b>{alipayHolding?.current?.marketValue === null || !alipayHolding?.current ? "待导入" : cash(alipayHolding.current.marketValue)}</b></div>
          <div><span>占 5 万预算</span><b>{alipayHolding?.current?.marketValue === null || !alipayHolding?.current ? "待导入" : `${(alipayHolding.current.marketValue / 50_000 * 100).toFixed(2)}%`}</b></div>
          <div><span>来源</span><b>{alipayHolding?.current?.source ?? "—"}</b></div>
          <div><span>核验状态</span><b>{alipayHolding?.current?.verificationStatus === "verified" ? "已核验" : alipayHolding?.current?.verificationStatus === "discrepancy" ? "有差异" : alipayHolding?.current?.verificationStatus === "fund-e-delayed-review" ? "基金E账户延迟复核" : "待复核"}</b></div>
        </div>
        {alipayHolding?.reconciliation && (alipayHolding.reconciliation.unitsDifference !== null || alipayHolding.reconciliation.marketValueDifference !== null) && <p className="account-boundary">基金E账户差异：份额 {alipayHolding.reconciliation.unitsDifference ?? "待填"}；市值 {alipayHolding.reconciliation.marketValueDifference === null ? "待填" : cash(alipayHolding.reconciliation.marketValueDifference)}。</p>}
        <form className="alipay-entry" onSubmit={previewAlipayHolding}>
          <label>导入来源<select value={alipayDraft.source} onChange={(event) => setAlipayDraft((current) => ({ ...current, source: event.target.value as AlipayHoldingSource }))}><option value="manual">手工录入</option><option value="csv">结构化 CSV</option><option value="screenshot">截图（人工复核）</option><option value="pdf">PDF（人工复核）</option><option value="fund-e-account">基金E账户复核</option></select></label>
          <label>选择文件<input type="file" accept=".csv,.pdf,image/*" onChange={importAlipayFile}/><small>仅本机读取计算 SHA-256，不上传原文件</small></label>
          <label>截至日期<input required type="date" value={alipayDraft.asOfDate} onChange={(event) => setAlipayDraft((current) => ({ ...current, asOfDate: event.target.value }))}/></label>
          <label>基金代码<input required value={alipayDraft.fundCode} onChange={(event) => setAlipayDraft((current) => ({ ...current, fundCode: event.target.value as "007467" }))}/><small>严格仅限 007467</small></label>
          <label>基金名称<input required readOnly value={alipayDraft.fundName}/><small>服务端固定校验，不接受自定义名称</small></label>
          <label>持有份额<input required type="number" min="0" step=".000001" value={alipayDraft.units} onChange={(event) => setAlipayDraft((current) => ({ ...current, units: event.target.value }))}/></label>
          <label>单位净值<input type="number" min="0" step=".000001" value={alipayDraft.nav} onChange={(event) => setAlipayDraft((current) => ({ ...current, nav: event.target.value }))}/></label>
          <label>净值日期<input type="date" value={alipayDraft.navDate} onChange={(event) => setAlipayDraft((current) => ({ ...current, navDate: event.target.value }))}/></label>
          <label>持仓市值<input type="number" min="0" step=".01" value={alipayDraft.marketValue} onChange={(event) => setAlipayDraft((current) => ({ ...current, marketValue: event.target.value }))}/></label>
          <label>持有成本（可选）<input type="number" min="0" step=".01" value={alipayDraft.holdingCost} onChange={(event) => setAlipayDraft((current) => ({ ...current, holdingCost: event.target.value }))}/></label>
          <label>持有收益（可选）<input type="number" step=".01" value={alipayDraft.holdingProfit} onChange={(event) => setAlipayDraft((current) => ({ ...current, holdingProfit: event.target.value }))}/></label>
          <label>基金E份额（可选）<input type="number" min="0" step=".000001" value={alipayDraft.fundEAccountUnits} onChange={(event) => setAlipayDraft((current) => ({ ...current, fundEAccountUnits: event.target.value }))}/></label>
          <label>基金E市值（可选）<input type="number" min="0" step=".01" value={alipayDraft.fundEAccountMarketValue} onChange={(event) => setAlipayDraft((current) => ({ ...current, fundEAccountMarketValue: event.target.value }))}/></label>
          <label>核验状态<select value={alipayDraft.verificationStatus} onChange={(event) => setAlipayDraft((current) => ({ ...current, verificationStatus: event.target.value as AlipayVerificationStatus }))}><option value="pending-review">待复核</option><option value="fund-e-delayed-review">基金E账户延迟复核</option></select><small>“已核验/有差异”只能由基金E对照自动得出</small></label>
          <button type="submit">预览（不写入）</button>
        </form>
        <p className="account-boundary">CSV 支持表头：<code>asOfDate,fundCode,fundName,units</code>（必填）；可选 <code>nav,navDate,marketValue,holdingCost,holdingProfit,fundEAccountUnits,fundEAccountMarketValue</code>。首版一次只导入一条快照；不接收订单、确认或自由备注文本。</p>
        {alipayPreview && <div className="alipay-preview"><b>确认写入前预览</b><p>{alipayPreview.asOfDate} · {alipayPreview.fundCode} · {alipayPreview.fundName} · {alipayPreview.units} 份 · 市值 {alipayPreview.marketValue === "" ? "待填" : cash(Number(alipayPreview.marketValue))} · 文件 SHA-256 {alipayPreview.fileHash || "无（手工输入）"}</p><button type="button" disabled={savingAlipayHolding || !alipayHolding} onClick={() => void confirmAlipayHolding()}>{savingAlipayHolding ? "写入中…" : "确认追加只读快照"}</button></div>}
      </div>
      <div className="ladder-inputs">
        <label>{hasRecordedTrades ? "真实成交推导档位" : "临时策略档位"}<input type="number" min="0" max="100" step="5" value={Number(strategyPositionPercent.toFixed(2))} disabled={hasRecordedTrades} onChange={(event) => setPosition(Math.min(100, Math.max(0, Number(event.target.value) || 0)))} aria-label="当前策略仓位百分比"/><small>{hasRecordedTrades ? "剩余持仓成本 ÷ 固定 5 万元预算；不会随每日涨跌漂移" : "尚未补录成交，仅作策略临时输入，不代表实盘"}</small></label>
        <label>冷启动起始日<input type="date" min={bars.at(269)?.date ?? bars[0]?.date} max={view?.asOf} value={coldStartDate} onChange={(event) => setColdStartDate(event.target.value)} aria-label="冷启动起始交易日"/><small>默认从首次启用日计时；请选择已验证交易日</small></label>
        <label>实盘策略本金（人民币）<input type="number" readOnly value={DIVIDEND_STRATEGY_CAPITAL} aria-label="实盘策略资金人民币"/><small>固定为 50,000 元；所有分档金额按此计算</small></label>
        <div className={`ladder-call ${decision.action}`}><span>本次动作</span><b>{actionText}</b><small>{decision.ready && decision.phase === "cold-start" ? `冷启动第 ${decision.coldStartTradingDays ?? 0} 日 · 下一目标 ${Math.round((decision.nextTarget ?? .5) * 100)}% · 最迟第 ${decision.nextDeadlineTradingDay ?? "—"} 日` : decision.ready ? "核心仓完成后才按机动仓规则调整" : "等待足够的历史日线"}</small></div>
      </div>
      <div className="ladder-metrics" aria-label="红利低波仓位指标">
        <Metric name="最新收盘" value={decision.close ? `¥${decision.close.toFixed(3)}` : "—"}/><Metric name="MA250" value={decision.ma250 ? `¥${decision.ma250.toFixed(3)}` : "—"}/><Metric name="距 MA250" value={ladderPercent(decision.distance)} cls={decision.distance !== null && decision.distance < 0 ? "red" : "green"}/><Metric name="连续低于 MA250" value={decision.ready ? `${decision.belowMaDays} 个交易日` : "—"}/><Metric name="近20日低点反弹" value={ladderPercent(decision.rebound20Pct)} cls={decision.rebound20Pct !== null && decision.rebound20Pct >= .06 ? "red" : "green"}/><Metric name="冷启动计时" value={decision.phase === "cold-start" ? `第 ${decision.coldStartTradingDays ?? 0} 日` : "核心仓已完成"}/>
      </div>
      <div className="ladder-factor-grid" aria-label="红利低波估值与利率因子">
        <div><span>指数股息率 D/P2</span><b>{naturalPercent(decision.dividendYield)}</b><small>{factors ? `中证 H30269 官方 · ${factors.dividend.date}` : "因子暂不可用"}</small></div>
        <div><span>十年国债收益率</span><b>{naturalPercent(decision.governmentBond10Y, 3)}</b><small>{factors ? `中债官方 · ${factors.rate.date}` : "因子暂不可用"}</small></div>
        <div><span>股息—国债利差</span><b>{naturalPercent(decision.dividendSpread, 2)}</b><small>{factors?.rate.verified ? `新浪同日核验 · 差 ${factors.rate.differenceBps?.toFixed(2)} bp` : "等待同日次源核验"}</small></div>
        <div><span>利差允许总仓位</span><b>{decision.ready ? `${Math.round(decision.factorCap * 100)}%` : "—"}</b><small>{decision.factorMode === "strict" ? "只限制机动仓新增，不触发卖出" : decision.factorMode === "degraded" ? "缺失或未核验时最多 75%" : "历史回测未使用该因子"}</small></div>
      </div>
      <section className="ladder-history" aria-label="三指标历史位置">
        <div className="ladder-history-head"><div><p className="eyebrow">HISTORICAL POSITION / EVIDENCE FIRST</p><h3>三指标历史位置</h3></div><small>只使用真实观测；分位均为当时可得历史的点时分位。</small></div>
        <div className="ladder-history-grid">
          <div><span>股息—国债利差</span><b>{naturalPercent(decision.dividendSpread, 2)}</b><small>{factorHistory ? `官方 D/P2 覆盖 ${factorHistory.coverage.dividendStart ?? "—"} 至 ${factorHistory.coverage.dividendEnd ?? "—"}；有效同日 ${factorHistory.coverage.sameDaySpreadObservations} / ${factorHistory.coverage.dividendObservations}。${factorHistory.coverage.sameDaySpreadObservations < 252 ? "历史样本不足。" : ""}` : "历史因子暂不可用。"}</small></div>
          <div><span>512890 ETF价格 / MA250</span><b>{decision.close && decision.ma250 ? `¥${decision.close.toFixed(3)} / ¥${decision.ma250.toFixed(3)}` : "—"}</b><small>偏离 {ladderPercent(decision.distance)} · 点时价格分位 {latestRegimePoint?.pricePercentile === null || latestRegimePoint?.pricePercentile === undefined ? "—" : naturalPercent(latestRegimePoint.pricePercentile, 1)}。这是 ETF 价格，不是官方基金净值；不以 007467 净值替代。</small></div>
          <div><span>20日年化实现波动率</span><b>{latestVolatility?.rv20 === null || latestVolatility?.rv20 === undefined ? "—" : naturalPercent(latestVolatility.rv20, 2)}</b><small>756 日点时分位 {latestVolatility?.percentile === null || latestVolatility?.percentile === undefined ? "—" : naturalPercent(latestVolatility.percentile, 1)} · 参考 {latestVolatility?.referenceCount ?? 0} 个观测 · {latestVolatility?.ready ? "已就绪" : "历史样本不足"}</small></div>
        </div>
      </section>
      <section className="ladder-regimes" aria-label="历史低估与压力区间">
        <div className="ladder-history-head"><div><p className="eyebrow">HISTORICAL REGIMES</p><h3>历史低估与压力区间</h3></div><small>{regime.jointStatesEnabled ? "联合低估样本已满足最低覆盖要求。" : `联合低估：证据不足（股息利差仅 ${factorHistory?.coverage.sameDaySpreadObservations ?? 0} / 252 个真实同日观测），不生成联合低估。`}</small></div>
        <div className="regime-table"><Table><thead><tr><th>类型</th><th>开始</th><th>确认</th><th>结束 / 进行中</th><th>持续日</th><th>完整性</th></tr></thead><tbody>{regime.intervals.length ? regime.intervals.slice(-8).reverse().map((interval, index) => <tr key={`${interval.state}-${interval.start}-${index}`}><td>{interval.state === "price-deep-low" ? "价格深度低位" : interval.state === "price-low" ? "价格低位" : "波动压力"}</td><td>{interval.start}</td><td>{confirmationDate(bars, interval.start)}（连续 3 日）</td><td>{interval.end === bars.at(-1)?.date ? "进行中" : interval.end}</td><td>{interval.qualifyingDays} 日</td><td>{regime.jointStatesEnabled ? "价格 / 波动率完整" : "联合低估证据不足"}</td></tr>) : <tr><td className="empty" colSpan={6}>尚无达到确认门槛的价格低位、深度低位或波动压力区间。</td></tr>}</tbody></Table></div>
      </section>
      <section className={`ladder-shadow ${shadowRisk.riskBand}`} aria-label="未来跌破年线风险">
        <div><p className="eyebrow">SHADOW OBSERVATION / PRICE + VOLATILITY</p><h3>未来跌破年线风险</h3><p>双因子（价格＋波动率）影子观察；研究观察，不改变实盘仓位，不发送飞书。</p></div>
        <div><span>风险带</span><b>{shadowRisk.riskBand === "high" ? "高" : shadowRisk.riskBand === "elevated" ? "关注" : "低"}</b><small>{shadowRisk.status}</small></div>
        <div><span>主要因素</span><b>{shadowRisk.primaryFactor === "distance" ? "价格 / 年线偏离" : "波动率分位"}</b><small>{decision.distance !== null && decision.distance < 0 ? "已处年线下，使用现有仓位管理。" : "当前未处年线下。"}</small></div>
        <div><span>概率</span><b>{shadowRisk.probability === null ? "不可用" : naturalPercent(shadowRisk.probability, 1)}</b><small>当前没有足够、经验证的标签样本供概率估计。</small></div>
      </section>
      <div className="ladder-amounts"><div><span>战略目标档位 / 固定预算</span><b>{decision.target === null || targetValue === null ? "—" : `${Math.round(decision.target * 100)}% · ${cash(targetValue)}`}</b></div><div><span>本批预算档位变动（最多 25%）</span><b className={deltaValue !== null && deltaValue < 0 ? "red" : "green"}>{deltaValue === null ? "—" : `${deltaValue >= 0 ? "新增预算约 " : "减少持仓成本约 "}${cash(Math.abs(deltaValue))}`}</b></div><div><span>本批估算 100 份整手 / 市值</span><b>{decision.target === null ? "—" : `${lots} 手 · ${cash(estimatedExecutionCash)}`}</b></div></div>
      <Table><thead><tr><th>仓位层</th><th>价格加速条件</th><th>时间兜底</th><th>约束 / 收缩</th></tr></thead><tbody><tr><td>20% 核心一档</td><td>d ≤ -2%，连续 ≥ 5 日</td><td>第 21 日尝试；第 63 日强制</td><td>反弹 ≥ 6% 且 d &gt; -3% 时暂缓</td></tr><tr><td>35% 核心二档</td><td>d ≤ -5%，连续 ≥ 10 日</td><td>第 63 日尝试；第 105 日强制</td><td>核心仓不受股息利差上限影响</td></tr><tr><td>50% 核心三档</td><td>d ≤ -8%，连续 ≥ 15 日</td><td>第 126 日尝试；第 168 日强制</td><td>完成后才开放机动仓</td></tr><tr><td>75% 第一机动档</td><td>d ≤ -3%，连续 ≥ 5 日</td><td>无时间强制</td><td>d ≥ -1% 回到 50%；利差至少 1.5pp</td></tr><tr><td>100% 第二机动档</td><td>d ≤ -8%，连续 ≥ 15 日</td><td>无时间强制</td><td>d ≥ -6% 回到 75%；利差至少 3.0pp</td></tr><tr><td>极端风险</td><td>d ≤ -18%</td><td>立即转人工复核</td><td>停止摊低并回到 50%</td></tr></tbody></Table>
      <div className="sell-plan" aria-label="红利低波卖出建议">
        <div className={decision.action === "sell" ? "triggered" : ""}><span>自动卖出 · 机动仓</span><b>{tacticalSellStatus}</b><small>卖出同样每批最多 25%，并在 T 日确认、T+1 人工执行。</small></div>
        <div className={threeDayDistanceFloor !== null && threeDayDistanceFloor >= .05 ? "watching" : ""}><span>人工观察 · 核心止盈</span><b>{coreProfitObservation}</b><small>回测中 50%→35% 有改善，但历史股息利差未补齐，暂不自动下结论或发送卖出指令。</small></div>
        <div className={decision.distance !== null && decision.distance <= -.18 ? "risk" : ""}><span>风险减仓</span><b>{decision.distance !== null && decision.distance <= -.18 ? "已触发：停止摊低，高于 50% 的部分回到核心仓" : "距 MA250 ≤ -18% 时停止摊低并回到 50%"}</b><small>这是极端风险控制，不是“越跌越卖”核心仓。</small></div>
      </div>
      <details className="ladder-policy"><summary>查看完整策略执行顺序</summary><ol><li>新策略从所选起始交易日计时，核心仓按 20% → 35% → 50% 三档完成；每次只进入下一档。</li><li>价格达到对应偏离与连续跌破门槛时可提前买入；未达到时分别在第 21 / 63 / 126 日尝试，并在第 63 / 105 / 168 日硬截止。</li><li>若较近 20 日低点反弹至少 6%，且当前仍高于年线下 3%，暂停非强制核心仓买入；硬截止优先于反弹过滤。</li><li>50% 核心仓完成后，才按价格与持续时间生成 75% / 100% 机动仓候选。</li><li>股息率减十年国债收益率只限制新增机动仓：低于 1.5 个百分点最多 50%，1.5–3.0 最多 75%，不低于 3.0 最多 100%。</li><li>机动仓还要通过双源数据、MA250 斜率、连续 5 日修复、两日止跌和放量长阴护栏。</li><li>回升至年线下 6%收回至 75%，回升至年线下 1%收回至 50%；利差下降本身不触发卖出。</li><li>偏离达到 -18%时停止摊低并回到 50%核心仓；当前执行仍是 T 日收盘确认、T+1 开盘人工执行。</li></ol></details>
      <div className="ladder-guards"><b>服务器会同时报告已命中与尚未命中的条件</b><p><strong>已命中：</strong>{decision.matchedRules.length ? decision.matchedRules.join("；") : "暂无"}</p><p><strong>待命 / 阻挡：</strong>{decision.pendingRules.length || decision.gates.length ? [...new Set([...decision.pendingRules, ...decision.gates])].join("；") : "无"}</p><small>当前 MA250 20 日斜率为 {ladderPercent(decision.slope20)}。冷启动核心仓不靠追涨；核心仓完成后，机动仓才使用股息利差与趋势修复护栏。</small></div>
      <div className={`ladder-notify ${feishu?.configured ? "ready" : ""}`}><div><b>飞书策略提醒</b><p>{feishuMessage}</p><small>买入一级黄色、核心加仓橙色、机动重仓红色；卖出一级浅蓝、卖出二级青绿；等待灰色、人工复核紫色。正式买入与卖出都由服务器用实盘账本和已验证行情复算后发送。</small></div><button type="button" onClick={() => void testFeishu()} disabled={!feishu?.configured || testingFeishu}>{testingFeishu ? "发送中…" : "发送完整测试消息"}</button></div>
      {report.ready && <div className="ladder-backtest"><div><b>混合冷启动 v4（当前）</b><span>总收益 {percent(report.enhanced.total)} · 年化 {percent(report.enhanced.annual)} · 最大回撤 {percent(report.enhanced.maxDrawdown)} · {report.enhanced.trades} 笔</span></div>{report.volatilityGuarded && <div><b>v5（波动率限制新增机动仓）</b><span>总收益 {percent(report.volatilityGuarded.total)} · 年化 {percent(report.volatilityGuarded.annual)} · 最大回撤 {percent(report.volatilityGuarded.maxDrawdown)} · {report.volatilityGuarded.trades} 笔</span></div>}<div><b>立即 50% 核心仓（对照）</b><span>总收益 {percent(report.immediateCore.total)} · 年化 {percent(report.immediateCore.annual)} · 最大回撤 {percent(report.immediateCore.maxDrawdown)} · {report.immediateCore.trades} 笔</span></div><div><b>同期买入并持有</b><span>总收益 {percent(report.buyHold.total)} · 年化 {percent(report.buyHold.annual)} · 最大回撤 {percent(report.buyHold.maxDrawdown)}</span></div><p>回测本金固定 50,000 元，按 T 日收盘决策、T+1 开盘执行、单边 8 bps、100 份整手计算。历史股息利差序列不完整，未倒填当前利差；滚动窗口审计显示，冷启动主要换取更小的入场回撤，并非稳定提高收益。</p>{report.shortSample && <p>样本仅 {report.usableBars} 个可用交易日，少于 750 日；结果仅作短样本规则检查，不宜据此推断长期表现。</p>}</div>}
    </div>
  </section>;
}

export default function TrackerApp() {
  const [activeView, setActiveView] = useState<AppView>("overview");
  const [generated] = useState(() => makeData()); const [data, setData] = useState(generated); const [dataMode, setDataMode] = useState<DataMode>("synthetic"); const [activeSymbol, setActiveSymbol] = useState("合成样本"); const [strategy, setStrategy] = useState<Strategy>("trend"); const [cost, setCost] = useState(8); const [fast, setFast] = useState(12); const [slow, setSlow] = useState(36); const [entry, setEntry] = useState(38); const [exit, setExit] = useState(67); const [notice, setNotice] = useState("当前使用沪深 A 股固定合成数据 · 260 个交易日");
  const [symbol, setSymbol] = useState("510300.SH"), [syncing, setSyncing] = useState(false), [syncView, setSyncView] = useState<SyncView | null>(null), [syncFeedback, setSyncFeedback] = useState("尚未发起双源同步。只有通过交叉验证的数据才会进入回测。"), [syncTone, setSyncTone] = useState<"idle" | "loading" | "success" | "warning" | "error">("idle");
  useEffect(() => {
    const syncFromHash = () => { const view = viewByHash[window.location.hash]; if (view) setActiveView(view); };
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);
  const selectView = useCallback((view: AppView) => {
    setActiveView(view);
    const hash = appViews.find((item) => item.id === view)?.hash ?? "#market";
    if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);
  const report = useMemo(() => backtest(data, strategy, cost, fast, slow, entry, exit), [data, strategy, cost, fast, slow, entry, exit]);
  const modeLabel = dataMode === "verified" ? `${activeSymbol} · 双源已验证` : dataMode === "csv" ? "本地 CSV · 未交叉验证" : "固定合成数据";
  const syncMarket = async () => {
    const normalizedSymbol = symbol.trim().toUpperCase();
    if (!/^\d{6}\.(SH|SZ)$/.test(normalizedSymbol)) { setSyncTone("error"); setSyncFeedback("代码格式无效，请使用 510300.SH 或 159915.SZ 这类格式。"); return; }
    setSyncing(true); setSyncTone("loading"); setSyncFeedback(`正在同步 ${normalizedSymbol} 的主、次数据源并执行交叉验证…`);
    try {
      const result = await fetchValidatedMarket(normalizedSymbol, 260, Math.max(45, slow + 5));
      setSyncView({ ...result.view });
      if (result.blockers.length) { setSyncTone("warning"); setSyncFeedback(`已阻止进入回测：${result.blockers.join("；")}。请查看质量详情，当前数据未变更。`); return; }
      setData(result.bars); setDataMode("verified"); setActiveSymbol(result.view.symbol);
      setSyncTone("success"); setSyncFeedback(result.view.cached ? `${normalizedSymbol} 已载入经验证的缓存版本${result.view.stale ? "（上游不可用，当前为历史合格版本降级）" : ""}。` : `${normalizedSymbol} 双源交叉验证通过，已载入回测。`);
      setNotice(`真实日线已载入：${result.bars.length} 条，数据截至 ${result.bars.at(-1)?.date}。`);
    } catch (error) { setSyncTone("error"); setSyncFeedback(`同步失败：${error instanceof Error ? error.message : "未知错误"}。已保留当前回测数据。`); }
    finally { setSyncing(false); }
  };
  const upload = (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => { const parsed = parseCsvText(String(reader.result || ""), Math.max(45, slow + 5)); if (!parsed.bars) { setNotice(`导入失败：${parsed.error}；当前回测数据未变更。`); return; } setData(parsed.bars); setDataMode("csv"); setActiveSymbol(file.name); setNotice(`已严格校验并按日期升序载入 ${parsed.bars.length} 条 A 股日线；${parsed.bars.some((bar) => bar.open) ? "将优先使用下一日 open 成交" : "CSV 无 open，下一日成交将回退到 close"}。`); }; reader.onerror = () => setNotice("导入失败：文件读取错误；当前回测数据未变更。"); reader.readAsText(file, "utf-8"); };
  return <main className="app">
    <header><div className="brand"><i>α</i> A股 · 板块研究台</div><nav className="top-tabs" aria-label="功能页签" role="tablist">{appViews.map((view) => <button type="button" id={`tab-${view.id}`} role="tab" aria-selected={activeView === view.id} aria-controls={`panel-${view.id}`} className={activeView === view.id ? "active" : ""} onClick={() => selectView(view.id)} key={view.id}>{view.label}</button>)}</nav><div className="status"><b />{modeLabel}　截至 {data.at(-1)?.date}</div></header>
    <div className="app-view" id="panel-overview" role="tabpanel" aria-labelledby="tab-overview" hidden={activeView !== "overview"}>
    <section className="hero" id="market"><div><p className="eyebrow">A-SHARE SECTOR RESEARCH / DATA THROUGH {data.at(-1)?.date}</p><h1>先看板块，<br /><em>再等规则信号。</em></h1><p>当前聚焦沪深 A 股：先观察行业与主题板块强弱，再用日线收盘条件回测下一交易日开盘的执行结果。</p></div><aside><span>{modeLabel}</span><strong>{data.length} <small>日线数据点</small></strong><div className="thermo"><i /></div><span>信号收盘确认 · 下一日 open 成交</span></aside></section>
    <section className="section"><div className="title"><div><p className="eyebrow">A-SHARE SECTOR PULSE / SYNTHETIC</p><h2>A 股板块强弱</h2></div><span>行业与主题合成样本 · 非实时行情</span></div><div className="sectors">{sectorRows.map(([name, move, type, note], i) => <article className={type} key={name}><small>0{i + 1}</small><b>{name}</b><strong>{move}</strong><p>{note}</p><i style={{ width: `${82 - i * 10}%` }} /></article>)}</div></section>
    </div>
    <div className="app-view" id="panel-assets" role="tabpanel" aria-labelledby="tab-assets" hidden={activeView !== "assets"}>
    <section className="section" id="assets"><div className="title"><div><p className="eyebrow">A-SHARE INSTRUMENT RADAR / SYNTHETIC</p><h2>A 股与场内 ETF 样本</h2></div><span>合成演示横截面 · 非实时行情</span></div><Table><thead><tr><th>标的</th><th>样本价格</th><th>样本涨跌</th><th>趋势</th><th>归属板块</th></tr></thead><tbody>{assets.map(([name, code, value, move, trend, sector]) => <tr key={code}><td><b>{name}</b><small>{code}</small></td><td>{value}</td><td className={move.startsWith("-") ? "red" : "green"}>{move}</td><td><mark className={trend === "偏弱" ? "weak" : trend === "中性" ? "neutral" : ""}>{trend}</mark></td><td>{sector}</td></tr>)}</tbody></Table></section>
    </div>
    <div className="app-view" id="panel-watchlist" role="tabpanel" aria-labelledby="tab-watchlist" hidden={activeView !== "watchlist"}>
    <WatchlistModule strategy={strategy} cost={cost} fast={fast} slow={slow} entry={entry} exit={exit} onUse={(item, bars, view) => {
      setData(bars); setDataMode("verified"); setActiveSymbol(item.symbol); setSymbol(item.symbol); setSyncView({ ...view });
      setSyncTone("success"); setSyncFeedback(`${item.symbol} 已从自选列表载入回测。`);
      setNotice(`${item.label} 已载入：${bars.length} 条双源验证日线，数据截至 ${bars.at(-1)?.date}。`);
      selectView("lab");
    }}/>
    </div>
    <div className="app-view" id="panel-dividend" role="tabpanel" aria-labelledby="tab-dividend" hidden={activeView !== "dividend"}>
    <DividendLadderModule />
    </div>
    <div className="app-view" id="panel-data" role="tabpanel" aria-labelledby="tab-data" hidden={activeView !== "data"}>
    <section className="section real-data" id="real-data">
      <div className="title"><div><p className="eyebrow">DUAL-SOURCE VERIFICATION</p><h2>真实数据与交叉验证</h2></div><span>手动同步 · 不自动刷新</span></div>
      <div className="sync-panel">
        <div className="sync-action">
          <div><label htmlFor="market-symbol">沪深代码</label><div className="symbol-input"><input id="market-symbol" list="symbol-options" value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} placeholder="510300.SH"/><datalist id="symbol-options"><option value="510300.SH">沪深300ETF</option><option value="510050.SH">上证50ETF</option><option value="159915.SZ">创业板ETF</option><option value="159919.SZ">沪深300ETF</option></datalist><button type="button" onClick={syncMarket} disabled={syncing}>{syncing ? "同步与校验中…" : "同步双源数据"}</button></div></div>
          <p>请求主、次源日线并在服务端交叉验证。只有 verified、双源无冲突且数据量充足时，才会替换当前回测数据。</p>
        </div>
        <div className={`sync-feedback ${syncTone}`} role="status" aria-live="polite"><i />{syncFeedback}</div>
        <div className="quality-grid" aria-label="真实数据质量详情">
          <Quality name="验证状态" value={syncing ? "校验中" : syncView?.verified ? syncView.cached ? "cached verified" : "verified" : syncView ? "未通过" : "待同步"} tone={syncView?.verified ? "good" : ""}/>
          <Quality name="缓存 / 降级" value={syncView ? syncView.cached ? syncView.stale ? "历史合格缓存 · 降级" : "命中合格缓存" : "实时同步" : "—"} tone={syncView?.stale ? "warn" : ""}/>
          <Quality name="数据截至" value={syncView?.asOf ?? "—"}/>
          <Quality name="主数据源" value={syncView?.sources[0] ? `${syncView.sources[0].provider} · ${syncView.sources[0].status}` : "—"}/>
          <Quality name="次数据源" value={syncView?.sources[1] ? `${syncView.sources[1].provider} · ${syncView.sources[1].status}` : "—"}/>
          <Quality name="复权口径" value={syncView?.adjustment === "qfq" ? "前复权 · qfq" : syncView?.adjustment ?? "—"}/>
          <Quality name="覆盖率" value={ratioLabel(syncView?.coverage ?? null)}/>
          <Quality name="双源一致率" value={percentPointLabel(syncView?.agreementPct ?? null)}/>
          <Quality name="重叠交易日" value={syncView?.overlapDays === null || syncView?.overlapDays === undefined ? "—" : `${syncView.overlapDays} 日`}/>
          <Quality name="最大价格差" value={bpsLabel(syncView?.maxPriceDiffBps ?? null)}/>
          <Quality name="质量分 / 等级" value={syncView ? `${syncView.score ?? "—"} / ${syncView.grade}` : "—"} tone={syncView?.verified ? "good" : ""}/>
          <Quality name="数据版本" value={syncView?.version ?? "—"}/>
          <Quality name="数据 Hash" value={syncView?.hash ?? "—"} mono/>
          <Quality name="冲突数" value={syncView ? `${syncView.conflicts} 日` : "—"} tone={syncView?.conflicts ? "bad" : syncView ? "good" : ""}/>
          <Quality name="日线数量" value={syncView ? `${syncView.barsCount} 条` : "—"}/>
        </div>
        <p className="sync-boundary">单源、存在冲突、未验证或数据量不足时，结果只展示质量诊断，绝不会静默进入回测。上游失败时可能返回历史 verified 缓存，并明确标注降级。</p>
      </div>
    </section>
    </div>
    <div className="app-view" id="panel-lab" role="tabpanel" aria-labelledby="tab-lab" hidden={activeView !== "lab"}>
    <section className="lab" id="lab"><div className="lab-title"><div><p className="eyebrow">A-SHARE STRATEGY LAB / CLOSE → NEXT OPEN</p><h2>A 股策略实验室</h2><p>日线信号仅在当日<b>收盘后</b>确认，下一交易日优先按 <b>open</b> 成交；open 缺失才回退 close。买入数量按 100 股（份）整数倍模拟。</p></div><span className={`pill mode-${dataMode}`}>{dataMode === "verified" ? "VERIFIED REAL DATA" : dataMode === "csv" ? "LOCAL CSV" : "A-SHARE SYNTHETIC"}</span></div>
      <div className="tabs" role="tablist"><button role="tab" aria-selected={strategy === "trend"} className={strategy === "trend" ? "selected" : ""} onClick={() => setStrategy("trend")}><i>01</i><b>趋势恢复</b><small>均线由弱转强时介入</small></button><button role="tab" aria-selected={strategy === "rsi"} className={strategy === "rsi" ? "selected" : ""} onClick={() => setStrategy("rsi")}><i>02</i><b>RSI 回撤恢复</b><small>超卖反弹且趋势未破时介入</small></button></div>
      <div className="work"><aside className="controls"><div><b>A 股回测参数</b><button onClick={() => { setData(generated); setDataMode("synthetic"); setActiveSymbol("合成样本"); setNotice("已恢复沪深 A 股固定合成数据 · 260 个交易日"); }}>恢复合成数据</button></div><Control label="单边综合成本" value={`${cost} bps`} min={0} max={30} state={cost} set={setCost}/><Control label="快均线" value={`${fast} 日`} min={5} max={25} state={fast} set={setFast}/><Control label="慢均线" value={`${slow} 日`} min={26} max={90} state={slow} set={setSlow}/>{strategy === "rsi" && <><Control label="RSI 入场" value={String(entry)} min={25} max={50} state={entry} set={setEntry}/><Control label="RSI 离场" value={String(exit)} min={55} max={85} state={exit} set={setExit}/></>}<div className="mode-card"><span>当前回测数据</span><b>{modeLabel}</b><small>{data.length} 条 · 截至 {data.at(-1)?.date}</small></div><label className="upload"><b>导入 A 股日线 CSV</b><span>必需列：date、close；可选 open/high/low/volume。若无 open，成交回退 close。CSV 未经双源验证，仅驱动单标的回测。</span><input type="file" accept=".csv,text/csv" aria-label="导入 A 股日线 CSV" onChange={upload}/></label><p role="status">{notice}</p></aside>
      <div className="reports"><div className="metrics"><Metric name="总收益" value={percent(report.total)} cls={report.total >= 0 ? "green" : "red"}/><Metric name="年化收益" value={percent(report.annual)} cls={report.annual >= 0 ? "green" : "red"}/><Metric name="最大回撤" value={percent(report.maxDD)} cls="red"/><Metric name="夏普比率" value={report.sharpe.toFixed(2)} cls={report.sharpe >= 1 ? "green" : ""}/><Metric name="胜率" value={percent(report.winRate, 0)} cls={report.winRate >= .5 ? "green" : ""}/><Metric name="完成交易" value={`${report.rounds} 次`} cls="green"/></div><article className="rule-status"><div><p className="eyebrow">A-SHARE RULE STATE</p><h3>最新规则状态</h3></div><dl><div><dt>当前策略</dt><dd>{strategy === "trend" ? "趋势恢复" : "RSI 回撤恢复"}</dd></div><div><dt>规则判定</dt><dd className={report.latestSignal === "未触发" ? "" : "green"}>{report.latestSignal}</dd></div><div><dt>模拟持仓</dt><dd>{report.isHolding ? "持仓" : "空仓"}</dd></div><div><dt>数据截至</dt><dd>{data.at(-1)?.date}</dd></div><div><dt>下一理论执行日</dt><dd>{report.nextExecution}</dd></div></dl><p>下一理论执行日仅按工作日推算，未排除交易所休市日；规则状态只用于回测解释，<b>不是买入建议。</b></p></article><div className="charts"><Card name="策略净值" helper="初始资金 ¥100,000"><Chart kind="equity" values={report.equity} label="策略净值曲线"/></Card><Card name="回撤路径" helper="峰值回落幅度"><Chart kind="dd" values={report.drawdown} label="回撤曲线"/></Card></div><Card name="价格与交易点" helper="● 买入　● 卖出" wide><Chart kind="price" values={data.map((x) => x.close)} buys={report.buys} sells={report.sells} label="价格和买卖点图"/></Card></div></div>
      <article className="trades"><div className="title"><div><p className="eyebrow">A-SHARE EXECUTION LOG</p><h2>交易明细</h2></div><span>T 日收盘确认 → T+1 日 open 成交（缺失回退 close）</span></div><Table><thead><tr><th>日期</th><th>动作</th><th>成交价</th><th>成交依据</th><th>数量</th><th>信号说明</th><th>单笔结果</th></tr></thead><tbody>{report.trades.slice(-12).reverse().map((t, i) => <tr key={`${t.date}-${i}`}><td>{t.date}</td><td><mark className={t.side === "买入" ? "buy" : "sell"}>{t.side}</mark></td><td>¥{t.price.toFixed(2)}</td><td>{t.fillBasis}</td><td>{t.units.toFixed(0)}</td><td>{t.reason}</td><td className={t.pnl === undefined ? "" : t.pnl >= 0 ? "green" : "red"}>{t.pnl === undefined ? "—" : percent(t.pnl)}</td></tr>)}{!report.trades.length && <tr><td className="empty" colSpan={7}>当前参数尚未生成可执行交易。请调整窗口或导入更多行情。</td></tr>}</tbody></Table></article>
      <footer><b>A 股回测边界</b>：信号在 T 日收盘后产生，T+1 数据点优先以 open 成交，缺失时明确回退 close；当前按 100 股（份）整数倍简化模拟。单边综合成本由你设定，尚未精细模拟最低佣金、卖出印花税、停复牌、涨跌幅限制、无法成交及法定休市日。真实数据须双源验证后才会进入回测；合成与 CSV 模式会明确标注。历史回测不代表未来表现，不构成投资建议或买卖依据。</footer>
    </section>
    </div>
  </main>;
}
function Control({ label, value, min, max, state, set }: { label: string; value: string; min: number; max: number; state: number; set: (v: number) => void }) { return <label className="control">{label}<output>{value}</output><input type="range" aria-label={label} min={min} max={max} value={state} onChange={(e) => set(Number(e.target.value))}/></label>; }
function Card({ name, helper, children, wide = false }: { name: string; helper: string; children: React.ReactNode; wide?: boolean }) { return <article className={`card ${wide ? "wide" : ""}`}><div><b>{name}</b><span>{helper}</span></div>{children}</article>; }
function Table({ children }: { children: React.ReactNode }) { return <div className="table"><table>{children}</table></div>; }
function Quality({ name, value, tone = "", mono = false }: { name: string; value: string; tone?: string; mono?: boolean }) { return <div className={`quality-item ${tone}`}><span>{name}</span><b className={mono ? "mono" : ""} title={value}>{value}</b></div>; }
