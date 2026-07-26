import type { MarketBar, MarketIssue, ProviderResponse, Quality, ValidationResult } from "./types";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WARNING_DIFF = 0.0015; // 15 bps
const CRITICAL_DIFF = 0.005; // 50 bps

function validBar(bar: MarketBar): string | undefined {
  const parsedDate = new Date(`${bar.date}T00:00:00.000Z`);
  if (!DATE.test(bar.date) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== bar.date) return "invalid or nonexistent trading date";
  for (const field of ["open", "high", "low", "close", "volume"] as const) {
    if (!Number.isFinite(bar[field]) || bar[field] < 0) return `invalid ${field}`;
  }
  if (bar.open <= 0 || bar.high <= 0 || bar.low <= 0 || bar.close <= 0) return "price must be positive";
  if (bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close) || bar.high < bar.low) return "inconsistent OHLC";
  if (bar.amount !== undefined && (!Number.isFinite(bar.amount) || bar.amount < 0)) return "invalid amount";
  return undefined;
}

export function sanitizeBars(bars: MarketBar[], provider: string): { bars: MarketBar[]; issues: MarketIssue[] } {
  const seen = new Set<string>();
  const issues: MarketIssue[] = [];
  const clean: MarketBar[] = [];
  for (const bar of bars) {
    const reason = validBar(bar);
    if (reason) {
      issues.push({ code: "INVALID_BAR", severity: "warning", date: bar.date, message: `${provider}: ${reason}` });
    } else if (seen.has(bar.date)) {
      issues.push({ code: "DUPLICATE_DATE", severity: "warning", date: bar.date, message: `${provider}: duplicate trading date isolated` });
    } else {
      seen.add(bar.date);
      clean.push(bar);
    }
  }
  return { bars: clean.sort((a, b) => a.date.localeCompare(b.date)), issues };
}

function relativeDifference(a: number, b: number) {
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 0.000001);
}

function priceDifference(primary: MarketBar, secondary: MarketBar) {
  return Math.max(...[primary.open, primary.high, primary.low, primary.close].map((value, index) =>
    relativeDifference(value, [secondary.open, secondary.high, secondary.low, secondary.close][index]),
  ));
}

function grade(score: number): Quality["grade"] {
  if (score >= 95) return "A";
  if (score >= 85) return "B";
  if (score >= 70) return "C";
  return "D";
}

/** Cross-checks matching dates and never publishes an OHLC-conflicting day. */
export function crossValidate(primaryResponse: ProviderResponse, secondaryResponse: ProviderResponse): ValidationResult {
  const primary = sanitizeBars(primaryResponse.bars, primaryResponse.provider);
  const secondary = sanitizeBars(secondaryResponse.bars, secondaryResponse.provider);
  const issues = [...primary.issues, ...secondary.issues];
  const secondaryByDate = new Map(secondary.bars.map((bar) => [bar.date, bar]));
  const bars: MarketBar[] = [];
  let overlapping = 0;
  let conflicts = 0;
  let maxPriceDiff = 0;

  for (const bar of primary.bars) {
    const comparison = secondaryByDate.get(bar.date);
    if (!comparison) continue;
    overlapping += 1;
    const difference = priceDifference(bar, comparison);
    maxPriceDiff = Math.max(maxPriceDiff, difference);
    if (difference > CRITICAL_DIFF) {
      conflicts += 1;
      issues.push({
        code: "OHLC_CONFLICT",
        severity: "warning",
        date: bar.date,
        message: "Critical source OHLC disagreement (>50 bps); date excluded from verified dataset",
        details: { eastmoney: bar, tencent: comparison, maxPriceDiffBps: Math.round(difference * 10000 * 100) / 100 },
      });
    } else {
      bars.push(bar);
      if (difference > WARNING_DIFF) {
        issues.push({
          code: "OHLC_WARNING",
          severity: "warning",
          date: bar.date,
          message: "Source OHLC differs by more than 15 bps but not more than 50 bps",
          details: { maxPriceDiffBps: Math.round(difference * 10000 * 100) / 100 },
        });
      }
    }
  }

  const expected = Math.max(primary.bars.length, secondary.bars.length, 1);
  const coverage = Math.round((overlapping / expected) * 1000) / 10;
  const agreement = overlapping ? bars.length / overlapping : 0;
  const agreementPct = Math.round(agreement * 10000) / 100;
  const maxPriceDiffBps = Math.round(maxPriceDiff * 10000 * 100) / 100;
  const score = Math.round(Math.min(100, coverage * 0.45 + agreement * 55));
  const quality: Quality = { score, grade: grade(score), coverage, overlapDays: overlapping, matchedDays: bars.length, conflictDays: conflicts, agreementPct, maxPriceDiffBps };
  const verified = bars.length >= 30 && coverage >= 95 && agreement >= 0.98 && conflicts === 0 && score >= 85;
  if (!verified) issues.push({ code: "INSUFFICIENT_CROSS_VALIDATION", severity: "error", message: "Dataset was not published: coverage, agreement, sample size, or critical-conflict checks did not pass" });
  return { verified, bars, quality, issues };
}
