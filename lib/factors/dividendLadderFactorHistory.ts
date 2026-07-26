import {
  parseChinaBondHistory,
  parseCsiDividendWorkbook,
  type FactorPoint,
} from "./dividendLadderFactors";

const CSI_URL = "https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/autofile/indicator/H30269indicator.xls";
const CHINABOND_BASE = "https://yield.chinabond.com.cn/cbweb-pbc-web/pbc/historyQuery";

export type DividendLadderFactorHistory = {
  indexCode: "H30269";
  status: "success" | "partial";
  historyStart: string | null;
  historyEnd: string | null;
  dividend: FactorPoint[];
  rate: FactorPoint[];
  spread: Array<{ date: string; value: number | null }>;
  coverage: {
    dividendObservations: number;
    rateObservations: number;
    sameDaySpreadObservations: number;
    dividendStart: string | null;
    dividendEnd: string | null;
    rateStart: string | null;
    rateEnd: string | null;
  };
  limitations: string[];
};

function factorDateRange(points: FactorPoint[]) {
  return { start: points[0]?.date ?? null, end: points.at(-1)?.date ?? null };
}

/**
 * Joins only identical calendar dates.  In particular, a neighbouring bond
 * observation must never be treated as the rate for a D/P2 publication date.
 */
export function assembleDividendLadderFactorHistory(
  dividend: FactorPoint[],
  rate: FactorPoint[],
): DividendLadderFactorHistory {
  const orderedDividend = [...dividend].sort((left, right) => left.date.localeCompare(right.date));
  const orderedRate = [...rate].sort((left, right) => left.date.localeCompare(right.date));
  const rateByDate = new Map(orderedRate.map((point) => [point.date, point.value]));
  const spread = orderedDividend.map((point) => {
    const matchedRate = rateByDate.get(point.date);
    return { date: point.date, value: matchedRate === undefined ? null : Number((point.value - matchedRate).toFixed(8)) };
  });
  const dividendRange = factorDateRange(orderedDividend);
  const rateRange = factorDateRange(orderedRate);
  const historyStart = [dividendRange.start, rateRange.start].filter((date): date is string => Boolean(date)).sort()[0] ?? null;
  const historyEnd = [dividendRange.end, rateRange.end].filter((date): date is string => Boolean(date)).sort().at(-1) ?? null;
  const sameDaySpreadObservations = spread.filter((point) => point.value !== null).length;

  return {
    indexCode: "H30269",
    status: orderedDividend.length && orderedRate.length ? "success" : "partial",
    historyStart,
    historyEnd,
    dividend: orderedDividend,
    rate: orderedRate,
    spread,
    coverage: {
      dividendObservations: orderedDividend.length,
      rateObservations: orderedRate.length,
      sameDaySpreadObservations,
      dividendStart: dividendRange.start,
      dividendEnd: dividendRange.end,
      rateStart: rateRange.start,
      rateEnd: rateRange.end,
    },
    limitations: [
      `H30269 官方 D/P2 公开文件只提供当前可取得的 ${orderedDividend.length} 个交易日观测；2019 至今的股息率历史缺失。`,
      "股息—国债利差仅按同一日期精确匹配；D/P2 当日没有中债观测时 spread 为 null，绝不以相邻日期或当前值补齐。",
      "十年期国债收益率来自中债官方曲线；本接口只请求覆盖官方 D/P2 日期范围的窗口。",
      ...(orderedRate.length ? [] : ["本次未取得中债窗口观测，所有 spread 均为 null；不会用其他来源或旧值替代。"]),
      "该短历史只用于位置与数据完整性展示，不能构造长期股息率回测或联合低估结论。",
    ],
  };
}

async function fetchOfficialDividendHistory() {
  const response = await fetch(CSI_URL, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`中证指数股息率接口返回 ${response.status}`);
  const points = parseCsiDividendWorkbook(await response.arrayBuffer());
  if (!points.length) throw new Error("中证指数股息率文件中没有可用的 D/P2");
  return points;
}

async function fetchChinaBondWindow(start: string, end: string) {
  const url = new URL(CHINABOND_BASE);
  url.searchParams.set("startDate", start);
  url.searchParams.set("endDate", end);
  url.searchParams.set("gjqx", "10");
  url.searchParams.set("qxId", "hzsylqx");
  url.searchParams.set("locale", "cn_ZH");
  const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`中债十年期收益率接口返回 ${response.status}`);
  return parseChinaBondHistory(await response.text());
}

let cache: { expiresAt: number; value: DividendLadderFactorHistory } | null = null;

export async function getDividendLadderFactorHistory(): Promise<DividendLadderFactorHistory> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  const dividend = await fetchOfficialDividendHistory();
  const { start, end } = factorDateRange(dividend);
  let rate: FactorPoint[] = [];
  if (start && end) {
    try {
      rate = await fetchChinaBondWindow(start, end);
    } catch {
      // The official D/P2 observations remain useful evidence; every spread is
      // then explicitly null rather than fabricated from an unavailable rate.
      rate = [];
    }
  }
  const value = assembleDividendLadderFactorHistory(dividend, rate);
  cache = { expiresAt: Date.now() + 6 * 60 * 60 * 1000, value };
  return value;
}
