import type { NormalizedSymbol } from "./types";

const SYMBOL = /^(\d{6})\.(SH|SZ)$/;

/** Only canonical mainland exchange symbols are accepted; this also prevents URL injection/SSRF. */
export function normalizeSymbol(value: unknown): NormalizedSymbol {
  if (typeof value !== "string") throw new Error("symbol is required, e.g. 510300.SH");
  const parsed = SYMBOL.exec(value.trim().toUpperCase());
  if (!parsed) throw new Error("symbol must be a six-digit SH/SZ code, e.g. 510300.SH or 000001.SZ");
  const [, code, exchange] = parsed;
  const market = exchange === "SH" ? "1" : "0";
  return {
    symbol: `${code}.${exchange}`,
    code,
    exchange: exchange as "SH" | "SZ",
    eastmoneySecid: `${market}.${code}`,
    tencentSymbol: `${exchange.toLowerCase()}${code}`,
  };
}

export function normalizeDays(value: unknown): number {
  if (value === undefined || value === null || value === "") return 120;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 10 || days > 2000) {
    throw new Error("days must be an integer from 10 to 2000");
  }
  return days;
}
