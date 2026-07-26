export const DIVIDEND_STRATEGY_KEY = "512890-live-v1";
export const DIVIDEND_STRATEGY_CAPITAL = 50_000;

export type DividendAccountTrade = {
  id: string;
  tradeDate: string;
  side: "buy" | "sell" | "dividend";
  price: number;
  units: number;
  amount: number | null;
  fee: number;
  note: string;
  createdAt: string;
};

export type DividendAccountSummary = {
  capital: number;
  cash: number;
  units: number;
  averageCost: number | null;
  costBasis: number;
  strategyAllocation: number;
  realizedPnl: number;
  dividendIncome: number;
  marketPrice: number | null;
  marketValue: number | null;
  accountEquity: number | null;
  unrealizedPnl: number | null;
  totalPnl: number | null;
  allocation: number | null;
};

function finitePositive(value: number) {
  return Number.isFinite(value) && value > 0;
}

function money(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function price(value: number) {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

export function calculateDividendAccount(
  trades: DividendAccountTrade[],
  latestPrice: number | null = null,
): DividendAccountSummary {
  const ordered = [...trades].sort((left, right) =>
    left.tradeDate.localeCompare(right.tradeDate)
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id),
  );
  let cash = DIVIDEND_STRATEGY_CAPITAL;
  let units = 0;
  let averageCost = 0;
  let realizedPnl = 0;
  let dividendIncome = 0;

  for (const trade of ordered) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trade.tradeDate)) throw new Error("成交日期格式无效");
    if (trade.side === "dividend") {
      if (!finitePositive(trade.amount ?? 0)) throw new Error("现金分红金额必须大于 0");
      dividendIncome += trade.amount!;
      cash += trade.amount!;
      continue;
    }
    if (!finitePositive(trade.price)) throw new Error("成交价格必须大于 0");
    if (!Number.isInteger(trade.units) || trade.units <= 0) throw new Error("成交份额必须是正整数");
    if (!Number.isFinite(trade.fee) || trade.fee < 0) throw new Error("交易费用不能小于 0");
    if (trade.side === "buy") {
      const outflow = trade.price * trade.units + trade.fee;
      if (outflow > cash + .005) {
        throw new Error(`${trade.tradeDate} 买入金额超过当时可用现金`);
      }
      averageCost = (averageCost * units + outflow) / (units + trade.units);
      units += trade.units;
      cash -= outflow;
    } else if (trade.side === "sell") {
      if (trade.units > units) throw new Error(`${trade.tradeDate} 卖出份额超过当时持仓`);
      realizedPnl += (trade.price - averageCost) * trade.units - trade.fee;
      cash += trade.price * trade.units - trade.fee;
      units -= trade.units;
      if (units === 0) averageCost = 0;
    } else {
      throw new Error("成交方向无效");
    }
  }

  const marketPrice = latestPrice !== null && finitePositive(latestPrice) ? latestPrice : null;
  const roundedCash = money(Math.abs(cash) < .005 ? 0 : cash);
  const marketValue = units === 0 ? 0 : marketPrice === null ? null : money(units * marketPrice);
  const accountEquity = marketValue === null ? null : money(roundedCash + marketValue);
  const unrealizedPnl = marketValue === null ? null : money((marketPrice! - averageCost) * units);
  const totalPnl = accountEquity === null ? null : money(accountEquity - DIVIDEND_STRATEGY_CAPITAL);
  const allocation = accountEquity === null || accountEquity <= 0 ? null : marketValue! / accountEquity;
  const costBasis = money(averageCost * units);
  const rawStrategyAllocation = Math.min(1, Math.max(0, costBasis / DIVIDEND_STRATEGY_CAPITAL));
  const stage = [0, .2, .35, .5, .75, 1].find((value) => Math.abs(value - rawStrategyAllocation) <= .005);
  const strategyAllocation = stage ?? Math.round(rawStrategyAllocation * 10_000) / 10_000;

  return {
    capital: DIVIDEND_STRATEGY_CAPITAL,
    cash: roundedCash,
    units,
    averageCost: units ? price(averageCost) : null,
    costBasis,
    strategyAllocation,
    realizedPnl: money(realizedPnl),
    dividendIncome: money(dividendIncome),
    marketPrice,
    marketValue,
    accountEquity,
    unrealizedPnl,
    totalPnl,
    allocation,
  };
}
