import { env } from "cloudflare:workers";
import {
  buildFeishuAppMessage,
  feishuAppMessageUrl,
  normalizeFeishuReceiveIdType,
  validFeishuAppId,
  validFeishuReceiveId,
  type FeishuReceiveIdType,
} from "./feishuApp";
import { createFeishuSignature } from "./feishuSignature";
import { DIVIDEND_STRATEGY_CAPITAL } from "../strategy/dividendAccount";

export type FeishuStrategyAlert = {
  kind: "test" | "buy" | "sell" | "live" | "scheduled";
  symbol: string;
  strategyVersion: string;
  signalDate: string;
  currentPosition: number;
  executionTarget: number;
  strategyTarget: number;
  phase: "standard" | "cold-start" | "core-tactical";
  action: "buy" | "sell" | "hold" | "review";
  decisionLabel: string;
  close: number;
  ma250: number;
  distance: number;
  slope20: number | null;
  belowMaDays: number;
  belowMaSince: string | null;
  rebound20Pct: number | null;
  coldStartDate: string | null;
  coldStartTradingDays: number | null;
  nextTarget: number | null;
  nextDeadlineTradingDay: number | null;
  matchedRules: string[];
  pendingRules: string[];
  dividendYield: number | null;
  dividendDate: string | null;
  governmentBond10Y: number | null;
  rateDate: string | null;
  dividendSpread: number | null;
  factorCap: number;
  factorMode: "strict" | "degraded" | "not-backtested";
  factorsVerified: boolean;
  marketVerified: boolean;
  marketFresh: boolean;
  marketQualityGrade: string;
  marketQualityScore: number;
  marketDatasetVersion: number;
  marketSources: string[];
  accountLedgerVersion: number;
  strategyCostBasis: number;
  accountEquity: number;
  marketValue: number;
  averageCost: number | null;
};

export type FeishuBuyAlert = FeishuStrategyAlert;

export class FeishuDeliveryUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeishuDeliveryUncertainError";
  }
}

type FeishuConfig = {
  enabled: boolean;
  mode: "app" | "webhook";
  appId: string | null;
  appSecret: string | null;
  receiveId: string | null;
  receiveIdType: FeishuReceiveIdType;
  webhookUrl: string | null;
  signingSecret: string | null;
  keyword: string;
};

function readConfig(): FeishuConfig {
  const appId = env.FEISHU_APP_ID?.trim() || null;
  const appSecret = env.FEISHU_APP_SECRET?.trim() || null;
  const requestedMode = env.FEISHU_ALERT_MODE?.trim().toLowerCase();
  const webhookUrl = env.FEISHU_WEBHOOK_URL?.trim() || null;
  const signingSecret = env.FEISHU_WEBHOOK_SECRET?.trim() || null;
  return {
    enabled: env.FEISHU_ALERT_ENABLED?.trim().toLowerCase() === "true",
    mode: requestedMode === "webhook" ? "webhook" : requestedMode === "app" ? "app" : appId || appSecret ? "app" : "webhook",
    appId,
    appSecret,
    receiveId: env.FEISHU_RECEIVE_ID?.trim() || null,
    receiveIdType: normalizeFeishuReceiveIdType(env.FEISHU_RECEIVE_ID_TYPE?.trim().toLowerCase()),
    webhookUrl,
    signingSecret,
    keyword: env.FEISHU_ALERT_KEYWORD?.trim() || "A股策略提醒",
  };
}

function validWebhook(value: string | null) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "open.feishu.cn"
      && /^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function getFeishuConfigurationStatus() {
  const config = readConfig();
  const urlValid = validWebhook(config.webhookUrl);
  const appCredentialsConfigured = validFeishuAppId(config.appId) && Boolean(config.appSecret);
  const receiverConfigured = validFeishuReceiveId(config.receiveId, config.receiveIdType);
  const appConfigured = appCredentialsConfigured && receiverConfigured;
  const channelConfigured = config.mode === "app" ? appConfigured : urlValid;
  const missing = config.mode === "app"
    ? [
        ...(!appCredentialsConfigured ? ["应用 App ID / App Secret"] : []),
        ...(!receiverConfigured ? [`接收对象 ${config.receiveIdType}`] : []),
      ]
    : !urlValid ? ["自定义机器人 Webhook"] : [];
  return {
    enabled: config.enabled,
    configured: config.enabled && channelConfigured,
    mode: config.mode === "app" ? "app_bot" : "custom_webhook",
    appCredentialsConfigured,
    receiverConfigured,
    receiveIdType: config.receiveIdType,
    signed: config.mode === "webhook" && Boolean(config.signingSecret),
    keywordConfigured: Boolean(env.FEISHU_ALERT_KEYWORD?.trim()),
    destination: channelConfigured
      ? config.mode === "app"
        ? config.receiveIdType === "chat_id" ? "飞书自建应用机器人 · 群聊" : "飞书自建应用机器人 · 指定用户"
        : "飞书自定义机器人"
      : null,
    missing,
  };
}

