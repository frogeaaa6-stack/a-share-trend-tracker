import {
  getFeishuConfigurationStatus,
  sendFeishuBuyAlert,
  sendFeishuLiveAlert,
  sendFeishuScheduledAlert,
  sendFeishuSellAlert,
  sendFeishuTestAlert,
  FeishuDeliveryUncertainError,
  type FeishuStrategyAlert,
} from "@/lib/notifications/feishu";
import { getDividendLadderFactors } from "@/lib/factors/dividendLadderFactors";
import { completedDailyBarError } from "@/lib/market/completedDailyBars";
import { ensureMarketSchema, getLatestDataset, getLatestVerifiedNoonSnapshot, isFresh } from "@/lib/market/persistence";
import { shanghaiCalendarDate } from "@/lib/market/completedDailyBars";
import {
  claimFeishuAlert,
  markFeishuAlertFailed,
  markFeishuAlertSending,
  markFeishuAlertSent,
  markFeishuAlertUncertain,
} from "@/lib/notifications/feishuPersistence";
import {
  evaluateEnhancedDividendLadder,
  type DividendLadderBar,
  type LadderDecision,
} from "@/lib/strategy/dividendLadder";
import { calculateDividendAccount, DIVIDEND_STRATEGY_CAPITAL } from "@/lib/strategy/dividendAccount";
import { getDividendAccountSnapshot } from "@/lib/strategy/dividendAccountPersistence";

export const dynamic = "force-dynamic";
const SYMBOL = "512890.SH";
const STRATEGY_VERSION = "volatility-guarded-v5";

function localHost(request: Request) {
  return new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(new URL(request.url).hostname);
}

function trustedLocalJsonRequest(request: Request) {
  if (!localHost(request) || !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(request.url);
    return new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(originUrl.hostname)
      && originUrl.port === requestUrl.port;
  } catch {
    return false;
  }
}

function assertCompletedDailyBar(latestDate: string, scheduled: boolean) {
  const error = completedDailyBarError(latestDate, scheduled);
  if (error) throw new Error(error);
}

function currentPosition(value: unknown, fallback?: number) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error("当前仓位必须是 0 到 1 之间的数字");
  return value;
}

function coldStartContext(value: unknown, bars: DividendLadderBar[], position: number) {
  if (position >= .5) return { coldStartDate: null, coldStartTradingDays: null };
  const latestDate = bars.at(-1)!.date;
  const startDate = value === undefined || value === null || value === "" ? latestDate : value;
  if (typeof startDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    throw new Error("冷启动日期必须使用 YYYY-MM-DD 格式");
  }
  const startIndex = bars.findLastIndex((bar) => bar.date <= startDate);
  if (startIndex < 0) throw new Error("冷启动日期早于当前已验证行情范围");
  return {
    coldStartDate: bars[startIndex].date,
    coldStartTradingDays: Math.max(0, bars.length - 1 - startIndex),
  };
}

function fallbackRebound20Pct(bars: DividendLadderBar[]) {
  const recent = bars.slice(-20);
  const lowest = Math.min(...recent.map((bar) => typeof bar.low === "number" && Number.isFinite(bar.low) ? bar.low : bar.close));
  return lowest > 0 ? bars.at(-1)!.close / lowest - 1 : null;
}

function fallbackMatchedRules(decision: LadderDecision) {
  const matched = ["行情样本已满足 MA250 与斜率计算要求"];
  if (decision.distance !== null && decision.distance < 0) matched.push(`收盘低于 MA250（偏离 ${(decision.distance * 100).toFixed(2)}%）`);
  if (decision.belowMaDays > 0) matched.push(`已连续 ${decision.belowMaDays} 个交易日低于 MA250`);
  if (decision.factorMode === "strict") matched.push("股息率与十年国债因子已进入严格模式");
  matched.push(`本次策略结论：${decision.label}`);
  return matched;
}

type DetailedDecision = LadderDecision & Partial<{
  phase: FeishuStrategyAlert["phase"];
  matchedRules: string[];
  pendingRules: string[];
  coldStartTradingDays: number | null;
  rebound20Pct: number | null;
  nextTarget: number | null;
  nextDeadlineTradingDay: number | null;
}>;

