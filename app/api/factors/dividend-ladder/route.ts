import { getDividendLadderFactors } from "@/lib/factors/dividendLadderFactors";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const factors = await getDividendLadderFactors();
    return Response.json(factors, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json(
      {
        code: "FACTOR_DATA_UNAVAILABLE",
        error: error instanceof Error ? error.message : "unknown factor data failure",
        limitations: ["因子不可用时，实时策略只能降级为最多 25% 的价格与连续时间确认。"],
      },
      { status: 502 },
    );
  }
}
