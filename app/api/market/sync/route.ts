import { crossValidate } from "@/lib/market/validation";
import { fetchEastmoney, fetchTencent, ProviderError } from "@/lib/market/providers";
import { normalizeDays, normalizeSymbol } from "@/lib/market/symbols";
import { createRun, ensureMarketSchema, finishRun, getLatestDataset, isFresh, publishDataset, saveIssues, saveSnapshot } from "@/lib/market/persistence";
import { getLatestVerifiedNoonSnapshot, publishNoonSnapshot } from "@/lib/market/persistence";
import { fetchEastmoneyNoon, fetchTencentNoon, validateNoonSnapshots } from "@/lib/market/noonSnapshot";
import { canServeCompleteOnly, shanghaiCalendarDate } from "@/lib/market/completedDailyBars";
import type { MarketIssue, SourceStatus } from "@/lib/market/types";
import { deliverFeishuMarketDataFailureAlert } from "@/lib/notifications/marketDataFailure";
import { shouldAlertOnSourceFailure } from "@/lib/market/syncPolicy";

export const dynamic = "force-dynamic";

function message(error: unknown) { return error instanceof Error ? error.message : "unknown upstream failure"; }
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function trustedLocalJsonRequest(request: Request) {
  const requestUrl = new URL(request.url);
  if (!LOCAL_HOSTS.has(requestUrl.hostname) || !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    return LOCAL_HOSTS.has(originUrl.hostname) && originUrl.port === requestUrl.port;
  } catch {
    return false;
  }
}

function unavailable(error: string, refresh?: Record<string, unknown>) {
  return Response.json({ code: "MARKET_DATA_UNAVAILABLE", error, adjustment: "qfq", refresh, limitations: ["Both non-official web data sources failed and no verified local version exists."] }, { status: 502 });
}

function sourceError(error: unknown, provider: SourceStatus["provider"]): SourceStatus {
  const fallback = error instanceof Error ? error.message : "unknown upstream failure";
  if (!(error instanceof ProviderError)) return { provider, status: "error", barCount: 0, message: fallback, attempts: 1, code: "UNKNOWN_UPSTREAM_ERROR", kind: "network", retryable: false };
  return {
    provider,
    status: "error",
    barCount: 0,
    message: error.message,
    attempts: error.attempts,
    code: error.code,
    kind: error.kind,
    httpStatus: error.status,
    retryable: error.retryable,
    requestUrl: error.requestUrl,
    cause: error.causeSummary,
  };
}

function sourceSnapshotError(source: SourceStatus) {
  return JSON.stringify({ message: source.message, attempts: source.attempts, code: source.code, kind: source.kind, httpStatus: source.httpStatus, retryable: source.retryable, cause: source.cause });
}

const LIMITATIONS = [
  "qfq (forward-adjusted) daily bars only; providers are non-official web endpoints.",
  "Tencent may return its daily series when qfqday is unavailable; every published date is still cross-validated against Eastmoney.",
];

async function syncScheduledNoon(symbol: string, days: number, notifyOnSourceFailure: boolean) {
  const today = shanghaiCalendarDate();
  const baseline = await getLatestDataset(symbol, days);
  // A noon point is never allowed to repair or replace daily history: schedule only
  // proceeds from a fresh, verified T-1 baseline.
  if (!baseline || !isFresh(baseline) || !canServeCompleteOnly(baseline.bars.at(-1)?.date, today)) {
    return unavailable("午盘快照前必须存在新鲜、已验证且截至 T-1 的完整日线基线。");
  }
  const existing = await getLatestVerifiedNoonSnapshot(symbol, today);
  if (existing) return Response.json({ strategyReady: true, marketMode: "scheduled_noon", signalDate: today, snapshotTime: "11:30", baseAsOf: baseline.bars.at(-1)?.date, snapshot: existing, dataset: baseline.dataset, cached: true });
  const runId = await createRun(symbol);
  const results = await Promise.allSettled([fetchEastmoneyNoon(symbol, today), fetchTencentNoon(symbol, today)]);
  const names = ["eastmoney", "tencent"] as const;
  const sources: SourceStatus[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const provider = names[index];
    if (result.status === "fulfilled") {
      sources.push({ provider, status: "ok", barCount: 1, attempts: result.value.attempts, requestUrl: result.value.requestUrl });
      await saveSnapshot(runId, { provider, requestUrl: result.value.requestUrl, raw: result.value.raw });
    } else {
      const source = sourceError(result.reason, provider);
      sources.push(source);
      await saveSnapshot(runId, { provider, requestUrl: source.requestUrl ?? "not-recorded: request failed before response", raw: { failure: source }, error: sourceSnapshotError(source) });
    }
  }
  const fulfilled = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof fetchEastmoneyNoon>>> => result.status === "fulfilled");
  let validation;
  if (fulfilled.length === 2) {
    validation = validateNoonSnapshots(fulfilled[0].value, fulfilled[1].value, today);
    await saveIssues(runId, validation.issues);
    if (validation.verified) {
      const snapshot = await publishNoonSnapshot(runId, symbol, validation);
      await finishRun(runId, "published");
      return Response.json({ strategyReady: true, marketMode: "scheduled_noon", signalDate: today, snapshotTime: "11:30", baseAsOf: baseline.bars.at(-1)?.date, snapshot, dataset: baseline.dataset, cached: false });
    }
  } else {
    await saveIssues(runId, [{ code: "NOON_SOURCE_UNAVAILABLE", severity: "error", message: "A verified noon snapshot requires both independent minute sources." }]);
  }
  await finishRun(runId, "failed");
  const rejected = sources.filter((source) => source.status === "error");
  let alertDelivery: unknown;
  if (notifyOnSourceFailure) {
    try {
      alertDelivery = await deliverFeishuMarketDataFailureAlert({ symbol, shanghaiDate: today, runId, failedSources: rejected.length ? rejected.map((source) => ({ provider: source.provider, message: source.message ?? "upstream failure", attempts: source.attempts, code: source.code, cause: source.cause })) : [{ provider: "cross-validation", message: validation?.issues.map((issue) => issue.message).join("; ") ?? "Noon validation failed" }], successfulSources: sources.filter((source) => source.status === "ok").map((source) => source.provider), lastVerified: { version: baseline.dataset.version, asOf: baseline.bars.at(-1)?.date ?? baseline.dataset.createdAt } });
    } catch (error) { alertDelivery = { sent: false, status: "failed", error: message(error) }; }
  }
  return Response.json({ code: "NOON_SNAPSHOT_UNAVAILABLE", error: "当天 11:30 午盘快照未能完成双源验证，正常策略卡已暂停。", strategyReady: false, marketMode: "scheduled_noon", signalDate: today, snapshotTime: "11:30", baseAsOf: baseline.bars.at(-1)?.date, runId, sources, alertDelivery }, { status: 502 });
}