function naturalPercent(value: number | null, digits = 2) {
  return value === null ? "不可用" : `${(value * 100).toFixed(digits)}%`;
}

function position(value: number) {
  return `${Math.round(value * 100)}%`;
}

export type FeishuCard = {
  config: { wide_screen_mode: boolean };
  header: {
    template: string;
    title: { tag: string; content: string };
  };
  elements: Array<Record<string, unknown>>;
};

let cachedTenantToken: {
  appId: string;
  appSecret: string;
  token: string;
  expiresAt: number;
} | null = null;

async function responseJson(response: Response) {
  return response.json().catch(() => ({})) as Promise<{
    code?: number;
    msg?: string;
    StatusCode?: number;
    StatusMessage?: string;
    tenant_access_token?: string;
    expire?: number;
  }>;
}

async function fetchWithTimeout(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function tenantAccessToken(config: FeishuConfig) {
  const appId = config.appId;
  const appSecret = config.appSecret;
  if (!validFeishuAppId(appId) || !appSecret) throw new Error("飞书应用 App ID 或 App Secret 尚未配置");
  const verifiedAppId = appId!;
  if (
    cachedTenantToken
    && cachedTenantToken.appId === verifiedAppId
    && cachedTenantToken.appSecret === appSecret
    && cachedTenantToken.expiresAt > Date.now() + 30_000
  ) return cachedTenantToken.token;
  const response = await fetchWithTimeout(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: verifiedAppId, app_secret: appSecret }),
    },
  );
  const body = await responseJson(response);
  if (!response.ok || body.code !== 0 || !body.tenant_access_token) {
    throw new Error(body.msg || `飞书应用鉴权失败（${response.status}）`);
  }
  const ttlSeconds = Math.max(60, Number(body.expire ?? 7_200) - 120);
  const token = body.tenant_access_token;
  cachedTenantToken = {
    appId: verifiedAppId,
    appSecret,
    token,
    expiresAt: Date.now() + ttlSeconds * 1_000,
  };
  return token;
}

async function sendAppCard(config: FeishuConfig, card: FeishuCard) {
  if (!validFeishuReceiveId(config.receiveId, config.receiveIdType)) {
    throw new Error(`飞书接收对象 ${config.receiveIdType} 尚未配置或格式无效`);
  }
  const token = await tenantAccessToken(config);
  let response: Response;
  try {
    response = await fetchWithTimeout(feishuAppMessageUrl(config.receiveIdType), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(buildFeishuAppMessage(config.receiveId!, card)),
    });
  } catch (error) {
    throw new FeishuDeliveryUncertainError(`飞书消息请求结果不确定，已禁止自动重发：${error instanceof Error ? error.message : "网络中断或超时"}`);
  }
  const body = await responseJson(response);
  if (!response.ok || (typeof body.code === "number" && body.code !== 0)) {
    throw new Error(body.msg || `飞书应用消息接口返回 ${response.status}`);
  }
  if (body.code !== 0) throw new FeishuDeliveryUncertainError("飞书消息接口已响应但缺少明确成功码，已禁止自动重发");
}

