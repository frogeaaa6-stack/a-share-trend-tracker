import * as XLSX from "xlsx";

export type FactorPoint = { date: string; value: number };

export { getDividendLadderFactorHistory, type DividendLadderFactorHistory } from "./dividendLadderFactorHistory";

export type DividendLadderFactorSnapshot = {
  asOf: string;
  indexCode: "H30269";
  dividend: {
    value: number;
    date: string;
    source: string;
    status: "official";
    historyCount: number;
  };
  rate: {
    value: number;
    date: string;
    source: string;
    secondaryValue: number | null;
    secondaryDate: string | null;
    differenceBps: number | null;
    verified: boolean;
  };
  spread: {
    value: number;
    cap: number;
  };
  limitations: string[];
};

const CSI_URL = "https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/autofile/indicator/H30269indicator.xls";
const CHINABOND_BASE = "https://yield.chinabond.com.cn/cbweb-pbc-web/pbc/historyQuery";
const SINA_URL = "https://bond.finance.sina.com.cn/hq/gb/daily?symbol=CN10YT";

function canonicalDate(value: unknown) {
  const raw = String(value ?? "").trim().replaceAll("-", "").replaceAll("/", "");
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function finite(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stripHtml(value: string) {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseCsiDividendWorkbook(input: ArrayBuffer): FactorPoint[] {
  const workbook = XLSX.read(input, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false });
  return rows
    .slice(1)
    .map((row) => {
      const date = canonicalDate(row[0]);
      const percent = finite(row[9]);
      return date && percent !== null && percent > 0 && percent < 20 ? { date, value: Number((percent / 100).toFixed(8)) } : null;
    })
    .filter((point): point is FactorPoint => point !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function parseChinaBondHistory(html: string): FactorPoint[] {
  const points: FactorPoint[] = [];
  for (const row of html.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => stripHtml(match[1]));
    const date = canonicalDate(cells[1]);
    const percent = finite(cells[8]);
    if (date && percent !== null && percent > 0 && percent < 20) points.push({ date, value: Number((percent / 100).toFixed(8)) });
  }
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

export function parseSinaHistory(input: unknown): FactorPoint[] {
  const rows = Array.isArray(input)
    ? input
    : input && typeof input === "object"
      ? ((input as { result?: { data?: unknown } }).result?.data)
      : null;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const date = canonicalDate(row.d);
      const percent = finite(row.c);
      return date && percent !== null && percent > 0 && percent < 20 ? { date, value: Number((percent / 100).toFixed(8)) } : null;
    })
    .filter((point): point is FactorPoint => point !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function dividendSpreadCap(spread: number | null) {
  if (spread === null || !Number.isFinite(spread)) return .25;
  return spread < .015 ? .25 : spread < .025 ? .5 : spread < .03 ? .75 : 1;
}

function dateRange(daysBack = 45) {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - daysBack);
  const format = (date: Date) => date.toISOString().slice(0, 10);
  return { start: format(start), end: format(end) };
}

async function fetchCsiDividend() {
  const response = await fetch(CSI_URL, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`中证指数股息率接口返回 ${response.status}`);
  const history = parseCsiDividendWorkbook(await response.arrayBuffer());
  const latest = history.at(-1);
  if (!latest) throw new Error("中证指数股息率文件中没有可用的 D/P2");
  return { latest, history };
}

async function fetchChinaBondRate() {
  const range = dateRange();
  const url = new URL(CHINABOND_BASE);
  url.searchParams.set("startDate", range.start);
  url.searchParams.set("endDate", range.end);
  url.searchParams.set("gjqx", "10");
  url.searchParams.set("qxId", "hzsylqx");
  url.searchParams.set("locale", "cn_ZH");
  const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`中债十年期收益率接口返回 ${response.status}`);
  const history = parseChinaBondHistory(await response.text());
  const latest = history.at(-1);
  if (!latest) throw new Error("中债收益率曲线中没有可用的十年期数据");
  return { latest, history };
}

async function fetchSinaRate() {
  const response = await fetch(SINA_URL, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!response.ok) return null;
  const history = parseSinaHistory(await response.json());
  return history.at(-1) ?? null;
}

let cache: { expiresAt: number; value: DividendLadderFactorSnapshot } | null = null;

export async function getDividendLadderFactors(): Promise<DividendLadderFactorSnapshot> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  const [dividend, primaryRate, secondaryResult] = await Promise.all([
    fetchCsiDividend(),
    fetchChinaBondRate(),
    fetchSinaRate().catch(() => null),
  ]);
  const sameDaySecondary = secondaryResult?.date === primaryRate.latest.date ? secondaryResult : null;
  const differenceBps = sameDaySecondary
    ? Math.abs(primaryRate.latest.value - sameDaySecondary.value) * 10_000
    : null;
  const spread = dividend.latest.value - primaryRate.latest.value;
  const value: DividendLadderFactorSnapshot = {
    asOf: [dividend.latest.date, primaryRate.latest.date].sort()[0],
    indexCode: "H30269",
    dividend: {
      value: dividend.latest.value,
      date: dividend.latest.date,
      source: CSI_URL,
      status: "official",
      historyCount: dividend.history.length,
    },
    rate: {
      value: primaryRate.latest.value,
      date: primaryRate.latest.date,
      source: `${CHINABOND_BASE}?gjqx=10&qxId=hzsylqx`,
      secondaryValue: sameDaySecondary?.value ?? null,
      secondaryDate: sameDaySecondary?.date ?? secondaryResult?.date ?? null,
      differenceBps,
      verified: differenceBps !== null && differenceBps <= 5,
    },
    spread: { value: spread, cap: dividendSpreadCap(spread) },
    limitations: [
      `中证指数公开估值文件当前仅含最近 ${dividend.history.length} 个交易日，不能据此构造完整历史股息率回测。`,
      "当前股息利差仅作为新增仓位上限；不会单独触发卖出，也不会把当前值倒填到历史。",
      "十年期国债收益率以中债官方曲线为主，新浪 CN10YT 仅用于同日交叉核验。",
    ],
  };
  cache = { expiresAt: Date.now() + 6 * 60 * 60 * 1000, value };
  return value;
}
