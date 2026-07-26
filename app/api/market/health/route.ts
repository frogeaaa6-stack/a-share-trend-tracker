import { ensureMarketSchema } from "@/lib/market/persistence";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureMarketSchema();
    return Response.json({ status: "ok", database: "ready", sources: ["eastmoney", "tencent"], adjustment: "qfq" });
  } catch (error) {
    return Response.json({ status: "degraded", database: "unavailable", error: error instanceof Error ? error.message : "unknown error" }, { status: 503 });
  }
}