async function sendWebhookCard(config: FeishuConfig, card: FeishuCard) {
  if (!validWebhook(config.webhookUrl)) throw new Error("飞书 Webhook 尚未配置或格式无效");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const auth = config.signingSecret
    ? { timestamp, sign: await createFeishuSignature(timestamp, config.signingSecret) }
    : {};
  const payload = {
    ...auth,
    msg_type: "interactive",
    card,
  };
  let response: Response;
  try {
    response = await fetchWithTimeout(config.webhookUrl!, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new FeishuDeliveryUncertainError(`飞书消息请求结果不确定，已禁止自动重发：${error instanceof Error ? error.message : "网络中断或超时"}`);
  }
  const body = await responseJson(response);
  const providerCode = body.code ?? body.StatusCode ?? 0;
  if (!response.ok || providerCode !== 0) {
    throw new Error(body.msg || body.StatusMessage || `飞书接口返回 ${response.status}`);
  }
}

async function sendCard(title: string, markdown: string, note: string, template = "green") {
  const config = readConfig();
  if (!config.enabled) throw new Error("飞书提醒尚未启用");
  const card: FeishuCard = {
      config: { wide_screen_mode: true },
      header: {
        template,
        title: { tag: "plain_text", content: `${config.keyword}｜${title}` },
      },
      elements: [
        { tag: "div", text: { tag: "lark_md", content: markdown } },
        { tag: "hr" },
        { tag: "note", elements: [{ tag: "plain_text", content: note }] },
      ],
  };
  if (config.mode === "app") await sendAppCard(config, card);
  else await sendWebhookCard(config, card);
}

function phaseLabel(value: FeishuStrategyAlert["phase"]) {
  return value === "cold-start" ? "冷启动分批建仓" : value === "core-tactical" ? "核心仓＋机动仓" : "标准分档";
}

function actionLabel(value: FeishuStrategyAlert["action"]) {
  return value === "buy" ? "买入/加仓" : value === "sell" ? "减仓" : value === "review" ? "人工复核" : "等待/持有";
}

function factorModeLabel(value: FeishuStrategyAlert["factorMode"]) {
  return value === "strict" ? "严格（因子已核验）" : value === "degraded" ? "降级（因子不完整或未交叉核验）" : "仅展示（历史回测未纳入）";
}

function listLines(values: string[], fallback: string) {
  const unique = [...new Set(values.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean))];
  return unique.length ? unique.map((value) => `• ${value}`).join("\n") : `• ${fallback}`;
}

function signalLevel(input: FeishuStrategyAlert) {
  if (input.action === "buy") {
    if (input.executionTarget <= .2) return { label: "买入一级｜观察建仓至 20%", template: "yellow" };
    if (input.executionTarget <= .5) return { label: `买入二级｜核心仓至 ${position(input.executionTarget)}`, template: "orange" };
    if (input.executionTarget <= .75) return { label: "买入三级｜第一机动仓至 75%", template: "red" };
    return { label: "买入四级｜第二机动仓至 100%", template: "carmine" };
  }
  if (input.action === "sell") {
    if (input.executionTarget >= .75) return { label: "卖出一级｜回收第二机动仓至 75%", template: "wathet" };
    if (input.executionTarget >= .5) return { label: "卖出二级｜回收全部机动仓至 50%", template: "turquoise" };
    if (input.executionTarget >= .35) return { label: "卖出观察｜核心仓止盈至 35%", template: "green" };
    return { label: "卖出观察｜核心仓止盈至 20%", template: "indigo" };
  }
  if (input.action === "review") return { label: "人工复核｜数据或风险护栏", template: "purple" };
  return { label: "等待｜当前未触发买卖", template: "grey" };
}

function sellGuidance(input: FeishuStrategyAlert) {
  const firstTriggered = input.currentPosition > .75 && input.distance >= -.06;
  const secondTriggered = input.currentPosition > .5 && input.distance >= -.01;
  const firstGap = Math.max(0, (-.06 - input.distance) * 100);
  const secondGap = Math.max(0, (-.01 - input.distance) * 100);
  const lines = [
    input.currentPosition > .75
      ? firstTriggered
        ? "• 卖出一级已命中：100% → 75%，回收第二机动仓"
        : `• 卖出一级待命：回升至距 MA250 ≥ -6% 时 100% → 75%；当前尚差 ${firstGap.toFixed(2)} 个百分点`
      : "• 卖出一级适用于 100% 仓位：回升至距 MA250 ≥ -6% 时回收至 75%",
    input.currentPosition > .5
      ? secondTriggered
        ? "• 卖出二级已命中：75% → 50%，回收全部机动仓"
        : `• 卖出二级待命：回升至距 MA250 ≥ -1% 时 75% → 50%；当前尚差 ${secondGap.toFixed(2)} 个百分点`
      : "• 卖出二级适用于 75% 仓位：回升至距 MA250 ≥ -1% 时归位 50% 核心仓",
    input.distance <= -.18
      ? "• 极端风险已命中：停止继续摊低；高于 50% 的部分降回核心仓并人工复核"
      : "• 极端风险：距 MA250 ≤ -18% 时停止摊低，高于 50% 的部分降回核心仓",
    input.currentPosition <= .5
      ? "• 当前没有可机械卖出的机动仓；50% 核心仓不因普通反弹自动清空"
      : "• 股息利差下降目前只限制新增机动仓，不单独触发低位卖出",
  ];
  return lines.join("\n");
}

