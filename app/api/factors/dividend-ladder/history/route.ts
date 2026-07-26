import { getDividendLadderFactorHistory } from "@/lib/factors/dividendLadderFactorHistory";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const history = await getDividendLadderFactorHistory();
    return Response.json(history, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json(
      {
        code: "FACTOR_HISTORY_UNAVAILABLE",
        error: error instanceof Error ? error.message : "unknown factor history failure",
        limitations: ["无法取得官方 D/P2 文件时，不生成股息—国债利差历史或联合低估结论。"],
      },
      { status: 502 },
    );
  }
}
