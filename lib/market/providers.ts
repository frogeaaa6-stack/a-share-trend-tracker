import { normalizeSymbol } from "./symbols";
import type { MarketBar, NormalizedSymbol, ProviderName, ProviderResponse } from "./types";

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TENCENT_PAGE_SIZE = 640;
const RETRY_DELAYS_MS = [300, 900] as const;

type ErrorKind = "network" | "timeout" | "http" | "payload" | "response_size" | "parse";

export class ProviderError extends Error {
  readonly provider: ProviderName;
  readonly kind: ErrorKind;
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly attempts: number;
  readonly requestUrl?: string;
  readonly causeSummary?: string;

  constructor(message: string, provider: ProviderName, options: { kind?: ErrorKind; code?: string; status?: number; retryable?: boolean; attempts?: number; requestUrl?: string; causeSummary?: string } = {}) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.kind = options.kind ?? "parse";
    this.code = options.code ?? "PROVIDER_ERROR";
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.attempts = options.attempts ?? 1;
    this.requestUrl = options.requestUrl;
    this.causeSummary = options.causeSummary;
  }
}

export type ProviderRequestDependencies = { fetch?: typeof fetch; sleep?: (milliseconds: number) => Promise<void>; timeoutMs?: number };
const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function compactCause(error: unknown) {
  const sourceError = error as Error & { code?: unknown; cause?: unknown };
  const nested = sourceError?.cause as Error & { code?: unknown } | undefined;
  const source = error instanceof Error
    ? `${sourceError.code ?? sourceError.name}: ${sourceError.message}${nested ? ` | cause ${nested.code ?? nested.name}: ${nested.message}` : ""}`
    : String(error ?? "unknown error");
  return source.replace(/[\r\n\t]+/g, " ").replace(/https?:\/\/\S+/g, "[url]").replace(/\s+/g, " ").trim().slice(0, 240) || "unknown error";
}

function retryableStatus(status: number) { return [408, 425, 429, 500, 502, 503, 504].includes(status); }

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

async function requestOnce(url: string, provider: ProviderName, dependencies: ProviderRequestDependencies): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const response = await (dependencies.fetch ?? fetch)(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "market-data-mvp/1.0" },
    });
    if (!response.ok) throw new ProviderError(`upstream HTTP ${response.status}`, provider, { kind: "http", code: `HTTP_${response.status}`, status: response.status, retryable: retryableStatus(response.status), requestUrl: url });
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_RESPONSE_BYTES) throw new ProviderError("upstream response is too large", provider, { kind: "response_size", code: "RESPONSE_TOO_LARGE", requestUrl: url });
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new ProviderError("upstream response is too large", provider, { kind: "response_size", code: "RESPONSE_TOO_LARGE", requestUrl: url });
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new ProviderError("upstream returned invalid JSON", provider, { kind: "payload", code: "INVALID_JSON", retryable: true, requestUrl: url, causeSummary: compactCause(error) });
    }
  } finally {
    clearTimeout(timer);
  }
}

function withAttempt(error: unknown, provider: ProviderName, requestUrl: string, attempts: number) {
  if (error instanceof ProviderError) return new ProviderError(error.message, provider, { kind: error.kind, code: error.code, status: error.status, retryable: error.retryable, attempts, requestUrl, causeSummary: error.causeSummary });
  const timeout = error instanceof Error && error.name === "AbortError";
  return new ProviderError(timeout ? "upstream request timed out" : "upstream request failed", provider, { kind: timeout ? "timeout" : "network", code: timeout ? "REQUEST_TIMEOUT" : "NETWORK_ERROR", retryable: true, attempts, requestUrl, causeSummary: compactCause(error) });
}

export async function getJsonWithRetry<T>(url: string, provider: ProviderName, validate: (raw: unknown) => T, dependencies: ProviderRequestDependencies = {}): Promise<{ raw: unknown; value: T; attempts: number }> {
  let last: ProviderError | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const raw = await requestOnce(url, provider, dependencies);
      return { raw, value: validate(raw), attempts: attempt };
    } catch (error) {
      const providerError = withAttempt(error, provider, url, attempt);
      last = providerError;
      if (!providerError.retryable || attempt === 3) throw providerError;
      await (dependencies.sleep ?? defaultSleep)(RETRY_DELAYS_MS[attempt - 1]);
    }
  }
  throw last!;
}

