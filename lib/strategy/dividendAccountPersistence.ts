import { env } from "cloudflare:workers";
import {
  DIVIDEND_STRATEGY_CAPITAL,
  DIVIDEND_STRATEGY_KEY,
  type DividendAccountTrade,
} from "./dividendAccount";

type TradeRow = {
  id: string;
  trade_date: string;
  side: "buy" | "sell" | "dividend";
  price: number;
  units: number;
  amount: number | null;
  fee: number;
  note: string;
  created_at: string;
};
type AccountRow = { total_capital: number; ledger_version: number; created_at: string };

let schemaReady = false;

function database(): D1Database {
  if (!env.DB) throw new Error("实盘账本数据库尚未连接");
  return env.DB;
}

export async function ensureDividendAccountSchema() {
  if (schemaReady) return;
  await database().batch([
    database().prepare(
      "CREATE TABLE IF NOT EXISTS dividend_strategy_accounts (strategy_key TEXT PRIMARY KEY, total_capital REAL NOT NULL, ledger_version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    ),
    database().prepare(
      "CREATE TABLE IF NOT EXISTS dividend_strategy_trades (id TEXT PRIMARY KEY, strategy_key TEXT NOT NULL, trade_date TEXT NOT NULL, side TEXT NOT NULL, price REAL NOT NULL, units INTEGER NOT NULL, amount REAL, fee REAL NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)",
    ),
    database().prepare(
      "CREATE INDEX IF NOT EXISTS dividend_strategy_trades_timeline ON dividend_strategy_trades(strategy_key, trade_date, created_at)",
    ),
  ]);
  try {
    await database().prepare("SELECT ledger_version FROM dividend_strategy_accounts LIMIT 0").all();
  } catch {
    await database().prepare("ALTER TABLE dividend_strategy_accounts ADD COLUMN ledger_version INTEGER NOT NULL DEFAULT 0").run();
  }
  try {
    await database().prepare("SELECT amount FROM dividend_strategy_trades LIMIT 0").all();
  } catch {
    await database().prepare("ALTER TABLE dividend_strategy_trades ADD COLUMN amount REAL").run();
  }
  const timestamp = new Date().toISOString();
  await database().prepare(
    "INSERT OR IGNORE INTO dividend_strategy_accounts (strategy_key, total_capital, ledger_version, created_at, updated_at) VALUES (?, ?, 0, ?, ?)",
  ).bind(DIVIDEND_STRATEGY_KEY, DIVIDEND_STRATEGY_CAPITAL, timestamp, timestamp).run();
  schemaReady = true;
}

function toTrade(row: TradeRow): DividendAccountTrade {
  return {
    id: row.id,
    tradeDate: row.trade_date,
    side: row.side,
    price: row.price,
    units: row.units,
    amount: row.amount,
    fee: row.fee,
    note: row.note,
    createdAt: row.created_at,
  };
}

export async function listDividendAccountTrades() {
  await ensureDividendAccountSchema();
  const response = await database().prepare(
    "SELECT id, trade_date, side, price, units, amount, fee, note, created_at FROM dividend_strategy_trades WHERE strategy_key = ? ORDER BY trade_date ASC, created_at ASC, id ASC",
  ).bind(DIVIDEND_STRATEGY_KEY).all<TradeRow>();
  return (response.results ?? []).map(toTrade);
}

export async function getDividendAccountMetadata() {
  await ensureDividendAccountSchema();
  const row = await database().prepare(
    "SELECT total_capital, ledger_version, created_at FROM dividend_strategy_accounts WHERE strategy_key = ? LIMIT 1",
  ).bind(DIVIDEND_STRATEGY_KEY).first<AccountRow>();
  if (!row) throw new Error("实盘账户尚未初始化");
  return { totalCapital: row.total_capital, ledgerVersion: row.ledger_version, createdAt: row.created_at };
}

export async function getDividendAccountSnapshot() {
  await ensureDividendAccountSchema();
  const results = await database().batch([
    database().prepare(
      "SELECT id, trade_date, side, price, units, amount, fee, note, created_at FROM dividend_strategy_trades WHERE strategy_key = ? ORDER BY trade_date ASC, created_at ASC, id ASC",
    ).bind(DIVIDEND_STRATEGY_KEY),
    database().prepare(
      "SELECT total_capital, ledger_version, created_at FROM dividend_strategy_accounts WHERE strategy_key = ? LIMIT 1",
    ).bind(DIVIDEND_STRATEGY_KEY),
  ]);
  const trades = ((results[0].results ?? []) as TradeRow[]).map(toTrade);
  const row = (results[1].results?.[0] ?? null) as AccountRow | null;
  if (!row) throw new Error("实盘账户尚未初始化");
  return {
    trades,
    metadata: { totalCapital: row.total_capital, ledgerVersion: row.ledger_version, createdAt: row.created_at },
  };
}

export async function insertDividendAccountTrade(trade: DividendAccountTrade, expectedLedgerVersion: number) {
  await ensureDividendAccountSchema();
  const timestamp = new Date().toISOString();
  const results = await database().batch([
    database().prepare(
      "INSERT INTO dividend_strategy_trades (id, strategy_key, trade_date, side, price, units, amount, fee, note, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM dividend_strategy_accounts WHERE strategy_key = ? AND ledger_version = ?)",
    ).bind(
      trade.id,
      DIVIDEND_STRATEGY_KEY,
      trade.tradeDate,
      trade.side,
      trade.price,
      trade.units,
      trade.amount,
      trade.fee,
      trade.note,
      trade.createdAt,
      DIVIDEND_STRATEGY_KEY,
      expectedLedgerVersion,
    ),
    database().prepare(
      "UPDATE dividend_strategy_accounts SET ledger_version = ledger_version + 1, updated_at = ? WHERE strategy_key = ? AND ledger_version = ? AND changes() = 1 AND EXISTS (SELECT 1 FROM dividend_strategy_trades WHERE id = ? AND strategy_key = ?)",
    ).bind(timestamp, DIVIDEND_STRATEGY_KEY, expectedLedgerVersion, trade.id, DIVIDEND_STRATEGY_KEY),
  ]);
  return (results[0].meta?.changes ?? 0) === 1 && (results[1].meta?.changes ?? 0) === 1;
}
