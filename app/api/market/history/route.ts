import { ensureMarketSchema, getLatestDataset } from "@/lib/market/persistence";
import { normalizeSymbol } from "@/lib/market/symbols";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const symbol = normalizeSymbol(url.searchParams.get("symbol")).symbol;
    const rawLimit = url.searchParams.get("limit") ?? "240";
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 2000) throw new Error("limit must be an integer from 1 to 2000");
    await ensureMarketSchema();
    const dataset = await getLatestDataset(symbol, limit);
    if (!dataset) return Response.json({ code: "DATASET_NOT_FOUND", error: "No verified local dataset. Call POST /api/market/sync first." }, { status: 404 });
    return Response.json({ ...dataset, cached: true, stale: false, asOf: dataset.bars.at(-1)?.date ?? dataset.dataset.createdAt, limitations: ["qfq (forward-adjusted) daily bars only; providers are non-official web endpoints.", "Tencent may return its daily series when qfqday is unavailable; every published date is still cross-validated against Eastmoney."] });
  } catch (error) {
    return Response.json({ code: "INVALID_REQUEST", error: error instanceof Error ? error.message : "invalid request" }, { status: 400 });
  }
}
