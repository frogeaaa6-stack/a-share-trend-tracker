import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Immutable ingestion attempt. Source payloads and validation results point here. */
export const marketRuns = sqliteTable("market_runs", {
  id: text("id").primaryKey(),
  symbol: text("symbol").notNull(),
  adjustment: text("adjustment").notNull(),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  status: text("status").notNull(),
});

/** Raw third-party responses retained for audit/replay. */
export const marketSourceSnapshots = sqliteTable("market_source_snapshots", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  provider: text("provider").notNull(),
  fetchedAt: text("fetched_at").notNull(),
  requestUrl: text("request_url").notNull(),
  payloadJson: text("payload_json"),
  payloadHash: text("payload_hash"),
  error: text("error"),
});

/** Bars that survived format, OHLC, duplicate-date and cross-source validation. */
export const marketBars = sqliteTable(
  "market_bars",
  {
    runId: text("run_id").notNull(),
    date: text("date").notNull(),
    open: real("open").notNull(),
    high: real("high").notNull(),
    low: real("low").notNull(),
    close: real("close").notNull(),
    volume: real("volume").notNull(),
    amount: real("amount"),
  },
  (table) => [primaryKey({ columns: [table.runId, table.date] })],
);

export const marketIssues = sqliteTable("market_issues", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  code: text("code").notNull(),
  severity: text("severity").notNull(),
  date: text("date"),
  message: text("message").notNull(),
  detailsJson: text("details_json"),
});

/** Published immutable version; history reads only these verified datasets. */
export const marketDatasets = sqliteTable("market_datasets", {
  id: text("id").primaryKey(),
  symbol: text("symbol").notNull(),
  adjustment: text("adjustment").notNull(),
  version: integer("version").notNull(),
  runId: text("run_id").notNull(),
  hash: text("hash").notNull(),
  createdAt: text("created_at").notNull(),
  qualityJson: text("quality_json").notNull(),
});

/** Fixed-capital live account for the separately managed 512890 strategy. */
export const dividendStrategyAccounts = sqliteTable("dividend_strategy_accounts", {
  strategyKey: text("strategy_key").primaryKey(),
  totalCapital: real("total_capital").notNull(),
  ledgerVersion: integer("ledger_version").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Append-only broker fills supplied by the user; no simulated trades belong here. */
export const dividendStrategyTrades = sqliteTable("dividend_strategy_trades", {
  id: text("id").primaryKey(),
  strategyKey: text("strategy_key").notNull(),
  tradeDate: text("trade_date").notNull(),
  side: text("side").notNull(),
  price: real("price").notNull(),
  units: integer("units").notNull(),
  amount: real("amount"),
  fee: real("fee").notNull().default(0),
  note: text("note").notNull().default(""),
  createdAt: text("created_at").notNull(),
});

/** Immutable, user-supplied read-only snapshot of the 007467 Alipay/Ant Fortune holding. */
export const alipayHoldingImportLedger = sqliteTable("alipay_holding_import_ledger", {
  fundCode: text("fund_code").primaryKey(),
  ledgerVersion: integer("ledger_version").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const alipayHoldingSnapshots = sqliteTable("alipay_holding_snapshots", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  asOfDate: text("as_of_date").notNull(),
  fundCode: text("fund_code").notNull(),
  fundName: text("fund_name").notNull(),
  units: real("units").notNull(),
  nav: real("nav"),
  navDate: text("nav_date"),
  marketValue: real("market_value"),
  holdingCost: real("holding_cost"),
  holdingProfit: real("holding_profit"),
  orderInfo: text("order_info"),
  confirmationInfo: text("confirmation_info"),
  fileHash: text("file_hash"),
  verificationStatus: text("verification_status").notNull(),
  verificationNote: text("verification_note"),
  contentFingerprint: text("content_fingerprint"),
  fundEAccountUnits: real("fund_e_account_units"),
  fundEAccountMarketValue: real("fund_e_account_market_value"),
  createdAt: text("created_at").notNull(),
});
