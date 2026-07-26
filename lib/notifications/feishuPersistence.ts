import { env } from "cloudflare:workers";

const claimedInProcess = new Set<string>();
const deliveredInProcess = new Set<string>();
let schemaReady = false;

function database() {
  return env.DB;
}

async function ensureSchema() {
  if (schemaReady) return;
  await database().prepare(
    "CREATE TABLE IF NOT EXISTS feishu_alert_deliveries (dedupe_key TEXT PRIMARY KEY, symbol TEXT NOT NULL, strategy TEXT NOT NULL, execution_target REAL NOT NULL, signal_date TEXT NOT NULL, status TEXT NOT NULL, claimed_at TEXT NOT NULL, sent_at TEXT, error TEXT)",
  ).run();
  schemaReady = true;
}

export async function claimFeishuAlert(input: {
  dedupeKey: string;
  symbol: string;
  strategy: string;
  executionTarget: number;
  signalDate: string;
}) {
  if (claimedInProcess.has(input.dedupeKey) || deliveredInProcess.has(input.dedupeKey)) return false;
  try {
    await ensureSchema();
    const claimedAt = new Date().toISOString();
    const leaseCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const reclaimed = await database().prepare(
      "UPDATE feishu_alert_deliveries SET status = 'pending', claimed_at = ?, sent_at = NULL, error = NULL WHERE dedupe_key = ? AND (status = 'failed' OR (status = 'pending' AND claimed_at < ?))",
    ).bind(claimedAt, input.dedupeKey, leaseCutoff).run();
    if ((reclaimed.meta?.changes ?? 0) > 0) {
      claimedInProcess.add(input.dedupeKey);
      return true;
    }
    const result = await database().prepare(
      "INSERT OR IGNORE INTO feishu_alert_deliveries (dedupe_key, symbol, strategy, execution_target, signal_date, status, claimed_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
    ).bind(
      input.dedupeKey,
      input.symbol,
      input.strategy,
      input.executionTarget,
      input.signalDate,
      claimedAt,
    ).run();
    const claimed = (result.meta?.changes ?? 0) > 0;
    if (claimed) claimedInProcess.add(input.dedupeKey);
    return claimed;
  } catch (error) {
    throw new Error(`飞书提醒去重账本不可用，已停止外发：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

export async function markFeishuAlertSending(dedupeKey: string) {
  try {
    await ensureSchema();
    const result = await database().prepare(
      "UPDATE feishu_alert_deliveries SET status = 'sending', error = NULL WHERE dedupe_key = ? AND status = 'pending'",
    ).bind(dedupeKey).run();
    if ((result.meta?.changes ?? 0) === 1) return;
    claimedInProcess.delete(dedupeKey);
    throw new Error("飞书提醒无法进入发送中状态，已停止外发");
  } catch (error) {
    claimedInProcess.delete(dedupeKey);
    throw error;
  }
}

export async function markFeishuAlertSent(dedupeKey: string) {
  try {
    await ensureSchema();
    const result = await database().prepare(
      "UPDATE feishu_alert_deliveries SET status = 'sent', sent_at = ?, error = NULL WHERE dedupe_key = ?",
    ).bind(new Date().toISOString(), dedupeKey).run();
    const confirmed = (result.meta?.changes ?? 0) === 1;
    claimedInProcess.delete(dedupeKey);
    deliveredInProcess.add(dedupeKey);
    return confirmed;
  } catch {
    claimedInProcess.delete(dedupeKey);
    deliveredInProcess.add(dedupeKey);
    // The durable row remains `sending`, which is intentionally never
    // auto-reclaimed. This favors one missed reminder over a duplicate card.
    return false;
  }
}

export async function markFeishuAlertFailed(dedupeKey: string, error: string) {
  claimedInProcess.delete(dedupeKey);
  try {
    await ensureSchema();
    await database().prepare(
      "UPDATE feishu_alert_deliveries SET status = 'failed', error = ? WHERE dedupe_key = ?",
    ).bind(error.slice(0, 500), dedupeKey).run();
  } catch {
    // A failed alert is not marked delivered in memory.
  }
}

export async function markFeishuAlertUncertain(dedupeKey: string, error: string) {
  claimedInProcess.delete(dedupeKey);
  deliveredInProcess.add(dedupeKey);
  try {
    await ensureSchema();
    await database().prepare(
      "UPDATE feishu_alert_deliveries SET status = 'uncertain', error = ? WHERE dedupe_key = ?",
    ).bind(error.slice(0, 500), dedupeKey).run();
  } catch {
    // The previous durable state is `sending`, which is also non-retriable.
  }
}

export async function wasFeishuAlertDelivered(dedupeKey: string) {
  if (deliveredInProcess.has(dedupeKey)) return true;
  try {
    await ensureSchema();
    const row = await database().prepare(
      "SELECT status FROM feishu_alert_deliveries WHERE dedupe_key = ? LIMIT 1",
    ).bind(dedupeKey).first<{ status: string }>();
    if (row?.status === "sent") deliveredInProcess.add(dedupeKey);
    return row?.status === "sent";
  } catch {
    return claimedInProcess.has(dedupeKey);
  }
}

export async function rememberFeishuAlert(input: {
  dedupeKey: string;
}) {
  claimedInProcess.delete(input.dedupeKey);
  deliveredInProcess.add(input.dedupeKey);
}
