import assert from "node:assert/strict";
import test from "node:test";
import { buildFeishuMarketDataFailureAlertContent } from "../lib/notifications/feishu.ts";
import { shouldAlertOnSourceFailure } from "../lib/market/syncPolicy.ts";

test("builds a red market-data failure card with diagnostic details but no trade payload", () => {
  const content = buildFeishuMarketDataFailureAlertContent({
    symbol: "512890.SH",
    shanghaiDate: "2026-07-27",
    runId: "run-123",
    failedSources: [{ provider: "eastmoney", message: "upstream request failed", attempts: 3, code: "NETWORK_ERROR", cause: "UND_ERR_SOCKET: other side closed" }],
    successfulSources: ["tencent"],
    lastVerified: { version: 18, asOf: "2026-07-24" },
  });
  assert.equal(content.template, "red");
  assert.match(content.title, /数据链路异常/);
  assert.match(content.markdown, /run-123[\s\S]*eastmoney[\s\S]*已尝试 3 次/);
  assert.match(content.markdown, /本次未生成任何买入或卖出建议，请勿依据旧数据交易/);
  assert.doesNotMatch(`${content.title}\n${content.markdown}\n${content.note}`, /仓位|目标|¥|收盘/);
});

test("source failure alert is limited to explicitly scheduled complete-only requests", () => {
  assert.equal(shouldAlertOnSourceFailure({ completeOnly: true, purpose: "scheduled", notifyOnSourceFailure: true, rejectedSourceCount: 1 }), true);
  assert.equal(shouldAlertOnSourceFailure({ completeOnly: false, purpose: "scheduled", notifyOnSourceFailure: true, rejectedSourceCount: 1 }), false);
  assert.equal(shouldAlertOnSourceFailure({ completeOnly: true, purpose: "scheduled", notifyOnSourceFailure: false, rejectedSourceCount: 1 }), false);
  assert.equal(shouldAlertOnSourceFailure({ completeOnly: true, purpose: "manual", notifyOnSourceFailure: true, rejectedSourceCount: 1 }), false);
  assert.equal(shouldAlertOnSourceFailure({ completeOnly: true, purpose: "scheduled", notifyOnSourceFailure: true, rejectedSourceCount: 0 }), false);
});
