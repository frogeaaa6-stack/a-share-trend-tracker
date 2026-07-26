import {
  calculateDividendAccount,
  DIVIDEND_STRATEGY_CAPITAL,
  DIVIDEND_STRATEGY_KEY,
  type DividendAccountTrade,
} from "@/lib/strategy/dividendAccount";
import {
  getDividendAccountSnapshot,
  insertDividendAccountTrade,
} from "@/lib/strategy/dividendAccountPersistence";

export const dynamic = "force-dynamic";

class AccountRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function localRequest(request: Request) {
  return new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(new URL(request.url).hostname);
}

function trustedLocalJsonRequest(request: Request) {
  if (!localRequest(request) || !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(request.url);
    return localRequest(new Request(originUrl))
      && originUrl.port === requestUrl.port;
  } catch {
    return false;
  }
}

function shanghaiCalendarDate() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizeTrade(body: Record<string, unknown>): DividendAccountTrade {
  if (typeof body.idempotencyKey !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.idempotencyKey)) {
    throw new Error("本次提交缺少有效的幂等编号");
  }
  if (!validDate(body.tradeDate)) throw new Error("请选择有效的成交日期");
  if (body.tradeDate > shanghaiCalendarDate()) throw new Error("不能记录未来日期的成交或分红");
  const weekday = new Date(`${body.tradeDate}T00:00:00Z`).getUTCDay();
  if (body.side !== "buy" && body.side !== "sell" && body.side !== "dividend") throw new Error("记录类型只能是买入、卖出或现金分红");
  if (body.side !== "dividend" && (weekday === 0 || weekday === 6)) throw new Error("买卖成交日期不能是周末");
  const note = typeof body.note === "string" ? body.note.replace(/\s+/g, " ").trim() : "";
  if (note.length > 200) throw new Error("备注最多 200 个字符");
  if (body.side === "dividend") {
    const amount = Number(body.amount ?? body.price);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) throw new Error("现金分红金额必须是有效的正数");
    return {
      id: body.idempotencyKey,
      tradeDate: body.tradeDate,
      side: "dividend",
      price: 0,
      units: 0,
      amount,
      fee: 0,
      note,
      createdAt: new Date().toISOString(),
    };
  }
  const price = Number(body.price);
  const units = Number(body.units);
  const fee = body.fee === undefined || body.fee === "" ? 0 : Number(body.fee);
  if (!Number.isFinite(price) || price <= 0 || price > 10_000) throw new Error("成交价格必须是有效的正数");
  if (!Number.isInteger(units) || units <= 0 || units > 10_000_000) throw new Error("成交份额必须是正整数");
  if (!Number.isFinite(fee) || fee < 0 || fee > 10_000) throw new Error("交易费用必须是有效的非负数");
  return {
    id: body.idempotencyKey,
    tradeDate: body.tradeDate,
    side: body.side,
    price,
    units,
    amount: null,
    fee,
    note,
    createdAt: new Date().toISOString(),
  };
}

function sameTrade(left: DividendAccountTrade, right: DividendAccountTrade) {
  return left.id === right.id
    && left.tradeDate === right.tradeDate
    && left.side === right.side
    && left.price === right.price
    && left.units === right.units
    && left.amount === right.amount
    && left.fee === right.fee
    && left.note === right.note;
}

function payload(trades: DividendAccountTrade[], ledgerVersion: number) {
  return {
    strategyKey: DIVIDEND_STRATEGY_KEY,
    symbol: "512890.SH",
    fundName: "华泰柏瑞中证红利低波动交易型开放式指数证券投资基金",
    capital: DIVIDEND_STRATEGY_CAPITAL,
    ledgerVersion,
    trackingStatus: trades.length ? "active" : "awaiting-first-trade",
    summary: calculateDividendAccount(trades),
    trades: [...trades].reverse(),
    accounting: "移动加权平均成本；费用计入买入成本并从卖出收益扣除",
  };
}

export async function GET(request: Request) {
  if (!localRequest(request)) return Response.json({ code: "LOCAL_ONLY", error: "实盘账本只允许从本机访问" }, { status: 403 });
  try {
    const { trades, metadata } = await getDividendAccountSnapshot();
    return Response.json(payload(trades, metadata.ledgerVersion), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json(
      { code: "DIVIDEND_ACCOUNT_UNAVAILABLE", error: error instanceof Error ? error.message : "实盘账本暂不可用" },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  if (!trustedLocalJsonRequest(request)) {
    return Response.json({ code: "LOCAL_JSON_ONLY", error: "实盘账本只允许本机页面发起 JSON 写入" }, { status: 403 });
  }
  try {
    const body = await request.json() as Record<string, unknown>;
    const expectedLedgerVersion = Number(body.expectedLedgerVersion);
    if (!Number.isInteger(expectedLedgerVersion) || expectedLedgerVersion < 0) throw new Error("账本版本无效，请刷新页面后重试");
    const trade = normalizeTrade(body);
    const { trades: existing, metadata } = await getDividendAccountSnapshot();
    const duplicate = existing.find((entry) => entry.id === trade.id);
    if (duplicate) {
      if (!sameTrade(duplicate, trade)) throw new AccountRequestError("相同幂等编号对应了不同内容", "IDEMPOTENCY_CONFLICT", 409);
      return Response.json({ ...payload(existing, metadata.ledgerVersion), idempotentReplay: true });
    }
    if (expectedLedgerVersion !== metadata.ledgerVersion) {
      throw new AccountRequestError("账本已被另一笔操作更新，请刷新后重试", "ACCOUNT_CHANGED", 409);
    }
    calculateDividendAccount([...existing, trade]);
    const inserted = await insertDividendAccountTrade(trade, expectedLedgerVersion);
    if (!inserted) {
      const { trades: latest, metadata: latestMetadata } = await getDividendAccountSnapshot();
      const replay = latest.find((entry) => entry.id === trade.id);
      if (replay && sameTrade(replay, trade)) {
        return Response.json({ ...payload(latest, latestMetadata.ledgerVersion), idempotentReplay: true });
      }
      throw new AccountRequestError("账本刚刚发生变化，请刷新后重试", "ACCOUNT_CHANGED", 409);
    }
    return Response.json(payload([...existing, trade], expectedLedgerVersion + 1), { status: 201 });
  } catch (error) {
    const known = error instanceof AccountRequestError ? error : null;
    return Response.json(
      { code: known?.code ?? "INVALID_DIVIDEND_TRADE", error: error instanceof Error ? error.message : "无法记录这笔成交" },
      { status: known?.status ?? 400 },
    );
  }
}
