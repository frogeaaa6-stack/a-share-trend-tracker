import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildFeishuAppMessage,
  feishuAppMessageUrl,
  normalizeFeishuReceiveIdType,
  validFeishuAppId,
  validFeishuReceiveId,
} from "../lib/notifications/feishuApp.ts";
import { buildFeishuStrategyAlertContent } from "../lib/notifications/feishu.ts";

test("builds a Feishu app-bot interactive message for a group chat", () => {
  const card = {
    header: { title: { tag: "plain_text", content: "A股策略提醒" } },
    elements: [],
  };
  const body = buildFeishuAppMessage("oc_example123", card);
  assert.equal(body.receive_id, "oc_example123");
  assert.equal(body.msg_type, "interactive");
  assert.deepEqual(JSON.parse(body.content), card);
  assert.equal(
    feishuAppMessageUrl("chat_id"),
    "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
  );
});

test("validates app and receiver identifiers without exposing credentials", () => {
  assert.equal(validFeishuAppId("cli_example123"), true);
  assert.equal(validFeishuAppId("example123"), false);
  assert.equal(validFeishuReceiveId("oc_example123", "chat_id"), true);
  assert.equal(validFeishuReceiveId("ou_example123", "chat_id"), false);
  assert.equal(validFeishuReceiveId("person@example.com", "email"), true);
  assert.equal(normalizeFeishuReceiveIdType("unexpected"), "chat_id");
});

test("builds a detailed test card from a server-side strategy snapshot", () => {
  const content = buildFeishuStrategyAlertContent({
    kind: "test",
    symbol: "512890.SH",
    strategyVersion: "volatility-guarded-v5",
    signalDate: "2026-07-24",
    currentPosition: 0,
    executionTarget: 0,
    strategyTarget: 0,
    phase: "cold-start",
    action: "hold",
    decisionLabel: "等待首批核心仓",
    close: 1.162,
    ma250: 1.177,
    distance: -.013,
    slope20: .002,
    belowMaDays: 56,
    belowMaSince: "2026-05-08",
    rebound20Pct: .0942,
    coldStartDate: "2026-07-24",
    coldStartTradingDays: 0,
    nextTarget: .2,
    nextDeadlineTradingDay: 63,
    matchedRules: ["连续低于 MA250 已达到 5 日"],
    pendingRules: ["偏离尚未达到 -2%", "反弹过滤器命中，暂缓首批建仓"],
    dividendYield: .038,
    dividendDate: "2026-07-24",
    governmentBond10Y: .017,
    rateDate: "2026-07-24",
    dividendSpread: .021,
    factorCap: .75,
    factorMode: "strict",
    factorsVerified: true,
    marketVerified: true,
    marketFresh: true,
    marketQualityGrade: "A",
    marketQualityScore: 100,
    marketDatasetVersion: 18,
    marketSources: ["eastmoney", "tencent"],
    accountLedgerVersion: 0,
    strategyCostBasis: 0,
    accountEquity: 50_000,
    marketValue: 0,
    averageCost: null,
  });

  assert.match(content.title, /【测试】红利低波ETF｜等待｜当前未触发买卖/);
  assert.match(content.markdown, /华泰柏瑞中证红利低波动交易型开放式指数证券投资基金/);
  assert.match(content.markdown, /已命中策略[\s\S]*连续低于 MA250 已达到 5 日/);
  assert.match(content.markdown, /未命中 \/ 阻挡条件[\s\S]*反弹过滤器命中/);
  assert.match(content.markdown, /指数股息率[\s\S]*十年国债[\s\S]*股息利差/);
  assert.match(content.markdown, /eastmoney \+ tencent/);
  assert.match(content.markdown, /初始本金 ¥50,000/);
  assert.match(content.markdown, /卖出与风险控制[\s\S]*卖出一级[\s\S]*卖出二级/);
  assert.match(content.markdown, /核心止盈观察（暂不自动执行）/);
  assert.match(content.markdown, /本条仅测试消息链路，一分钟内相同测试会去重，不产生交易/);
  assert.equal(content.template, "blue");
});

