import { normalizeSymbol } from "./symbols";
import type { MarketBar, NormalizedSymbol, ProviderResponse } from "./types";

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TENCENT_PAGE_SIZE = 640;

export class ProviderError extends Error {
  readonly provider: "eastmoney" | "tencent";

  constructor(message: string, provider: "eastmoney" | "tencent") {
    super(message);
    this.provider = provider;
  }
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

async function getJson(url: string, provider: "eastmoney" | "tencent"): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "market-data-mvp/1.0" },
    });
    if (!response.ok) throw new ProviderError(`upstream HTTP ${response.status}`, provider);
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_RESPONSE_BYTES) throw new ProviderError("upstream response is too large", provider);
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new ProviderError("upstream response is too large", provider);
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderError("upstream returned invalid JSON", provider);
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    const message = error instanceof Error && error.name === "AbortError" ? "upstream request timed out" : "upstream request failed";
    throw new ProviderError(message, provider);
  } finally {
    clearTimeout(timer);
  }
}

function asRows(value: unknown): unknown[][] {
  return Array.isArray(value) ? value.filter(Array.isArray) : [];
}

export function parseEastmoney(raw: unknown): MarketBar[] {
  const rows = (raw as { data?: { klines?: unknown[] } })?.data?.klines;
  if (!Array.isArray(rows)) throw new ProviderError("upstream payload has no kline rows", "eastmoney");
  return rows.filter((row): row is string => typeof row === "string").map((row) => {
    const [date, open, close, high, low, volume, amount] = row.split(",");
    return { date, open: number(open), close: number(close), high: number(high), low: number(low), volume: number(volume), amount: number(amount) };
  });
}

export function parseTencent(raw: unknown, symbol: NormalizedSymbol): MarketBar[] {
  const parsed = parseTencentRows(raw, symbol);
  if (!parsed.length) throw new ProviderError("upstream payload has no qfq day rows", "tencent");
  return parsed;
}

function parseTencentRows(raw: unknown, symbol: NormalizedSymbol): MarketBar[] {
  const block = (raw as { data?: Record<string, { qfqday?: unknown[][]; day?: unknown[][] }> })?.data?.[symbol.tencentSymbol];
  // Some ETFs have no separate qfq series in Tencent's response. The daily
  // series is still cross-checked and the response remains labeled qfq MVP.
  const rows = asRows(block?.qfqday ?? block?.day);
  return rows.map((row) => {
    // Tencent QFQ response: date, open, close, high, low, volume[, amount].
    const [date, open, close, high, low, volume, amount] = row;
    const parsed: MarketBar = { date: String(date), open: number(open), close: number(close), high: number(high), low: number(low), volume: number(volume) };
    // The seventh Tencent field is not stable: on corporate-action dates it
    // can be a dividend metadata object rather than turnover amount.
    if ((typeof amount === "number" || (typeof amount === "string" && amount.trim() !== ""))) {
      const parsedAmount = number(amount);
      if (Number.isFinite(parsedAmount)) parsed.amount = parsedAmount;
    }
    return parsed;
  });
}

/** Combines newest-first Tencent pages into a chronological, unique series. */
export function mergeTencentPages(pages: MarketBar[][], limit: number): MarketBar[] {
  const byDate = new Map<string, MarketBar>();
  for (const page of pages) {
    for (const bar of page) {
      // A boundary can appear in adjacent pages. Keep the latest-page copy.
      if (!byDate.has(bar.date)) byDate.set(bar.date, bar);
    }
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date)).slice(-limit);
}

/** Returns the calendar day immediately preceding a Tencent page's earliest bar. */
export function previousTencentPageEnd(earliestDate: string): string {
  const date = new Date(`${earliestDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== earliestDate) {
    throw new ProviderError("upstream qfq day row has an invalid date", "tencent");
  }
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function buildTencentFqklineUrl(tencentSymbol: string, pageSize: number, endDate?: string): string {
  const params = new URLSearchParams({ param: `${tencentSymbol},day,,${endDate ?? ""},${pageSize},qfq` });
  return `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?${params}`;
}

export async function fetchEastmoney(symbolValue: string, days: number): Promise<ProviderResponse> {
  const symbol = normalizeSymbol(symbolValue);
  const params = new URLSearchParams({
    secid: symbol.eastmoneySecid,
    klt: "101",
    fqt: "1",
    lmt: String(days),
    end: "20500101",
    fields1: "f1,f2,f3,f4,f5,f6",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
  });
  const requestUrl = `https://push2his.eastmoney.com/api/qt/stock/kline/get?${params}`;
  const raw = await getJson(requestUrl, "eastmoney");
  return { provider: "eastmoney", requestUrl, raw, bars: parseEastmoney(raw) };
}

export async function fetchTencent(symbolValue: string, days: number): Promise<ProviderResponse> {
  const symbol = normalizeSymbol(symbolValue);
  const pages: Array<{ requestUrl: string; raw: unknown }> = [];
  const parsedPages: MarketBar[][] = [];
  let endDate: string | undefined;

  while (mergeTencentPages(parsedPages, days).length < days) {
    const remaining = days - mergeTencentPages(parsedPages, days).length;
    const requestUrl = buildTencentFqklineUrl(symbol.tencentSymbol, Math.min(remaining, TENCENT_PAGE_SIZE), endDate);
    const raw = await getJson(requestUrl, "tencent");
    pages.push({ requestUrl, raw });
    const page = parseTencentRows(raw, symbol);
    if (!page.length) break; // Reached the listing start (or an empty historical page).

    const before = mergeTencentPages(parsedPages, days).length;
    parsedPages.push(page);
    const merged = mergeTencentPages(parsedPages, days);
    if (merged.length === before) break; // The upstream repeated a boundary page.

    const earliestDate = page.reduce((earliest, bar) => (bar.date < earliest ? bar.date : earliest), page[0].date);
    endDate = previousTencentPageEnd(earliestDate);
  }

  const bars = mergeTencentPages(parsedPages, days);
  if (!bars.length) throw new ProviderError("upstream payload has no qfq day rows", "tencent");
  return {
    provider: "tencent",
    requestUrl: pages[0].requestUrl,
    raw: { pagination: { requestedDays: days, pageSize: TENCENT_PAGE_SIZE }, pages },
    bars,
  };
}
