import pg from "pg";
import type { SqlClient } from "@olurabian/receipt";
import type { Expectation } from "@olurabian/tripwire";
import {
  createMonitor, deadlatchSink, fileSink, fromReceipts,
  type Cursor, type CursorStore, type Flag, type Monitor, type MonitorEvent, type ReceiptLike, type Sink, type Skipped, type Source,
} from "@olurabian/tripwire/monitor";
import { metrics, trace } from "@opentelemetry/api";
import type { MonitorConfig } from "./monitor-config.js";
import { purseRecord } from "./purse-records.js";
import { loadExpectations } from "./purse-expectations.js";
import { VERSION } from "./version.js";

export interface MonitorAppEvent { n: number; stream: string; at: string; kind: string; detail: string }
export interface StoredFlag { n: number; flag: Flag }
export interface MonitorAppState {
  stream: string;
  version: string;
  intervalMs: number;
  window: { count: number; ms: number };
  sink: "deadlatch" | "file";
  /** The first eight characters of the project key after dl_live_, or null without a key. */
  keyPrefix: string | null;
  cursor: Cursor | null;
  ticks: number;
  lastTickAt: string | null;
  lastTickOk: boolean;
  lastPushOk: boolean;
  lastPushAt: string | null;
  lastError: string | null;
  queued: number;
  flags: number;
  windowCount: number;
}
export interface MonitorAppOverrides { sqlClient?: SqlClient; fetch?: typeof fetch; now?: () => string; expectations?: Expectation[] }
export interface MonitorApp {
  state(): MonitorAppState;
  tick(): Promise<void>;
  flags(sinceN?: number): Promise<StoredFlag[]>;
  events(sinceN?: number): Promise<MonitorAppEvent[]>;
  ready(): { ok: boolean; reason?: string };
  close(): Promise<void>;
}

