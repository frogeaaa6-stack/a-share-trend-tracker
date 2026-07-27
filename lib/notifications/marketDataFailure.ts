import {
  FeishuDeliveryUncertainError,
  sendFeishuMarketDataFailureAlert,
  type FeishuMarketDataFailureAlert,
} from "./feishu";
import {
  claimFeishuAlert,
  markFeishuAlertFailed,
  markFeishuAlertSending,
  markFeishuAlertSent,
  markFeishuAlertUncertain,
} from "./feishuPersistence";

export type MarketDataAlertDelivery = {
  sent: boolean;
  deduplicated: boolean;
  auditConfirmed?: boolean;
  status: "sent" | "deduplicated" | "failed" | "uncertain";
  error?: string;
};

export async function deliverFeishuMarketDataFailureAlert(alert: FeishuMarketDataFailureAlert): Promise<MarketDataAlertDelivery> {
  const dedupeKey = ["feishu-market-source-v1", "scheduled", alert.symbol, alert.shanghaiDate].join("|");
  const claimed = await claimFeishuAlert({
    dedupeKey,
    symbol: alert.symbol,
    strategy: `market-data-pipeline-v1:${alert.runId}`,
    executionTarget: 0,
    signalDate: alert.shanghaiDate,
  });
  if (!claimed) return { sent: false, deduplicated: true, status: "deduplicated" };
  await markFeishuAlertSending(dedupeKey);
  try {
    await sendFeishuMarketDataFailureAlert(alert);
    const auditConfirmed = await markFeishuAlertSent(dedupeKey);
    return { sent: true, deduplicated: false, auditConfirmed, status: "sent" };
  } catch (error) {
    const failure = error instanceof Error ? error.message : "飞书数据链路故障提醒发送失败";
    if (error instanceof FeishuDeliveryUncertainError) {
      await markFeishuAlertUncertain(dedupeKey, failure);
      return { sent: false, deduplicated: false, status: "uncertain", error: failure };
    }
    await markFeishuAlertFailed(dedupeKey, failure);
    return { sent: false, deduplicated: false, status: "failed", error: failure };
  }
}
