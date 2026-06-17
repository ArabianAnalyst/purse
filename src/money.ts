// money.ts
// Money is always integer minor units (e.g. cents). Never floats.
// Floating point and money do not mix: 0.1 + 0.2 !== 0.3.

export interface Money {
  /** Integer amount in the currency's minor unit (cents for USD, whole yen for JPY). */
  amount: number;
  /** ISO-4217 code, uppercase, e.g. "USD", "NGN", "JPY". */
  currency: string;
}

// Currencies that do not use 2 decimal places.
const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "XOF", "XAF", "RWF", "UGX"]);
const THREE_DECIMAL = new Set(["BHD", "KWD", "OMR", "TND", "JOD", "IQD", "LYD"]);

const SYMBOL_TO_CURRENCY: Record<string, string> = {
  "$": "USD",
  "£": "GBP",
  "€": "EUR",
  "₦": "NGN",
  "¥": "JPY",
  "₵": "GHS",
};

export function decimalsFor(currency: string): number {
  const c = currency.toUpperCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
}

/**
 * Parse a money string into integer minor units.
 * Accepts: "$5.00", "5.00 USD", "USD 12.5", "₦75,000", "12" (uses defaultCurrency),
 * or an already-built Money object.
 */
export function parseMoney(input: string | Money, defaultCurrency = "USD"): Money {
  if (typeof input !== "string") {
    return { amount: Math.round(input.amount), currency: input.currency.toUpperCase() };
  }

  let s = input.trim();
  let currency: string | null = null;

  // 1. explicit 3-letter ISO code, e.g. "USD"
  const codeMatch = s.match(/\b([A-Za-z]{3})\b/);
  if (codeMatch && codeMatch[1]) {
    currency = codeMatch[1].toUpperCase();
    s = s.replace(codeMatch[0], "");
  }

  // 2. currency symbol, e.g. "$" or "₦"
  for (const [sym, cur] of Object.entries(SYMBOL_TO_CURRENCY)) {
    if (s.includes(sym)) {
      if (!currency) currency = cur;
      s = s.split(sym).join("");
    }
  }

  currency = (currency ?? defaultCurrency).toUpperCase();
  s = s.replace(/[,\s]/g, "");

  const value = Number(s);
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot parse money from "${input}"`);
  }
  if (value < 0) {
    throw new Error(`Money cannot be negative: "${input}"`);
  }

  const decimals = decimalsFor(currency);
  const amount = Math.round(value * 10 ** decimals);
  return { amount, currency };
}

export function format(m: Money): string {
  const decimals = decimalsFor(m.currency);
  const major = m.amount / 10 ** decimals;
  return `${major.toFixed(decimals)} ${m.currency}`;
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(
      `Currency mismatch: cannot compare ${a.currency} with ${b.currency}. ` +
        `Purse does not convert currencies; keep one currency per policy.`,
    );
  }
}

export function gt(a: Money, b: Money): boolean {
  assertSameCurrency(a, b);
  return a.amount > b.amount;
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function zero(currency: string): Money {
  return { amount: 0, currency: currency.toUpperCase() };
}