async function recomputeStrategyAlert(
  requestedPosition: number,
  coldStartDate: unknown,
  kind: FeishuStrategyAlert["kind"],
): Promise<FeishuStrategyAlert> {
  await ensureMarketSchema();
  const market = await getLatestDataset(SYMBOL, 2000);
  if (!market || market.bars.length < 270) throw new Error("没有足够的本地双源验证日线");
  if (!isFresh(market)) throw new Error("本地行情版本已过期，请先刷新红利低波数据");
  assertCompletedDailyBar(market.bars.at(-1)!.date, kind === "scheduled");
  const noon = kind === "scheduled" ? await getLatestVerifiedNoonSnapshot(SYMBOL, shanghaiCalendarDate()) : null;
  if (kind === "scheduled" && !noon) throw new Error("今天 11:30 午盘快照尚未双源验证；正常策略卡已暂停");
  const strategyBars: DividendLadderBar[] = noon ? [...market.bars, { ...noon.snapshot, date: noon.date }] : market.bars;
  const { trades: accountTrades, metadata: accountMetadata } = await getDividendAccountSnapshot();
  const markedAccount = calculateDividendAccount(accountTrades, strategyBars.at(-1)!.close);
  const position = accountTrades.length
    ? markedAccount.strategyAllocation
    : requestedPosition;
  const ledgerStartDate = accountTrades.find((trade) => trade.side === "buy")?.tradeDate
    ?? accountMetadata.createdAt.slice(0, 10);
  const coldStart = coldStartContext(coldStartDate || ledgerStartDate, strategyBars, position);
  const factors = await getDividendLadderFactors();
  const decision = evaluateEnhancedDividendLadder(
    strategyBars,
    position,
    { verified: market.validation.verified, stale: false },
    {
      dividendYield: factors.dividend.value,
      dividendDate: factors.dividend.date,
      governmentBond10Y: factors.rate.value,
      rateDate: factors.rate.date,
      verified: factors.rate.verified,
    },
    false,
    { coldStartDate: coldStart.coldStartDate ?? undefined },
  ) as DetailedDecision;
  if (!decision.ready || decision.target === null || decision.close === null || decision.ma250 === null || decision.distance === null) {
    throw new Error("服务器策略复算尚未就绪");
  }
  const provisionalVolume = Boolean(noon && decision.volumeRatio !== null);
  const executionTarget = decision.action === "buy"
    ? Math.min(decision.target, position + .25)
    : decision.action === "sell"
      ? Math.max(decision.target, position - .25)
      : decision.target;
  const pendingRules = [...new Set([...(decision.pendingRules ?? []), ...decision.gates, ...(provisionalVolume ? ["午盘成交量为截至 11:30 的临时累计值；13:00 后人工执行时仍不能视为全天成交量护栏已通过"] : [])])];
  return {
    kind,
    symbol: SYMBOL,
    strategyVersion: STRATEGY_VERSION,
    signalDate: noon?.date ?? market.bars.at(-1)!.date,
    currentPosition: position,
    executionTarget,
    strategyTarget: decision.target,
    phase: decision.phase ?? (position < .5 ? "cold-start" : "core-tactical"),
    action: decision.action,
    decisionLabel: decision.label,
    close: decision.close,
    ma250: decision.ma250,
    distance: decision.distance,
    slope20: decision.slope20,
    belowMaDays: decision.belowMaDays,
    belowMaSince: decision.belowMaSince,
    rebound20Pct: decision.rebound20Pct ?? fallbackRebound20Pct(market.bars),
    coldStartDate: coldStart.coldStartDate,
    coldStartTradingDays: decision.coldStartTradingDays ?? coldStart.coldStartTradingDays,
    nextTarget: decision.nextTarget ?? null,
    nextDeadlineTradingDay: decision.nextDeadlineTradingDay ?? null,
    matchedRules: decision.matchedRules?.length ? decision.matchedRules : fallbackMatchedRules(decision),
    pendingRules,
    dividendYield: decision.dividendYield,
    dividendDate: factors.dividend.date,
    governmentBond10Y: decision.governmentBond10Y,
    rateDate: factors.rate.date,
    dividendSpread: decision.dividendSpread,
    factorCap: decision.factorCap,
    factorMode: decision.factorMode,
    factorsVerified: factors.rate.verified,
    marketVerified: market.validation.verified,
    marketFresh: true,
    marketQualityGrade: market.validation.quality.grade,
    marketQualityScore: market.validation.quality.score,
    marketDatasetVersion: market.dataset.version,
    marketSources: market.validation.sources
      .filter((source) => source.status === "ok")
      .map((source) => source.provider),
    accountLedgerVersion: accountMetadata.ledgerVersion,
    strategyCostBasis: accountTrades.length
      ? markedAccount.costBasis
      : DIVIDEND_STRATEGY_CAPITAL * position,
    accountEquity: markedAccount.accountEquity ?? DIVIDEND_STRATEGY_CAPITAL,
    marketValue: markedAccount.marketValue ?? DIVIDEND_STRATEGY_CAPITAL * position,
    averageCost: markedAccount.averageCost,
    noonSnapshotTime: noon?.snapshotTime,
    noonBaseAsOf: noon ? market.bars.at(-1)!.date : undefined,
    noonSnapshotHash: noon?.hash,
    noonQualityGrade: noon?.validation.quality.grade,
    noonQualityScore: noon?.validation.quality.score,
    noonSources: noon ? ["eastmoney", "tencent"] : undefined,
    noonVolumeProvisional: provisionalVolume,
  };
}

