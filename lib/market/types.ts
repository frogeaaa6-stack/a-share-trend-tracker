export const ADJUSTMENT = "qfq" as const;
export type Adjustment = typeof ADJUSTMENT;
export type ProviderName = "eastmoney" | "tencent";

export type MarketBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount?: number;
};

export type MarketIssue = {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  date?: string;
  details?: Record<string, unknown>;
};

export type SourceStatus = {
  provider: ProviderName;
  status: "ok" | "error";
  barCount: number;
  message?: string;
  attempts?: number;
  code?: string;
  kind?: string;
  httpStatus?: number;
  retryable?: boolean;
  requestUrl?: string;
  cause?: string;
};

export type Quality = {
  score: number;
  grade: "A" | "B" | "C" | "D";
  coverage: number;
  overlapDays: number;
  matchedDays: number;
  conflictDays: number;
  agreementPct: number;
  maxPriceDiffBps: number;
};

export type ValidationResult = {
  verified: boolean;
  bars: MarketBar[];
  quality: Quality;
  issues: MarketIssue[];
};

export type ProviderResponse = {
  provider: ProviderName;
  requestUrl: string;
  raw: unknown;
  bars: MarketBar[];
  attempts: number;
};

export type NormalizedSymbol = {
  symbol: string;
  code: string;
  exchange: "SH" | "SZ";
  eastmoneySecid: string;
  tencentSymbol: string;
};
