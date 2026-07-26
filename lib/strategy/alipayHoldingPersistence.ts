import { env } from "cloudflare:workers";
import { ALIPAY_LINKED_FUND_CODE, alipayHoldingFingerprint, reconcileAlipayHolding, type AlipayHoldingSnapshot } from "./alipayHoldingImport";

type SnapshotRow = Omit<AlipayHoldingSnapshot, "nav" | "marketValue" | "holdingCost" | "holdingProfit" | "fundEAccountUnits" | "fundEAccountMarketValue"> & {
  nav: number | null; market_value: number | null; holding_cost: number | null; holding_profit: number | null;
  order_info: string | null; confirmation_info: string | null; file_hash: string | null; verification_status: AlipayHoldingSnapshot["verificationStatus"];
  verification_note: string | null; content_fingerprint: string; fund_e_account_units: number | null; fund_e_account_market_value: number | null; as_of_date: string; fund_code: "007467"; fund_name: string; created_at: string;
};
let schemaReady = false;
function database(): D1Database { if (!env.DB) throw new Error("支付宝持仓快照数据库尚未连接"); return env.DB; }
function mapSnapshot(row: SnapshotRow): AlipayHoldingSnapshot {
  return { id: row.id, source: row.source, asOfDate: row.as_of_date, fundCode: row.fund_code, fundName: row.fund_name, units: row.units, nav: row.nav, navDate: row.navDate, marketValue: row.market_value, holdingCost: row.holding_cost, holdingProfit: row.holding_profit, orderInfo: null, confirmationInfo: null, fileHash: row.file_hash, verificationStatus: row.verification_status, verificationNote: null, contentFingerprint: row.content_fingerprint ?? `legacy:${row.id}`, fundEAccountUnits: row.fund_e_account_units, fundEAccountMarketValue: row.fund_e_account_market_value, createdAt: row.created_at };
}
export async function ensureAlipayHoldingSchema() {
  if (schemaReady) return;
  await database().batch([
    database().prepare("CREATE TABLE IF NOT EXISTS alipay_holding_import_ledger (fund_code TEXT PRIMARY KEY, ledger_version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
    database().prepare("CREATE TABLE IF NOT EXISTS alipay_holding_snapshots (id TEXT PRIMARY KEY, source TEXT NOT NULL, as_of_date TEXT NOT NULL, fund_code TEXT NOT NULL, fund_name TEXT NOT NULL, units REAL NOT NULL, nav REAL, nav_date TEXT, market_value REAL, holding_cost REAL, holding_profit REAL, order_info TEXT, confirmation_info TEXT, file_hash TEXT, verification_status TEXT NOT NULL, verification_note TEXT, content_fingerprint TEXT, fund_e_account_units REAL, fund_e_account_market_value REAL, created_at TEXT NOT NULL)"),
    database().prepare("CREATE UNIQUE INDEX IF NOT EXISTS alipay_holding_snapshots_file_hash ON alipay_holding_snapshots(file_hash) WHERE file_hash IS NOT NULL"),
    database().prepare("CREATE INDEX IF NOT EXISTS alipay_holding_snapshots_timeline ON alipay_holding_snapshots(fund_code, as_of_date DESC, created_at DESC)"),
  ]);
  try { await database().prepare("SELECT content_fingerprint FROM alipay_holding_snapshots LIMIT 0").all(); }
  catch { await database().prepare("ALTER TABLE alipay_holding_snapshots ADD COLUMN content_fingerprint TEXT").run(); }
  await database().prepare("CREATE UNIQUE INDEX IF NOT EXISTS alipay_holding_snapshots_content_fingerprint ON alipay_holding_snapshots(content_fingerprint) WHERE content_fingerprint IS NOT NULL").run();
  const timestamp = new Date().toISOString();
  await database().prepare("INSERT OR IGNORE INTO alipay_holding_import_ledger (fund_code, ledger_version, created_at, updated_at) VALUES (?, 0, ?, ?)").bind(ALIPAY_LINKED_FUND_CODE, timestamp, timestamp).run();
  schemaReady = true;
}
export async function getAlipayHoldingSnapshotState() {
  await ensureAlipayHoldingSchema();
  const rows = await database().prepare("SELECT id, source, as_of_date, fund_code, fund_name, units, nav, nav_date AS navDate, market_value, holding_cost, holding_profit, order_info, confirmation_info, file_hash, verification_status, verification_note, content_fingerprint, fund_e_account_units, fund_e_account_market_value, created_at FROM alipay_holding_snapshots WHERE fund_code = ? ORDER BY as_of_date DESC, created_at DESC").bind(ALIPAY_LINKED_FUND_CODE).all<SnapshotRow>();
  const metadata = await database().prepare("SELECT ledger_version FROM alipay_holding_import_ledger WHERE fund_code = ?").bind(ALIPAY_LINKED_FUND_CODE).first<{ ledger_version: number }>();
  const snapshots = (rows.results ?? []).map(mapSnapshot).map((snapshot) => ({ ...snapshot, verificationStatus: reconcileAlipayHolding(snapshot).status }));
  return { snapshots, ledgerVersion: metadata?.ledger_version ?? 0 };
}
export async function insertAlipayHoldingSnapshot(snapshot: AlipayHoldingSnapshot, expectedLedgerVersion: number) {
  await ensureAlipayHoldingSchema();
  const timestamp = new Date().toISOString();
  const result = await database().batch([
    database().prepare("INSERT INTO alipay_holding_snapshots (id, source, as_of_date, fund_code, fund_name, units, nav, nav_date, market_value, holding_cost, holding_profit, order_info, confirmation_info, file_hash, verification_status, verification_note, content_fingerprint, fund_e_account_units, fund_e_account_market_value, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM alipay_holding_import_ledger WHERE fund_code = ? AND ledger_version = ?)").bind(snapshot.id, snapshot.source, snapshot.asOfDate, snapshot.fundCode, snapshot.fundName, snapshot.units, snapshot.nav, snapshot.navDate, snapshot.marketValue, snapshot.holdingCost, snapshot.holdingProfit, snapshot.orderInfo, snapshot.confirmationInfo, snapshot.fileHash, snapshot.verificationStatus, snapshot.verificationNote, snapshot.contentFingerprint || alipayHoldingFingerprint(snapshot), snapshot.fundEAccountUnits, snapshot.fundEAccountMarketValue, snapshot.createdAt, ALIPAY_LINKED_FUND_CODE, expectedLedgerVersion),
    database().prepare("UPDATE alipay_holding_import_ledger SET ledger_version = ledger_version + 1, updated_at = ? WHERE fund_code = ? AND ledger_version = ? AND changes() = 1").bind(timestamp, ALIPAY_LINKED_FUND_CODE, expectedLedgerVersion),
  ]);
  return (result[0].meta?.changes ?? 0) === 1 && (result[1].meta?.changes ?? 0) === 1;
}
