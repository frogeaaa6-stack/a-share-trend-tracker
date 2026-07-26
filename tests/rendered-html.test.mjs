import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the A-share research application", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.doesNotMatch(html, developmentPreviewMeta);
  assert.match(html, /<title>A股板块研究台｜行业强弱与策略回测<\/title>/i);
  assert.match(html, /真实数据与交叉验证/);
  assert.match(html, /我的自选跟踪/);
  assert.match(html, /红利低波ETF 华泰柏瑞/);
  assert.match(html, /加入跟踪/);
  assert.match(html, /策略实验室/);
  assert.match(html, /同步双源数据/);
  assert.match(html, /只有通过交叉验证的数据才会进入回测/);
  assert.match(html, /红利低波收益增强仓位/);
  assert.match(html, /512890\.SH/);
  assert.match(html, /T\+1 开盘人工执行/);
  assert.match(html, /红利低波独立实盘账户/);
  assert.match(html, /策略本金固定[\s\S]*50,000/);
  assert.match(html, /只使用完整 T-1 日线/);
  assert.match(html, /人工观察 · 核心止盈/);
  assert.match(html, /三指标历史位置/);
  assert.match(html, /这是 ETF 价格，不是官方基金净值；不以 007467 净值替代/);
  assert.match(html, /双因子（价格＋波动率）影子观察/);
  assert.match(html, /研究观察，不改变实盘仓位，不发送飞书/);
});

test("keeps data provenance and current metadata explicit", async () => {
  const [page, layout, tracker] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/TrackerApp.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /import TrackerApp/);
  assert.match(page, /<TrackerApp \/>/);
  assert.match(layout, /generateMetadata/);
  assert.match(layout, /A股板块研究台｜行业强弱与策略回测/);
  assert.doesNotMatch(layout, /codex-preview|Starter Project/);
  assert.match(tracker, /fetch\("\/api\/market\/sync"/);
  assert.match(tracker, /a-share-tracker\.watchlist\.v1/);
  assert.match(tracker, /window\.confirm/);
  assert.match(tracker, /validation\.verified/);
  assert.match(tracker, /真实数据须双源验证后才会进入回测/);
  assert.match(tracker, /T\+1 日 open 成交/);
  assert.match(tracker, /fetchValidatedMarket\("512890\.SH", 2000, 270, true\)/);
  assert.match(tracker, /backtestDividendLadder/);
  assert.match(tracker, /\/api\/strategy\/dividend-account/);
  assert.match(tracker, /DIVIDEND_STRATEGY_CAPITAL/);
  assert.match(tracker, /expectedLedgerVersion/);
  assert.match(tracker, /idempotencyKey/);
  assert.match(tracker, /\/api\/factors\/dividend-ladder\/history/);
  assert.match(tracker, /computePriceVolatilityRegimes/);
});
