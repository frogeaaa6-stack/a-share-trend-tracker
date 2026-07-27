import assert from "node:assert/strict";
import test from "node:test";
import { fetchEastmoney, fetchTencent, getJsonWithRetry, ProviderError } from "../lib/market/providers.ts";

const eastFixture = { data: { klines: ["2026-07-24,1,1.1,1.2,.9,100,110"] } };
const tencentPage = (date) => ({ data: { sh510300: { qfqday: [[date, 1, 1.1, 1.2, .9, 100]] } } });
const response = (body, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("retries two network failures then succeeds on the third request", async () => {
  let calls = 0;
  const waits = [];
  const result = await fetchEastmoney("510300.SH", 30, {
    fetch: async () => { calls += 1; if (calls < 3) { const error = new Error("other side closed"); error.code = "UND_ERR_SOCKET"; throw error; } return response(eastFixture); },
    sleep: async (ms) => { waits.push(ms); },
  });
  assert.equal(calls, 3);
  assert.equal(result.attempts, 3);
  assert.deepEqual(waits, [300, 900]);
});

test("retries 429 and 503 but does not retry a deterministic 400", async () => {
  let calls = 0;
  const result = await getJsonWithRetry("https://fixture.test/data", "eastmoney", (raw) => raw, {
    fetch: async () => { calls += 1; return response(calls < 3 ? {} : eastFixture, calls === 1 ? 429 : calls === 2 ? 503 : 200); },
    sleep: async () => {},
  });
  assert.equal(result.attempts, 3);
  calls = 0;
  await assert.rejects(
    () => getJsonWithRetry("https://fixture.test/data", "eastmoney", (raw) => raw, { fetch: async () => { calls += 1; return response({}, 400); }, sleep: async () => {} }),
    (error) => error instanceof ProviderError && error.code === "HTTP_400" && error.attempts === 1 && error.retryable === false,
  );
  assert.equal(calls, 1);
});

test("keeps terminal provider cause and attempt count for diagnostics", async () => {
  await assert.rejects(
    () => fetchEastmoney("510300.SH", 30, {
      fetch: async () => { const cause = new Error("other side closed"); cause.code = "UND_ERR_SOCKET"; throw new TypeError("fetch failed", { cause }); },
      sleep: async () => {},
    }),
    (error) => error instanceof ProviderError
      && error.attempts === 3
      && error.code === "NETWORK_ERROR"
      && error.causeSummary.includes("UND_ERR_SOCKET")
      && error.causeSummary.includes("other side closed"),
  );
});

test("retries only Tencent's failing later page and does not refetch an accepted page", async () => {
  const urls = [];
  let secondPageCalls = 0;
  const result = await fetchTencent("510300.SH", 2, {
    fetch: async (url) => {
      urls.push(String(url));
      if (urls.length === 1) return response(tencentPage("2026-07-24"));
      secondPageCalls += 1;
      if (secondPageCalls === 1) return response({}, 503);
      return response(tencentPage("2026-07-23"));
    },
    sleep: async () => {},
  });
  assert.equal(result.bars.length, 2);
  assert.equal(result.attempts, 3);
  assert.equal(urls.filter((url) => url.includes("2026-07-23")).length, 2);
  assert.equal(urls.filter((url) => !url.includes("2026-07-23")).length, 1);
});
