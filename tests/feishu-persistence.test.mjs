import assert from "node:assert/strict";
import test from "node:test";
import { env } from "cloudflare:workers";
import {
  claimFeishuAlert,
  markFeishuAlertFailed,
  markFeishuAlertSending,
  markFeishuAlertSent,
  markFeishuAlertUncertain,
} from "../lib/notifications/feishuPersistence.ts";

class FakeStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  run() {
    return this.database.run(this.sql, this.args);
  }
}

class FakeDatabase {
  rows = new Map();
  statements = [];
  failSentUpdate = false;

  prepare(sql) {
    const statement = new FakeStatement(this, sql);
    this.statements.push(statement);
    return statement;
  }

  run(sql, args) {
    if (sql.startsWith("CREATE TABLE")) return { meta: { changes: 0 } };
    if (sql.includes("SET status = 'pending'")) {
      const row = this.rows.get(args[1]);
      if (row && (row.status === "failed" || row.status === "pending")) {
        row.status = "pending";
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (sql.startsWith("INSERT OR IGNORE")) {
      if (this.rows.has(args[0])) return { meta: { changes: 0 } };
      this.rows.set(args[0], { status: "pending" });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("SET status = 'sending'")) {
      const row = this.rows.get(args[0]);
      if (!row || row.status !== "pending") return { meta: { changes: 0 } };
      row.status = "sending";
      return { meta: { changes: 1 } };
    }
    if (sql.includes("SET status = 'sent'")) {
      if (this.failSentUpdate) throw new Error("fixture D1 outage");
      const row = this.rows.get(args[1]);
      if (!row) return { meta: { changes: 0 } };
      row.status = "sent";
      return { meta: { changes: 1 } };
    }
    if (sql.includes("SET status = 'failed'")) {
      const row = this.rows.get(args[1]);
      if (!row) return { meta: { changes: 0 } };
      row.status = "failed";
      return { meta: { changes: 1 } };
    }
    if (sql.includes("SET status = 'uncertain'")) {
      const row = this.rows.get(args[1]);
      if (!row) return { meta: { changes: 0 } };
      row.status = "uncertain";
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unhandled fixture SQL: ${sql}`);
  }
}

const claim = (dedupeKey) => claimFeishuAlert({
  dedupeKey,
  symbol: "512890.SH",
  strategy: "fixture",
  executionTarget: .75,
  signalDate: "2026-07-24",
});

test("retries only definitive failures and never auto-retries uncertain sends", async () => {
  const database = new FakeDatabase();
  env.DB = database;

  assert.equal(await claim("failed-key"), true);
  await markFeishuAlertSending("failed-key");
  await markFeishuAlertFailed("failed-key", "explicit provider rejection");
  assert.equal(await claim("failed-key"), true);

  assert.equal(await claim("uncertain-key"), true);
  await markFeishuAlertSending("uncertain-key");
  await markFeishuAlertUncertain("uncertain-key", "timeout after request dispatch");
  assert.equal(database.rows.get("uncertain-key").status, "uncertain");
  assert.equal(await claim("uncertain-key"), false);

  assert.equal(await claim("audit-key"), true);
  await markFeishuAlertSending("audit-key");
  database.failSentUpdate = true;
  assert.equal(await markFeishuAlertSent("audit-key"), false);
  assert.equal(database.rows.get("audit-key").status, "sending");
  assert.equal(await claim("audit-key"), false);
});
