import { env } from "cloudflare:workers";
import { ADJUSTMENT, type MarketBar, type MarketIssue, type Quality, type SourceStatus, type ValidationResult } from "./types";

type D1Result<T> = { results?: T[] };
type DatasetRow = { id: string; symbol: string; adjustment: string; version: number; run_id: string; hash: string; created_at: string; quality_json: string };
type BarRow = { date: string; open: number; high: number; low: number; close: number; volume: number; amount: number | null };

const SCHEMA_SQL = [
  "CREATE TABLE IF NOT EXISTS market_runs (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, adjustment TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, status TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS market_source_snapshots (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, provider TEXT NOT NULL, fetched_at TEXT NOT NULL, request_url TEXT NOT NULL, payload_json TEXT, payload_hash TEXT, error TEXT)",
  "CREATE TABLE IF NOT EXISTS market_bars (run_id TEXT NOT NULL, date TEXT NOT NULL, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL, amount REAL, PRIMARY KEY (run_id, date))",
  "CREATE TABLE IF NOT EXISTS market_issues (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, code TEXT NOT NULL, severity TEXT NOT NULL, date TEXT, message TEXT NOT NULL, details_json TEXT)",
  "CREATE TABLE IF NOT EXISTS market_datasets (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, adjustment TEXT NOT NULL, version INTEGER NOT NULL, run_id TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL, quality_json TEXT NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS market_dataset_versions ON market_datasets(symbol, adjustment, version)",
  "CREATE INDEX IF NOT EXISTS market_datasets_latest ON market_datasets(symbol, adjustment, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS market_bars_run_date ON market_bars(run_id, date)",
];

let schemaReady = false;

function db(): D1Database {
  if (!env.DB) throw new Error("D1 binding `DB` is unavailable. Configure `.openai/hosting.json` with `d1: DB`.");
  return env.DB;
}

function now() { return new Date().toISOString(); }
function id() { return crypto.randomUUID(); }

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function ensureMarketSchema() {
  if (schemaReady) return;
  await db().batch(SCHEMA_SQL.map((statement) => db().prepare(statement)));
  schemaReady = true;
}

export async function createRun(symbol: string) {
  const runId = id();
  await db().prepare("INSERT INTO market_runs (id, symbol, adjustment, started_at, status) VALUES (?, ?, ?, ?, ?)")
    .bind(runId, symbol, ADJUSTMENT, now(), "running").run();
  return runId;
}

export async function saveSnapshot(runId: string, input: { provider: string; requestUrl: string; raw?: unknown; error?: string }) {
  const payloadJson = input.raw === undefined ? null : JSON.stringify(input.raw);
  const payloadHash = payloadJson ? await digest(payloadJson) : null;
  await db().prepare("INSERT INTO market_source_snapshots (id, run_id, provider, fetched_at, request_url, payload_json, payload_hash, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id(), runId, input.provider, now(), input.requestUrl, payloadJson, payloadHash, input.error ?? null).run();
}

export async function saveIssues(runId: string, issues: MarketIssue[]) {
  if (!issues.length) return;
  const issuesJson = JSON.stringify(issues.map((issue) => ({
    id: id(),
    code: issue.code,
    severity: issue.severity,
    date: issue.date ?? null,
    message: issue.message,
    detailsJson: issue.details ? JSON.stringify(issue.details) : null,
  })));
  await db().prepare(
    "INSERT INTO market_issues (id, run_id, code, severity, date, message, details_json) SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.code'), json_extract(value, '$.severity'), json_extract(value, '$.date'), json_extract(value, '$.message'), json_extract(value, '$.detailsJson') FROM json_each(?)",
  ).bind(runId, issuesJson).run();
}

export async function finishRun(runId: string, status: "published" | "failed") {
  await db().prepare("UPDATE market_runs SET status = ?, completed_at = ? WHERE id = ?").bind(status, now(), runId).run();
}

export type PublishedDataset = {
  dataset: { symbol: string; adjustment: "qfq"; version: number; hash: string; createdAt: string; runId: string };
  bars: MarketBar[];
  validation: { verified: true; quality: Quality; issues: MarketIssue[]; sources: SourceStatus[] };
};

export async function publishDataset(runId: string, symbol: string, validation: ValidationResult, sources: SourceStatus[]): Promise<PublishedDataset> {
  const createdAt = now();
  const hash = await digest(JSON.stringify({ symbol, adjustment: ADJUSTMENT, bars: validation.bars }));
  const datasetId = id();
  const qualityJson = JSON.stringify({ quality: validation.quality, issues: validation.issues, sources });
  const barsJson = JSON.stringify(validation.bars.map((bar) => ({
    date: bar.date,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    amount: bar.amount ?? null,
  })));
  const results = await db().batch([
    db().prepare(
      "INSERT INTO market_datasets (id, symbol, adjustment, version, run_id, hash, created_at, quality_json) SELECT ?, ?, ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?, ? FROM market_datasets WHERE symbol = ? AND adjustment = ? RETURNING version",
    ).bind(datasetId, symbol, ADJUSTMENT, runId, hash, createdAt, qualityJson, symbol, ADJUSTMENT),
    db().prepare(
      "INSERT INTO market_bars (run_id, date, open, high, low, close, volume, amount) SELECT ?, json_extract(value, '$.date'), json_extract(value, '$.open'), json_extract(value, '$.high'), json_extract(value, '$.low'), json_extract(value, '$.close'), json_extract(value, '$.volume'), json_extract(value, '$.amount') FROM json_each(?)",
    ).bind(runId, barsJson),
  ]);
  const version = (results[0].results?.[0] as { version?: number } | undefined)?.version;
  if (!Number.isInteger(version) || version! < 1) throw new Error("Verified market dataset version could not be allocated.");
  return {
    dataset: { symbol, adjustment: ADJUSTMENT, version: version!, hash, createdAt, runId },
    bars: validation.bars,
    validation: { verified: true, quality: validation.quality, issues: validation.issues, sources },
  };
}

function toBars(rows: BarRow[]): MarketBar[] {
  return rows.map((row) => ({ ...row, amount: row.amount ?? undefined }));
}

export async function getLatestDataset(symbol: string, limit = 2000): Promise<PublishedDataset | null> {
  const latest = await db().prepare("SELECT id, symbol, adjustment, version, run_id, hash, created_at, quality_json FROM market_datasets WHERE symbol = ? AND adjustment = ? ORDER BY version DESC LIMIT 1")
    .bind(symbol, ADJUSTMENT).first<DatasetRow>();
  if (!latest) return null;
  const result = await db().prepare("SELECT date, open, high, low, close, volume, amount FROM market_bars WHERE run_id = ? ORDER BY date DESC LIMIT ?")
    .bind(latest.run_id, Math.min(Math.max(limit, 1), 2000)).all<BarRow>() as D1Result<BarRow>;
  const saved = JSON.parse(latest.quality_json) as { quality: Quality; issues?: MarketIssue[]; sources?: SourceStatus[] };
  return {
    dataset: { symbol: latest.symbol, adjustment: ADJUSTMENT, version: latest.version, hash: latest.hash, createdAt: latest.created_at, runId: latest.run_id },
    bars: toBars((result.results ?? []).reverse()),
    validation: { verified: true, quality: saved.quality, issues: saved.issues ?? [], sources: saved.sources ?? [] },
  };
}

export function isFresh(dataset: PublishedDataset) {
  return Date.now() - Date.parse(dataset.dataset.createdAt) < 15 * 60 * 1000;
}
