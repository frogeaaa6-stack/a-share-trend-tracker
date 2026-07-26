import { crossValidate } from "@/lib/market/validation";
import { fetchEastmoney, fetchTencent } from "@/lib/market/providers";
import { normalizeDays, normalizeSymbol } from "@/lib/market/symbols";
import { createRun, ensureMarketSchema, finishRun, getLatestDataset, isFresh, publishDataset, saveIssues, saveSnapshot } from "@/lib/market/persistence";
import { canServeCompleteOnly, shanghaiCalendarDate } from "@/lib/market/completedDailyBars";
import type { MarketIssue, SourceStatus } from "@/lib/market/types";

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

function unavailable(error: string) {
  return Response.json({ code: "MARKET_DATA_UNAVAILABLE", error, adjustment: "qfq", limitations: ["Both non-official web data sources failed and no verified local version exists."] }, { status: 502 });
}

const LIMITATIONS = [
  "qfq (forward-adjusted) daily bars only; providers are non-official web endpoints.",
  "Tencent may return its daily series when qfqday is unavailable; every published date is still cross-validated against Eastmoney.",
];

export async function POST(request: Request) {
  if (!trustedLocalJsonRequest(request)) {
    return Response.json({ code: "LOCAL_JSON_ONLY", error: "行情同步只允许本机页面或本机调度器发起 JSON 请求" }, { status: 403 });
  }
  let symbol: string;
  let days: number;
  let completeOnly: boolean;
  try {
    const payload = await request.json() as { symbol?: unknown; days?: unknown; completeOnly?: unknown };
    symbol = normalizeSymbol(payload.symbol).symbol;
    days = normalizeDays(payload.days);
    if (payload.completeOnly !== undefined && typeof payload.completeOnly !== "boolean") throw new Error("completeOnly must be a boolean");
    completeOnly = payload.completeOnly === true;
  } catch (error) {
    return Response.json({ code: "INVALID_REQUEST", error: message(error) }, { status: 400 });
  }
  const excludedDate = completeOnly ? shanghaiCalendarDate() : null;

  try {
    await ensureMarketSchema();
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
        sources.push({ provider, status: "ok", barCount: completed?.bars.length ?? 0 });
        await saveSnapshot(runId, { provider, requestUrl: result.value.requestUrl, raw: result.value.raw });
      } else {
        const error = message(result.reason);
        sources.push({ provider, status: "error", barCount: 0, message: error });
        await saveSnapshot(runId, { provider, requestUrl: "not-recorded: request failed before response", error });
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
    const fallback = await getLatestDataset(symbol, days);
    if (fallback && canServeCompleteOnly(fallback.bars.at(-1)?.date, excludedDate)) {
      return Response.json({
        ...fallback,
        cached: true,
        stale: true,
        asOf: fallback.bars.at(-1)?.date ?? fallback.dataset.createdAt,
        completeOnly,
        excludedDate,
        limitations: ["Serving the last verified local dataset because a new dual-source validation did not pass.", ...LIMITATIONS],
      });
    }
    if (fallback && completeOnly) return unavailable("The last verified cache contains the current Shanghai session, so no complete T-1 fallback can be served.");
    return unavailable("No new dual-source-verified dataset could be published.");
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