function executionEstimate(input: FeishuStrategyAlert) {
  const budgetDelta = DIVIDEND_STRATEGY_CAPITAL * (input.executionTarget - input.currentPosition);
  if (budgetDelta >= 0) return `新增预算约 ¥${Math.round(budgetDelta).toLocaleString("zh-CN")}`;
  const units = Math.abs(budgetDelta) / (input.averageCost ?? input.close);
  const proceeds = units * input.close;
  return `减少持仓成本约 ¥${Math.round(Math.abs(budgetDelta)).toLocaleString("zh-CN")}；按现价估算回收约 ¥${Math.round(proceeds).toLocaleString("zh-CN")}`;
}

export function buildFeishuStrategyAlertContent(input: FeishuStrategyAlert) {
  const isTest = input.kind === "test";
  const isLive = input.kind === "live";
  const isScheduled = input.kind === "scheduled";
  const level = signalLevel(input);
  const title = `${isTest ? "【测试】" : isLive ? "【正式上线】" : isScheduled ? "【交易日 12:00】" : "【正式】"}红利低波ETF｜${level.label}`;
  const sourceText = input.marketSources.length ? input.marketSources.join(" + ") : "未提供";
  const marketStatus = input.marketVerified && input.marketFresh
    ? `通过（${sourceText}；质量 ${input.marketQualityGrade}/${input.marketQualityScore}；版本 ${input.marketDatasetVersion}）`
    : `未完全通过（双源验证：${input.marketVerified ? "是" : "否"}；版本新鲜：${input.marketFresh ? "是" : "否"}）`;
  const factorStatus = input.factorsVerified ? "通过同日交叉核验" : "未完成同日交叉核验";
  const coldStart = input.coldStartTradingDays === null
    ? "不适用"
    : `${input.coldStartTradingDays} 个交易日${input.coldStartDate ? `（起始 ${input.coldStartDate}）` : ""}`;
  const nextDeadline = input.nextDeadlineTradingDay === null
    ? "不适用"
    : `第 ${input.nextDeadlineTradingDay} 个交易日${input.nextTarget === null ? "" : `前完成至 ${position(input.nextTarget)}`}`;
  const markdown = [
    "**标的**",
    "华泰柏瑞中证红利低波动交易型开放式指数证券投资基金",
    `简称：红利低波ETF　代码：${input.symbol}`,
    "",
    "**策略结论**",
    `信号日期：${input.signalDate}　消息：${isTest ? "测试（照常展示真实复算结论）" : isLive ? "正式上线状态播报" : isScheduled ? "交易日午间状态播报（完整 T-1 日线）" : "正式批次提醒"}`,
    `策略版本：${input.strategyVersion}　阶段：${phaseLabel(input.phase)}`,
    `提醒级别：${level.label}`,
    `动作：${actionLabel(input.action)}　结论：${input.decisionLabel}`,
    `策略档位：当前 ${position(input.currentPosition)} → 本批 ${position(input.executionTarget)}；战略目标 ${position(input.strategyTarget)}`,
    `固定预算：当前持仓成本 ¥${Math.round(input.strategyCostBasis).toLocaleString("zh-CN")} → 目标成本档位 ¥${Math.round(DIVIDEND_STRATEGY_CAPITAL * input.executionTarget).toLocaleString("zh-CN")}；初始本金 ¥${DIVIDEND_STRATEGY_CAPITAL.toLocaleString("zh-CN")}`,
    `本批估算：${executionEstimate(input)}`,
    `账户快照：ETF 市值 ¥${Math.round(input.marketValue).toLocaleString("zh-CN")}；账户权益 ¥${Math.round(input.accountEquity).toLocaleString("zh-CN")}；账本 v${input.accountLedgerVersion}`,
    `冷启动计时：${coldStart}　下一最晚节点：${nextDeadline}`,
    "",
    "**价格与时序**",
    `收盘 / MA250：¥${input.close.toFixed(3)} / ¥${input.ma250.toFixed(3)}`,
    `距年线：${naturalPercent(input.distance, 2)}　MA250 近 20 日斜率：${naturalPercent(input.slope20, 2)}`,
    `连续低于年线：${input.belowMaDays} 个交易日${input.belowMaSince ? `（自 ${input.belowMaSince}）` : ""}`,
    `较近 20 日低点反弹：${naturalPercent(input.rebound20Pct, 2)}`,
    "",
    "**已命中策略**",
    listLines(input.matchedRules, "暂无达到的买卖阈值；基础数据已完成复算"),
    "",
    "**未命中 / 阻挡条件**",
    listLines(input.pendingRules, "无额外阻挡条件"),
    "",
    "**卖出与风险控制**",
    sellGuidance(input),
    "",
    "**核心止盈观察（暂不自动执行）**",
    "• 连续 3 日距 MA250 ≥ +5%：观察 50% → 35%；回落至 +3% 内再恢复 50%",
    "• 连续 3 日距 MA250 ≥ +10%：观察 35% → 20%；回落至 +8% 内再恢复 35%",
    "• 该层在完整样本改善收益与回撤，但交易次数明显增加；历史股息利差尚未补齐，因此只提示人工确认",
    "",
    "**估值与利率因子**",
    `指数股息率：${naturalPercent(input.dividendYield)}${input.dividendDate ? `（${input.dividendDate}）` : ""}`,
    `十年国债：${naturalPercent(input.governmentBond10Y, 3)}${input.rateDate ? `（${input.rateDate}）` : ""}`,
    `股息利差：${naturalPercent(input.dividendSpread)}　因子仓位上限：${position(input.factorCap)}`,
    `因子模式：${factorModeLabel(input.factorMode)}；利率次源：${factorStatus}`,
    "",
    "**数据验证**",
    `行情：${marketStatus}`,
    `口径：前复权日线；服务器读取本地已发布版本并重新计算，浏览器不能指定信号、价格或目标仓位。`,
    "",
    "**执行口径**",
    isTest
      ? "本条仅测试消息链路，一分钟内相同测试会去重，不产生交易；正式提醒仍须服务器复算为新的买入批次。"
      : isLive
        ? "本条为策略提醒正式上线状态播报；如当前未触发买入，将如实显示等待，不会伪造交易信号。后续正式买入提醒仍须服务器复算为新的买入批次。"
        : isScheduled
          ? "本条由交易日 12:00 本地任务发送；只使用剔除当天午盘后的完整 T-1 日线。买入或卖出仍须人工确认，不连接券商。"
      : "按最新完整交易日日线确认信号，单次建议最多增加 25% 仓位；当前正式规则为 T 日收盘确认、计划 T+1 开盘人工执行。",
  ].join("\n");
  const note = isTest
    ? "测试消息｜展示真实行情与策略状态，但不会连接券商或产生订单；不构成投资建议。"
    : isLive
      ? "正式上线｜策略状态播报已启用；仅供研究与人工决策，不连接券商、不自动下单，不构成投资建议。"
      : isScheduled
        ? "交易日 12:00｜完整 T-1 日线状态；仅供研究与人工决策，不连接券商、不自动下单，不构成投资建议。"
    : "规则提醒｜仅供研究与人工决策，不连接券商、不自动下单，不构成投资建议。";
  return { title, markdown, note, template: isTest ? "blue" : level.template };
}

