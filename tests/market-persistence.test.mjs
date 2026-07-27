import assert from "node:assert/strict";
import test from "node:test";
import { env } from "cloudflare:workers";
import { getLatestVerifiedNoonSnapshot, publishDataset, publishNoonSnapshot, saveIssues } from "../lib/market/persistence.ts";

class FakeStatement {
  constructor(sql) {
    this.sql = sql;
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  async run() {
    return { meta: { changes: 1 } };
  }
}

test("publishes more than 1,000 bars with two set-based D1 statements", async () => {
  let batch = [];
  const prepared = [];
  env.DB = {
    prepare(sql) {
      const statement = new FakeStatement(sql);
      prepared.push(statement);
      return statement;
    },
    async batch(statements) {
      batch = statements;
      return [{ results: [{ version: 7 }] }, { meta: { changes: 1_205 } }];
    },
  };

  const start = new Date("2021-01-01T00:00:00Z");
  const bars = Array.from({ length: 1_205 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    const close = 1 + index / 10_000;
    return {
      date: date.toISOString().slice(0, 10),
      open: close,
      high: close + .01,
      low: close - .01,
      close,
      volume: 1_000_000 + index,
      amount: 2_000_000 + index,
    };
  });
  const result = await publishDataset(
    "run-large",
    "512890.SH",
    {
      verified: true,
      bars,
      quality: {
        score: 100,
        grade: "A",
        coverage: 100,
        overlapDays: bars.length,
        matchedDays: bars.length,
        conflictDays: 0,
        agreementPct: 100,
        maxPriceDiffBps: 0,
      },
      issues: [],
    },
    [
      { provider: "eastmoney", status: "ok", barCount: bars.length },
      { provider: "tencent", status: "ok", barCount: bars.length },
    ],
  );

  assert.equal(batch.length, 2);
  assert.match(batch[0].sql, /RETURNING version/);
  assert.match(batch[1].sql, /json_each\(\?\)/);
  assert.equal(JSON.parse(batch[1].args[1]).length, bars.length);
  assert.equal(result.dataset.version, 7);
  assert.equal(result.bars.length, bars.length);

  const issues = Array.from({ length: 1_205 }, (_, index) => ({
    code: "FIXTURE",
    severity: "warning",
    date: bars[index].date,
    message: `issue-${index}`,
  }));
  await saveIssues("run-large", issues);
  const issueInsert = prepared.at(-1);
  assert.match(issueInsert.sql, /FROM json_each\(\?\)/);
  assert.equal(JSON.parse(issueInsert.args[1]).length, issues.length);
});

test("persists a verified noon snapshot independently and never inserts it into market_bars", async () => {
  const prepared = [];
  const row = {
    id: "noon-1", symbol: "512890.SH", date: "2026-07-27", snapshot_time: "11:30", run_id: "run-noon", hash: "hash", created_at: "2026-07-27T03:30:00.000Z",
    open: 1.161, high: 1.168, low: 1.158, close: 1.163, volume: 3_855_425, amount: 448_280_357,
    quality_json: JSON.stringify({ quality: { score: 90, grade: "B", coverage: 100, overlapDays: 1, matchedDays: 1, conflictDays: 0, agreementPct: 100, maxPriceDiffBps: 17 }, issues: [{ code: "NOON_OHLC_WARNING", severity: "warning", message: "fixture" }] }),
  };
  env.DB = {
    prepare(sql) {
      const statement = new FakeStatement(sql);
      statement.first = async () => row;
      prepared.push(statement);
      return statement;
    },
  };

  const validation = {
    verified: true,
    snapshot: { date: "2026-07-27", snapshotTime: "11:30", provider: "eastmoney", rowCount: 121, open: 1.161, high: 1.168, low: 1.158, close: 1.163, volume: 3_855_425, amount: 448_280_357 },
    quality: { score: 90, grade: "B", coverage: 100, overlapDays: 1, matchedDays: 1, conflictDays: 0, agreementPct: 100, maxPriceDiffBps: 17 },
    issues: [{ code: "NOON_OHLC_WARNING", severity: "warning", message: "fixture" }],
    sources: [],
  };
  const published = await publishNoonSnapshot("run-noon", "512890.SH", validation);
  const loaded = await getLatestVerifiedNoonSnapshot("512890.SH", "2026-07-27");
  const sql = prepared.map((statement) => statement.sql).join("\n");

  assert.match(sql, /INSERT INTO market_noon_snapshots/);
  assert.match(sql, /FROM market_noon_snapshots/);
  assert.doesNotMatch(sql, /market_bars/);
  assert.equal(published.snapshot.close, 1.163);
  assert.equal(loaded?.snapshot.close, 1.163);
  assert.equal(loaded?.snapshot.provider, "eastmoney");
  assert.equal(loaded?.validation.quality.grade, "B");
});