/** Receipts read per tick. Bounds the engine's pending list while the hosted side is down. */
export const READ_LIMIT = 500;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS monitor_cursor (stream TEXT PRIMARY KEY, seq BIGINT NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS monitor_flags (n BIGSERIAL PRIMARY KEY, id TEXT NOT NULL UNIQUE, stream TEXT NOT NULL, at TIMESTAMPTZ NOT NULL, flag TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS monitor_events (n BIGSERIAL PRIMARY KEY, stream TEXT NOT NULL, at TIMESTAMPTZ NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL)`,
];

export async function createMonitorApp(cfg: MonitorConfig, overrides: MonitorAppOverrides = {}): Promise<MonitorApp> {
  const pool = overrides.sqlClient ? null : new pg.Pool({ connectionString: cfg.databaseUrl });
  const sql: SqlClient = overrides.sqlClient ?? (pool as unknown as SqlClient);
  const now = overrides.now ?? (() => new Date().toISOString());
  for (const statement of SCHEMA) await sql.query(statement);
  const expectations = overrides.expectations ?? (await loadExpectations(cfg));

  const tracer = trace.getTracer("purse-monitor");
  const meter = metrics.getMeter("purse-monitor");
  const flagCounter = meter.createCounter("deadlatch.watch.flag");
  const pushFailedCounter = meter.createCounter("deadlatch.watch.push.failed");

  const st = { ticks: 0, lastError: null as string | null };

  // Events are remembered during a tick and written after it, so the engine's synchronous listener never touches the database.
  const remembered: Array<{ kind: string; detail: string }> = [];
  const remember = (kind: string, detail: string): void => { remembered.push({ kind, detail }); };
  async function flushEvents(): Promise<void> {
    for (const e of remembered.splice(0)) {
      await sql.query("INSERT INTO monitor_events (stream, at, kind, detail) VALUES ($1, $2, $3, $4)", [cfg.stream, now(), e.kind, e.detail]);
    }
  }
  const onEvent = (e: MonitorEvent): void => {
    switch (e.kind) {
      case "tick": st.lastError = null; return;
      case "skipped": remember(e.kind, `seq ${e.ref.seq ?? "?"} ${e.reason}`); return;
      case "push-failed":
        pushFailedCounter.add(1, { stream: cfg.stream });
        st.lastError = e.error;
        remember(e.kind, `${e.flags} flags, ${e.error}, ${e.queued} queued`);
        return;
      case "push-rejected": remember(e.kind, `${e.flags} flags rejected with ${e.status}${e.error ? `, ${e.error.slice(0, 200)}` : ""}`); return;
      case "dropped": remember(e.kind, `${e.flags} flags dropped, ${e.queued} queued`); return;
      case "heartbeat-failed": remember(e.kind, e.error); return;
      case "error": st.lastError = e.error; remember(e.kind, e.error); return;
    }
  };

  const toRecords = fromReceipts<unknown>(cfg.stream, purseRecord);
  const source: Source = {
    async next(cursor) {
      const { rows } = await sql.query(`SELECT seq, record FROM ${cfg.table} WHERE stream = $1 AND seq > $2 ORDER BY seq LIMIT ${READ_LIMIT}`, [cfg.stream, cursor?.seq ?? 0]);
      const receipts: Array<ReceiptLike<unknown> & { seq: number }> = [];
      const unparsed: Skipped[] = [];
      for (const r of rows) {
        const seq = Number(r.seq);
        try {
          receipts.push({ seq, ...(JSON.parse(String(r.record)) as ReceiptLike<unknown>) });
        } catch {
          unparsed.push({ ref: { stream: cfg.stream, seq }, reason: "record does not parse" });
        }
      }
      const { records, skipped } = toRecords(receipts);
      const all = [...unparsed, ...skipped].sort((a, b) => (a.ref.seq ?? 0) - (b.ref.seq ?? 0));
      const last = rows[rows.length - 1];
      return { records, skipped: all, cursor: last ? { seq: Number(last.seq) } : cursor };
    },
  };

  const cursorStore: CursorStore = {
    async load() {
      const { rows } = await sql.query("SELECT seq FROM monitor_cursor WHERE stream = $1", [cfg.stream]);
      const r = rows[0];
      return r ? { seq: Number(r.seq) } : null;
    },
    async save(cursor) {
      await sql.query(
        "INSERT INTO monitor_cursor (stream, seq, updated_at) VALUES ($1, $2, $3) ON CONFLICT (stream) DO UPDATE SET seq = EXCLUDED.seq, updated_at = EXCLUDED.updated_at",
        [cfg.stream, cursor.seq, now()],
      );
    },
  };

  const key = cfg.deadlatch.projectKey;
  const keyPrefix = key ? key.replace(/^dl_live_/, "").slice(0, 8) : null;
  const inner: Sink = key
    ? deadlatchSink({ url: cfg.deadlatch.url, projectKey: key, monitor: { version: VERSION, stream: cfg.stream, intervalMs: cfg.intervalMs }, fetch: overrides.fetch, now: () => new Date(now()), onEvent })
    : fileSink(cfg.flagsFile);
  /**
   * Every flag is stored beside the receipts before the push, keyed on its id, so the local record exists when
   * the hosted side is down. The wrapper passes the hosted sink's heartbeat through and hides its own queue, so the
   * engine's `queued` counts exactly the flags the monitor holds.
   */
  const heartbeat = (inner as { heartbeat?: unknown }).heartbeat;
  const sink: Sink & { heartbeat?: unknown } = {
    ...(heartbeat ? { heartbeat } : {}),
    async push(flags: Flag[]) {
      for (const f of flags) {
        const { rows } = await sql.query("INSERT INTO monitor_flags (id, stream, at, flag) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING RETURNING id", [f.id, cfg.stream, f.at, JSON.stringify(f)]);
        if (rows.length > 0) flagCounter.add(1, { stream: cfg.stream, expectation: f.expectation.id });
      }
      await inner.push(flags);
    },
  };

  const monitor: Monitor = createMonitor({ source, expectations, sink, cursorStore, window: cfg.window, intervalMs: cfg.intervalMs, now: () => new Date(now()), onEvent });
  meter.createObservableGauge("deadlatch.watch.queued").addCallback((r) => r.observe(monitor.state().queued, { stream: cfg.stream }));

  async function tick(): Promise<void> {
    st.ticks++;
    await tracer.startActiveSpan("deadlatch.watch.tick", async (span) => {
      try { await monitor.tick(); } finally { span.end(); }
    });
    try { await flushEvents(); } catch (e) { st.lastError = (e as Error).message; }
  }

  function ready(): { ok: boolean; reason?: string } {
    const s = monitor.state();
    if (!s.lastTickAt) return { ok: false, reason: "no tick yet" };
    if (Date.parse(now()) - Date.parse(s.lastTickAt) > 3 * cfg.intervalMs) return { ok: false, reason: "last tick is stale" };
    if (!s.lastTickOk) return { ok: false, reason: st.lastError ?? "last tick failed" };
    if (!s.lastPushOk) return { ok: false, reason: `last push failed, ${s.queued} flags queued${st.lastError ? `, ${st.lastError}` : ""}` };
    return { ok: true };
  }

  return {
    state: () => {
      const s = monitor.state();
      return {
        stream: cfg.stream, version: VERSION, intervalMs: cfg.intervalMs, window: { ...cfg.window },
        sink: key ? "deadlatch" : "file", keyPrefix,
        cursor: s.cursor, ticks: st.ticks,
        lastTickAt: s.lastTickAt, lastTickOk: s.lastTickOk, lastPushOk: s.lastPushOk, lastPushAt: s.lastPushAt,
        lastError: st.lastError, queued: s.queued, flags: s.flags, windowCount: s.window.count,
      };
    },
    tick,
    async flags(sinceN = 0) {
      const { rows } = await sql.query("SELECT n, flag FROM monitor_flags WHERE stream = $1 AND n > $2 ORDER BY n LIMIT 1000", [cfg.stream, sinceN]);
      return rows.map((r) => ({ n: Number(r.n), flag: JSON.parse(String(r.flag)) as Flag }));
    },
    async events(sinceN = 0) {
      const { rows } = await sql.query("SELECT n, stream, at, kind, detail FROM monitor_events WHERE stream = $1 AND n > $2 ORDER BY n LIMIT 1000", [cfg.stream, sinceN]);
      return rows.map((r) => ({ n: Number(r.n), stream: String(r.stream), at: new Date(String(r.at)).toISOString(), kind: String(r.kind), detail: String(r.detail) }));
    },
    ready,
    async close() { monitor.stop(); if (pool) await pool.end(); },
  };
}