async function deliverClaimedAlert(
  alert: FeishuStrategyAlert,
  dedupeKey: string,
  send: () => Promise<unknown>,
) {
  const claimed = await claimFeishuAlert({
    dedupeKey,
    symbol: alert.symbol,
    strategy: alert.strategyVersion,
    executionTarget: alert.executionTarget,
    signalDate: alert.signalDate,
  });
  if (!claimed) return { sent: false, deduplicated: true };
  await markFeishuAlertSending(dedupeKey);
  try {
    await send();
    const auditConfirmed = await markFeishuAlertSent(dedupeKey);
    return {
      sent: true,
      deduplicated: false,
      auditConfirmed,
      warning: auditConfirmed ? undefined : "飞书已确认接收，但本地发送状态未能落库；该批次已锁定且不会自动重发",
    };
  } catch (error) {
    const failure = error instanceof Error ? error.message : "飞书提醒发送失败";
    if (error instanceof FeishuDeliveryUncertainError) {
      await markFeishuAlertUncertain(dedupeKey, failure);
    } else {
      await markFeishuAlertFailed(dedupeKey, failure);
    }
    throw error;
  }
}

export async function GET() {
  return Response.json(getFeishuConfigurationStatus(), { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  if (!trustedLocalJsonRequest(request)) {
    return Response.json({ code: "LOCAL_JSON_ONLY", error: "飞书外发只允许本机页面或本机调度器发起 JSON 请求" }, { status: 403 });
  }
  const status = getFeishuConfigurationStatus();
  if (!status.configured) return Response.json({ code: "FEISHU_NOT_CONFIGURED", error: "飞书提醒尚未完成本机配置", ...status }, { status: 503 });
  try {
    const body = await request.json() as { kind?: unknown; currentPosition?: unknown; coldStartDate?: unknown };
    if (body.kind === "test") {
      const alert = await recomputeStrategyAlert(
        currentPosition(body.currentPosition, 0),
        body.coldStartDate,
        "test",
      );
      const delivery = await deliverClaimedAlert(
        alert,
        ["feishu-status-v1", "test", alert.symbol, new Date().toISOString().slice(0, 16), alert.accountLedgerVersion].join("|"),
        () => sendFeishuTestAlert(alert),
      );
      return Response.json({
        ...delivery,
        action: alert.action,
        decision: alert.decisionLabel,
        signalDate: alert.signalDate,
      });
    }
    if (body.kind === "live") {
      const alert = await recomputeStrategyAlert(
        currentPosition(body.currentPosition, 0),
        body.coldStartDate,
        "live",
      );
      const delivery = await deliverClaimedAlert(
        alert,
        ["feishu-status-v1", "live", alert.symbol, alert.signalDate, alert.action, alert.executionTarget.toFixed(2), alert.accountLedgerVersion].join("|"),
        () => sendFeishuLiveAlert(alert),
      );
      return Response.json({
        ...delivery,
        action: alert.action,
        decision: alert.decisionLabel,
        signalDate: alert.signalDate,
        mode: "live",
      });
    }
    if (body.kind === "scheduled") {
      const alert = await recomputeStrategyAlert(
        currentPosition(body.currentPosition, 0),
        body.coldStartDate,
        "scheduled",
      );
      const delivery = await deliverClaimedAlert(
        alert,
        ["feishu-status-v1", "scheduled", alert.symbol, alert.signalDate, alert.noonSnapshotHash ?? "missing-noon-hash", alert.action, alert.executionTarget.toFixed(2), alert.accountLedgerVersion].join("|"),
        () => sendFeishuScheduledAlert(alert),
      );
      return Response.json({
        ...delivery,
        action: alert.action,
        decision: alert.decisionLabel,
        signalDate: alert.signalDate,
        mode: "scheduled",
        marketMode: "verified_noon",
        strategyVersion: alert.strategyVersion,
        baseAsOf: alert.noonBaseAsOf,
        snapshotTime: alert.noonSnapshotTime,
        snapshotHash: alert.noonSnapshotHash,
      });
    }
    if (body.kind !== "buy" && body.kind !== "sell") throw new Error("只支持 test、live、scheduled、buy 或 sell 提醒");
    const alert = await recomputeStrategyAlert(
      currentPosition(body.currentPosition),
      body.coldStartDate,
      body.kind,
    );
    if (alert.action !== body.kind) {
      return Response.json({
        sent: false,
        deduplicated: false,
        reason: `服务器复算后当前不是${body.kind === "buy" ? "买入" : "卖出"}信号`,
        action: alert.action,
        decision: alert.decisionLabel,
      });
    }
    const dedupeKey = [
      "feishu-signal-v4",
      alert.symbol,
      alert.strategyVersion,
      alert.action,
      alert.executionTarget.toFixed(2),
      alert.belowMaSince ?? alert.coldStartDate ?? "core",
      alert.accountLedgerVersion,
    ].join("|");
    const delivery = await deliverClaimedAlert(
      alert,
      dedupeKey,
      () => alert.action === "buy" ? sendFeishuBuyAlert(alert) : sendFeishuSellAlert(alert),
    );
    return Response.json({ ...delivery, action: alert.action });
  } catch (error) {
    return Response.json({
      code: "FEISHU_SEND_FAILED",
      error: error instanceof Error ? error.message : "飞书提醒发送失败",
    }, { status: 502 });
  }
}