export async function POST(request: Request) {
  if (!trustedLocalJsonRequest(request)) {
    return Response.json({ code: "LOCAL_JSON_ONLY", error: "行情同步只允许本机页面或本机调度器发起 JSON 请求" }, { status: 403 });
  }
  let symbol: string;
  let days: number;
  let completeOnly: boolean;
  let purpose: "scheduled" | undefined;
  let mode: "scheduled_noon" | undefined;
  let notifyOnSourceFailure = false;
  try {
    const payload = await request.json() as { symbol?: unknown; days?: unknown; completeOnly?: unknown; purpose?: unknown; mode?: unknown; notifyOnSourceFailure?: unknown };
    symbol = normalizeSymbol(payload.symbol).symbol;
    days = normalizeDays(payload.days);
    if (payload.completeOnly !== undefined && typeof payload.completeOnly !== "boolean") throw new Error("completeOnly must be a boolean");
    if (payload.purpose !== undefined && payload.purpose !== "scheduled") throw new Error("purpose only supports scheduled");
    if (payload.mode !== undefined && payload.mode !== "scheduled_noon") throw new Error("mode only supports scheduled_noon");
    if (payload.notifyOnSourceFailure !== undefined && typeof payload.notifyOnSourceFailure !== "boolean") throw new Error("notifyOnSourceFailure must be a boolean");
    completeOnly = payload.completeOnly === true;
    purpose = payload.purpose === "scheduled" ? "scheduled" : undefined;
    mode = payload.mode === "scheduled_noon" ? "scheduled_noon" : undefined;
    notifyOnSourceFailure = payload.notifyOnSourceFailure === true;
  } catch (error) {
    return Response.json({ code: "INVALID_REQUEST", error: message(error) }, { status: 400 });
  }
  const excludedDate = completeOnly ? shanghaiCalendarDate() : null;

  try {
    await ensureMarketSchema();
    if (mode === "scheduled_noon") {
      if (purpose !== "scheduled") return Response.json({ code: "INVALID_REQUEST", error: "scheduled_noon requires purpose: scheduled" }, { status: 400 });
      return syncScheduledNoon(symbol, days, notifyOnSourceFailure);
    }
    const cached = await getLatestDataset(symbol, days);
    // A requested lookback can predate the instrument's listing. Treat at
    // least 90% coverage as a complete fresh cache instead of refetching the
    // same inception-bounded history on every page load.
    if (
      cached
      && cached.bars.length >= Math.ceil(days * 0.9)
      && isFresh(cached)
      && (!excludedDate || (cached.bars.at(-1)?.date ?? "") < excludedDate)
    ) {
      return Response.json({ ...cached, cached: true, stale: false, asOf: cached.bars.at(-1)?.date ?? cached.dataset.createdAt, completeOnly, excludedDate, limitations: completeOnly ? ["Current Shanghai calendar date is excluded so noon scheduling uses completed daily bars only.", ...LIMITATIONS] : LIMITATIONS });
    }

    const runId = await createRun(symbol);
    const [eastmoney, tencent] = await Promise.allSettled([fetchEastmoney(symbol, days), fetchTencent(symbol, days)]);
    const completedEastmoney = eastmoney.status === "fulfilled"
      ? { ...eastmoney.value, bars: excludedDate ? eastmoney.value.bars.filter((bar) => bar.date < excludedDate) : eastmoney.value.bars }
      : null;
    const completedTencent = tencent.status === "fulfilled"
      ? { ...tencent.value, bars: excludedDate ? tencent.value.bars.filter((bar) => bar.date < excludedDate) : tencent.value.bars }
      : null;
    const sourceResults = [eastmoney, tencent];
    const sourceNames = ["eastmoney", "tencent"] as const;
    const sources: SourceStatus[] = [];
    for (let index = 0; index < sourceResults.length; index += 1) {
      const result = sourceResults[index];
      const provider = sourceNames[index];
      if (result.status === "fulfilled") {
        const completed = provider === "eastmoney" ? completedEastmoney : completedTencent;
        sources.push({ provider, status: "ok", barCount: completed?.bars.length ?? 0, attempts: result.value.attempts, requestUrl: result.value.requestUrl });
        await saveSnapshot(runId, { provider, requestUrl: result.value.requestUrl, raw: result.value.raw });
      } else {
        const source = sourceError(result.reason, provider);
        sources.push(source);
        await saveSnapshot(runId, { provider, requestUrl: source.requestUrl ?? "not-recorded: request failed before response", raw: { failure: source }, error: sourceSnapshotError(source) });
      }
    }

    if (completedEastmoney && completedTencent) {
      const validation = crossValidate(completedEastmoney, completedTencent);
      await saveIssues(runId, validation.issues);
      if (validation.verified) {
        const dataset = await publishDataset(runId, symbol, validation, sources);
        await finishRun(runId, "published");
        return Response.json({ ...dataset, cached: false, stale: false, asOf: dataset.bars.at(-1)?.date ?? dataset.dataset.createdAt, completeOnly, excludedDate, limitations: completeOnly ? ["Current Shanghai calendar date is excluded so noon scheduling uses completed daily bars only.", ...LIMITATIONS] : LIMITATIONS });
      }
    } else {
      const issues: MarketIssue[] = [{ code: "SOURCE_UNAVAILABLE", severity: "error", message: "A verified dataset requires both independent sources in this MVP." }];
      await saveIssues(runId, issues);
    }
    await finishRun(runId, "failed");
    const rejectedSources = sources.filter((source) => source.status === "error");
    const fallback = await getLatestDataset(symbol, days);
    let alertDelivery: unknown;
    if (shouldAlertOnSourceFailure({ completeOnly, purpose, notifyOnSourceFailure, rejectedSourceCount: rejectedSources.length })) {
      try {
        alertDelivery = await deliverFeishuMarketDataFailureAlert({
          symbol,
          shanghaiDate: excludedDate ?? shanghaiCalendarDate(),
          runId,
          failedSources: rejectedSources.map((source) => ({ provider: source.provider, message: source.message ?? "upstream failure", attempts: source.attempts, code: source.code, cause: source.cause })),
          successfulSources: sources.filter((source) => source.status === "ok").map((source) => source.provider),
          lastVerified: fallback ? { version: fallback.dataset.version, asOf: fallback.bars.at(-1)?.date ?? fallback.dataset.createdAt } : undefined,
        });
      } catch (error) {
        alertDelivery = { sent: false, status: "failed", error: message(error) };
      }
    }
    const refresh = rejectedSources.length ? { status: "failed", reason: "source_unavailable", runId, sources, alertDelivery } : undefined;
    if (fallback && canServeCompleteOnly(fallback.bars.at(-1)?.date, excludedDate)) {
      return Response.json({
        ...fallback,
        cached: true,
        stale: true,
        asOf: fallback.bars.at(-1)?.date ?? fallback.dataset.createdAt,
        completeOnly,
        excludedDate,
        refresh,
        limitations: ["Serving the last verified local dataset because a new dual-source validation did not pass.", ...LIMITATIONS],
      });
    }
    if (fallback && completeOnly) return unavailable("The last verified cache contains the current Shanghai session, so no complete T-1 fallback can be served.", refresh);
    return unavailable("No new dual-source-verified dataset could be published.", refresh);
  } catch (error) {
    try {
      const fallback = await getLatestDataset(symbol, days);
      if (fallback && canServeCompleteOnly(fallback.bars.at(-1)?.date, excludedDate)) {
        return Response.json({
          ...fallback,
          cached: true,
          stale: true,
          asOf: fallback.bars.at(-1)?.date ?? fallback.dataset.createdAt,
          completeOnly,
          excludedDate,
          limitations: ["Serving the last verified local dataset because the refresh failed.", ...LIMITATIONS],
        });
      }
      if (fallback && completeOnly) return unavailable("The last verified cache contains the current Shanghai session, so no complete T-1 fallback can be served.");
    } catch {
      // If storage itself is unavailable there is no safe local version to serve.
    }
    return unavailable(message(error));
  }
}