test("builds a formal live card without test wording", () => {
  const content = buildFeishuStrategyAlertContent({
    kind: "live",
    symbol: "512890.SH",
    strategyVersion: "volatility-guarded-v5",
    signalDate: "2026-07-24",
    currentPosition: 0,
    executionTarget: 0,
    strategyTarget: 0,
    phase: "cold-start",
    action: "hold",
    decisionLabel: "反弹过滤生效，暂缓20%核心仓",
    close: 1.162,
    ma250: 1.177,
    distance: -.013,
    slope20: -.005,
    belowMaDays: 56,
    belowMaSince: "2026-05-07",
    rebound20Pct: .0942,
    coldStartDate: "2026-07-24",
    coldStartTradingDays: 0,
    nextTarget: .2,
    nextDeadlineTradingDay: 63,
    matchedRules: ["行情通过双源验证"],
    pendingRules: ["反弹过滤生效"],
    dividendYield: .0476,
    dividendDate: "2026-07-24",
    governmentBond10Y: .017282,
    rateDate: "2026-07-24",
    dividendSpread: .030318,
    factorCap: 1,
    factorMode: "strict",
    factorsVerified: true,
    marketVerified: true,
    marketFresh: true,
    marketQualityGrade: "A",
    marketQualityScore: 100,
    marketDatasetVersion: 1,
    marketSources: ["eastmoney", "tencent"],
    accountLedgerVersion: 0,
    strategyCostBasis: 0,
    accountEquity: 50_000,
    marketValue: 0,
    averageCost: null,
  });
  assert.match(content.title, /【正式上线】/);
  assert.match(content.markdown, /正式上线状态播报/);
  assert.match(content.note, /正式上线/);
  assert.doesNotMatch(`${content.title}\n${content.markdown}\n${content.note}`, /测试/);
  assert.equal(content.template, "grey");
});

test("uses distinct Feishu colors for buy and sell levels", () => {
  const base = {
    kind: "buy",
    symbol: "512890.SH",
    strategyVersion: "hybrid-core-tactical-v4",
    signalDate: "2026-07-24",
    currentPosition: .75,
    executionTarget: 1,
    strategyTarget: 1,
    phase: "core-tactical",
    action: "buy",
    decisionLabel: "增加机动仓至100%",
    close: 1.1,
    ma250: 1.2,
    distance: -.0834,
    slope20: 0,
    belowMaDays: 15,
    belowMaSince: "2026-07-04",
    rebound20Pct: .01,
    coldStartDate: null,
    coldStartTradingDays: null,
    nextTarget: null,
    nextDeadlineTradingDay: null,
    matchedRules: ["第二机动档命中"],
    pendingRules: [],
    dividendYield: .05,
    dividendDate: "2026-07-24",
    governmentBond10Y: .017,
    rateDate: "2026-07-24",
    dividendSpread: .033,
    factorCap: 1,
    factorMode: "strict",
    factorsVerified: true,
    marketVerified: true,
    marketFresh: true,
    marketQualityGrade: "A",
    marketQualityScore: 100,
    marketDatasetVersion: 25,
    marketSources: ["eastmoney", "tencent"],
    accountLedgerVersion: 3,
    strategyCostBasis: 37_500,
    accountEquity: 51_000,
    marketValue: 38_500,
    averageCost: 1.071,
  };
  const heavyBuy = buildFeishuStrategyAlertContent(base);
  const firstSell = buildFeishuStrategyAlertContent({
    ...base,
    kind: "sell",
    action: "sell",
    currentPosition: 1,
    executionTarget: .75,
    strategyTarget: .75,
    decisionLabel: "收缩机动仓至75%",
    distance: -.05,
  });
  const secondSell = buildFeishuStrategyAlertContent({
    ...base,
    kind: "sell",
    action: "sell",
    currentPosition: .75,
    executionTarget: .5,
    strategyTarget: .5,
    decisionLabel: "收缩机动仓至50%",
    distance: 0,
  });
  const scheduledHold = buildFeishuStrategyAlertContent({
    ...base,
    kind: "scheduled",
    action: "hold",
    currentPosition: .5,
    executionTarget: .5,
    strategyTarget: .5,
    decisionLabel: "维持50%",
    distance: -.02,
  });
  assert.equal(heavyBuy.template, "carmine");
  assert.equal(firstSell.template, "wathet");
  assert.equal(secondSell.template, "turquoise");
  assert.match(firstSell.title, /卖出一级/);
  assert.match(secondSell.title, /卖出二级/);
  assert.match(scheduledHold.title, /【交易日 12:00】/);
  assert.match(scheduledHold.markdown, /11:30 午盘价/);
  assert.match(scheduledHold.markdown, /13:00 后人工判断\/执行/);
  assert.equal(scheduledHold.template, "grey");
});