export async function sendFeishuTestAlert(input: FeishuStrategyAlert) {
  const content = buildFeishuStrategyAlertContent({ ...input, kind: "test" });
  await sendCard(content.title, content.markdown, content.note, content.template);
}

export async function sendFeishuBuyAlert(input: FeishuBuyAlert) {
  const content = buildFeishuStrategyAlertContent({ ...input, kind: "buy" });
  await sendCard(
    content.title,
    content.markdown,
    content.note,
    content.template,
  );
}

export async function sendFeishuSellAlert(input: FeishuStrategyAlert) {
  const content = buildFeishuStrategyAlertContent({ ...input, kind: "sell" });
  await sendCard(
    content.title,
    content.markdown,
    content.note,
    content.template,
  );
}

export async function sendFeishuLiveAlert(input: FeishuStrategyAlert) {
  const content = buildFeishuStrategyAlertContent({ ...input, kind: "live" });
  await sendCard(
    content.title,
    content.markdown,
    content.note,
    content.template,
  );
}

export async function sendFeishuScheduledAlert(input: FeishuStrategyAlert) {
  const content = buildFeishuStrategyAlertContent({ ...input, kind: "scheduled" });
  await sendCard(
    content.title,
    content.markdown,
    content.note,
    content.template,
  );
}
