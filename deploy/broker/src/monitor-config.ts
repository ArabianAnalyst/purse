export class MonitorConfigError extends Error {
  constructor(message: string) { super(`purse-monitor config: ${message}`); this.name = "MonitorConfigError"; }
}

/** A count and a duration, the shape of both the window and the velocity threshold. */
export interface Span { count: number; ms: number }

export interface MonitorConfig {
  databaseUrl: string;
  stream: string;
  /** The receipts table the broker writes. */
  table: string;
  intervalMs: number;
  window: Span;
  velocity: Span;
  /** Readiness goes red when the cursor is more than this many receipts behind the chain head. 0 switches the check off. */
  maxBehind: number;
  /** Where a monitor with no cursor row begins. `head` skips the existing chain, `beginning` judges it from the first receipt. */
  start: "head" | "beginning";
  /** Built-in expectation ids switched off. */
  disable: string[];
  /** Path to an ES module whose default export is an Expectation[]. */
  expectationsModule: string | undefined;
  deadlatch: { url: string; projectKey: string | undefined };
  /** Where flags go when there is no project key. */
  flagsFile: string;
  port: number;
  bind: string;
  otel: boolean;
}

type Env = Record<string, string | undefined>;

const UNIT: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `<count>/<duration>`, the duration a positive integer followed by m, h or d, for example `500/24h`. */
export function parseSpan(name: string, value: string): Span {
  const m = /^(\d+)\/(\d+)([mhd])$/.exec(value.trim());
  if (!m) throw new MonitorConfigError(`${name} must be <count>/<duration> with the duration in m, h or d, for example 500/24h, got "${value}"`);
  const count = Number(m[1]);
  const n = Number(m[2]);
  if (count < 1 || n < 1) throw new MonitorConfigError(`${name} count and duration must be at least 1, got "${value}"`);
  return { count, ms: n * UNIT[m[3]!]! };
}

const int = (name: string, v: string | undefined, dflt: number, min: number): number => {
  if (v == null || v === "") return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new MonitorConfigError(`${name} must be an integer of at least ${min}, got "${v}"`);
  return n;
};

export function loadMonitorConfig(env: Env = process.env): MonitorConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new MonitorConfigError("DATABASE_URL is required");
  const stream = env.MONITOR_STREAM ?? env.PURSE_STREAM ?? "purse";
  const url = (env.DEADLATCH_URL ?? "https://www.deadlatch.dev").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) throw new MonitorConfigError(`DEADLATCH_URL must start with http:// or https://, got "${url}"`);
  const projectKey = env.DEADLATCH_PROJECT_KEY || undefined;
  const disable = (env.MONITOR_DISABLE ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const start = env.MONITOR_START ?? "head";
  if (start !== "head" && start !== "beginning") throw new MonitorConfigError(`MONITOR_START must be head or beginning, got "${start}"`);
  return {
    databaseUrl, stream, table: "receipts",
    intervalMs: int("MONITOR_INTERVAL_MS", env.MONITOR_INTERVAL_MS, 60000, 1000),
    window: parseSpan("MONITOR_WINDOW", env.MONITOR_WINDOW ?? "500/24h"),
    velocity: parseSpan("MONITOR_VELOCITY", env.MONITOR_VELOCITY ?? "5/10m"),
    maxBehind: int("MONITOR_MAX_BEHIND", env.MONITOR_MAX_BEHIND, 2500, 0),
    start,
    disable,
    expectationsModule: env.MONITOR_EXPECTATIONS || undefined,
    deadlatch: { url, projectKey },
    flagsFile: env.MONITOR_FLAGS_FILE ?? "/data/flags.jsonl",
    port: int("MONITOR_PORT", env.MONITOR_PORT, 8083, 0),
    bind: env.MONITOR_BIND ?? "0.0.0.0",
    otel: Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT),
  };
}