function asRows(value: unknown): unknown[][] {
  return Array.isArray(value) ? value.filter(Array.isArray) : [];
}

export function parseEastmoney(raw: unknown): MarketBar[] {
  const rows = (raw as { data?: { klines?: unknown[] } })?.data?.klines;
  if (!Array.isArray(rows) || !rows.length) throw new ProviderError("upstream payload has no kline rows", "eastmoney", { kind: "payload", code: "MISSING_KLINE_ROWS", retryable: true });
  return rows.filter((row): row is string => typeof row === "string").map((row) => {
    const [date, open, close, high, low, volume, amount] = row.split(",");
    return { date, open: number(open), close: number(close), high: number(high), low: number(low), volume: number(volume), amount: number(amount) };
  });
}

export function parseTencent(raw: unknown, symbol: NormalizedSymbol): MarketBar[] {
  const parsed = parseTencentRows(raw, symbol);
  if (!parsed.length) throw new ProviderError("upstream payload has no qfq day rows", "tencent", { kind: "payload", code: "MISSING_QFQ_ROWS", retryable: true });
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
    throw new ProviderError("upstream qfq day row has an invalid date", "tencent", { kind: "parse", code: "INVALID_DATE" });
  }
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function buildTencentFqklineUrl(tencentSymbol: string, pageSize: number, endDate?: string): string {
  const params = new URLSearchParams({ param: `${tencentSymbol},day,,${endDate ?? ""},${pageSize},qfq` });
  return `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?${params}`;
}

export async function fetchEastmoney(symbolValue: string, days: number, dependencies: ProviderRequestDependencies = {}): Promise<ProviderResponse> {
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
  const result = await getJsonWithRetry(requestUrl, "eastmoney", parseEastmoney, dependencies);
  return { provider: "eastmoney", requestUrl, raw: result.raw, bars: result.value, attempts: result.attempts };
}

export async function fetchTencent(symbolValue: string, days: number, dependencies: ProviderRequestDependencies = {}): Promise<ProviderResponse> {
  const symbol = normalizeSymbol(symbolValue);
  const pages: Array<{ requestUrl: string; raw: unknown; attempts: number }> = [];
  const parsedPages: MarketBar[][] = [];
  let endDate: string | undefined;
  let attempts = 0;

  while (mergeTencentPages(parsedPages, days).length < days) {
    const remaining = days - mergeTencentPages(parsedPages, days).length;
    const requestUrl = buildTencentFqklineUrl(symbol.tencentSymbol, Math.min(remaining, TENCENT_PAGE_SIZE), endDate);
    const firstPage = pages.length === 0;
    const result = await getJsonWithRetry(requestUrl, "tencent", (raw) => {
      const page = parseTencentRows(raw, symbol);
      if (!page.length && firstPage) throw new ProviderError("upstream payload has no qfq day rows", "tencent", { kind: "payload", code: "MISSING_QFQ_ROWS", retryable: true });
      return page;
    }, dependencies);
    attempts += result.attempts;
    pages.push({ requestUrl, raw: result.raw, attempts: result.attempts });
    const page = result.value;
    if (!page.length) break; // Reached the listing start (or an empty historical page).

    const before = mergeTencentPages(parsedPages, days).length;
    parsedPages.push(page);
    const merged = mergeTencentPages(parsedPages, days);
    if (merged.length === before) break; // The upstream repeated a boundary page.

    const earliestDate = page.reduce((earliest, bar) => (bar.date < earliest ? bar.date : earliest), page[0].date);
    endDate = previousTencentPageEnd(earliestDate);
  }

  const bars = mergeTencentPages(parsedPages, days);
  if (!bars.length) throw new ProviderError("upstream payload has no qfq day rows", "tencent", { kind: "payload", code: "MISSING_QFQ_ROWS", retryable: true, attempts, requestUrl: pages[0]?.requestUrl });
  return {
    provider: "tencent",
    requestUrl: pages[0].requestUrl,
    raw: { pagination: { requestedDays: days, pageSize: TENCENT_PAGE_SIZE }, pages },
    bars,
    attempts,
  };
}