test("states the T-day 11:30 noon contract only for scheduled Feishu cards", () => {
  const base = {
    kind: "scheduled",
    symbol: "512890.SH",
    strategyVersion: "volatility-guarded-v5",
    signalDate: "2026-07-27",
    currentPosition: .5,
    executionTarget: .5,
    strategyTarget: .5,
    phase: "core-tactical",
    action: "hold",
    decisionLabel: "维持50%",
    close: 1.163,
    ma250: 1.177,
    distance: -.012,
    slope20: .001,
    belowMaDays: 4,
    belowMaSince: "2026-07-22",
    rebound20Pct: .01,
    coldStartDate: null,
    coldStartTradingDays: null,
    nextTarget: null,
    nextDeadlineTradingDay: null,
    matchedRules: ["成交护栏通过：近 3 个交易日未出现放量长阴"],
    pendingRules: ["午盘成交量为截至 11:30 的临时累计值；13:00 后人工执行时仍不能视为全天成交量护栏已通过"],
    dividendYield: .04,
    dividendDate: "2026-07-24",
    governmentBond10Y: .017,
    rateDate: "2026-07-24",
    dividendSpread: .023,
    factorCap: 1,
    factorMode: "strict",
    factorsVerified: true,
    marketVerified: true,
    marketFresh: true,
    marketQualityGrade: "A",
    marketQualityScore: 100,
    marketDatasetVersion: 31,
    marketSources: ["eastmoney", "tencent"],
    accountLedgerVersion: 3,
    strategyCostBasis: 20_000,
    accountEquity: 50_000,
    marketValue: 25_000,
    averageCost: 1.1,
    noonSnapshotTime: "11:30",
    noonBaseAsOf: "2026-07-24",
    noonSnapshotHash: "a1b2c3d4e5f60708",
    noonQualityGrade: "B",
    noonQualityScore: 90,
    noonSources: ["eastmoney", "tencent"],
    noonVolumeProvisional: true,
  };
  const scheduled = buildFeishuStrategyAlertContent(base);
  const scheduledText = `${scheduled.title}\n${scheduled.markdown}\n${scheduled.note}`;
  assert.match(scheduledText, /信号日期：2026-07-27/);
  assert.match(scheduledText, /策略版本：volatility-guarded-v5/);
  assert.match(scheduledText, /11:30 午盘价 \/ 临时 MA250/);
  assert.match(scheduledText, /历史基线截至 2026-07-24/);
  assert.match(scheduledText, /13:00 后人工判断\/执行/);
  assert.match(scheduledText, /不是 15:00 收盘信号/);
  assert.match(scheduledText, /不纳入完整日线回测/);
  assert.match(scheduledText, /午盘成交量\/成交额为截至 11:30 的临时累计值/);
  assert.match(scheduledText, /MA250、近 20 日斜率、连续跌破日数、20 日反弹和波动率分位均按 11:30 临时 bar 重算/);
  assert.match(scheduledText, /成交护栏午盘观察/);
  assert.doesNotMatch(scheduledText, /成交护栏通过：近 3 个交易日未出现放量长阴/);
  assert.doesNotMatch(scheduledText, /完整 T-1 日线状态/);
  assert.doesNotMatch(scheduledText, /T\+1 开盘执行/);

  const normal = buildFeishuStrategyAlertContent({ ...base, kind: "live", signalDate: "2026-07-24", pendingRules: [], noonSnapshotTime: undefined, noonBaseAsOf: undefined, noonSnapshotHash: undefined, noonQualityGrade: undefined, noonQualityScore: undefined, noonSources: undefined, noonVolumeProvisional: undefined });
  const normalText = `${normal.title}\n${normal.markdown}\n${normal.note}`;
  assert.match(normalText, /收盘 \/ MA250/);
  assert.doesNotMatch(normalText, /11:30 午盘价|13:00 后人工|不纳入完整日线回测/);
});

test("scheduled delivery advertises the active v5 volatility-guard strategy", async () => {
  const route = await readFile(new URL("../app/api/notifications/feishu/route.ts", import.meta.url), "utf8");
  assert.match(route, /STRATEGY_VERSION\s*=\s*"volatility-guarded-v5"/);
});
