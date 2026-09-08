import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import pg from "pg";
import { verifyChain, type Receipt, type SqlClient } from "@olurabian/receipt";
import { P256Signer, PostgresAnchorStore, RekorV2, verifyAnchored, checkpointKeyId, fromBase64, type Anchor, type AnchorTrust, type AnchoredVerifyResult } from "@olurabian/receipt/anchor";
import { metrics, trace } from "@opentelemetry/api";
import type { WitnessConfig } from "./witness-config.js";

export type WitnessEventKind = "anchored" | "anchor-failed" | "anchor-conflict" | "chain-broken";
export interface WitnessEvent { n: number; stream: string; at: string; kind: WitnessEventKind; detail: string }
export interface WitnessState {
  stream: string;
  publicKey: string;
  log: { url: string; keyId: string };
  intervalMs: number;
  ticks: number;
  anchored: number;
  failures: number;
  lastTickAt: string | null;
  lastTickOk: boolean;
  lastVerifyOk: boolean;
  lastError: string | null;
  head: { seq: number; hash: string } | null;
  lastAnchor: { seq: number; head: string; logIndex: string; at: string } | null;
  /** Receipts appended since the last anchor. */
  lag: number;
}
export interface WitnessOverrides { sqlClient?: SqlClient; fetch?: typeof fetch; now?: () => string; signer?: P256Signer }
export interface Witness {
  readonly publicKey: string;
  readonly trust: AnchorTrust;
  state(): WitnessState;
  tick(): Promise<void>;
  anchors(sinceSeq?: number): Promise<Anchor[]>;
  events(sinceN?: number): Promise<WitnessEvent[]>;
  verify(): Promise<AnchoredVerifyResult>;
  ready(): { ok: boolean; reason?: string };
  close(): Promise<void>;
}

/** The file wins over the pem. A missing file is created, and only the public key is logged. */
export function loadOrCreateSigner(key: { file?: string; pem?: string }, log: (line: string) => void = console.log): P256Signer {
  if (key.file && existsSync(key.file)) return P256Signer.fromPem(readFileSync(key.file, "utf8"));
  if (key.pem) return P256Signer.fromPem(key.pem);
  if (!key.file) throw new Error("purse-witness: no key file and no key pem");
  const signer = P256Signer.generate();
  mkdirSync(dirname(key.file), { recursive: true });
  writeFileSync(key.file, signer.toPem(), { mode: 0o600 });
  log(`purse-witness: generated a new witness key at ${key.file}; public key ${signer.publicKeyDer()}`);
  return signer;
}

const EVENTS_SCHEMA = `CREATE TABLE IF NOT EXISTS witness_events (
  n BIGSERIAL PRIMARY KEY,
  stream TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
)`;

export async function createWitness(cfg: WitnessConfig, overrides: WitnessOverrides = {}): Promise<Witness> {
  const pool = overrides.sqlClient ? null : new pg.Pool({ connectionString: cfg.databaseUrl });
  const sql: SqlClient = overrides.sqlClient ?? (pool as unknown as SqlClient);
  const now = overrides.now ?? (() => new Date().toISOString());
  const signer = overrides.signer ?? loadOrCreateSigner(cfg.key);
  const publicKey = signer.publicKeyDer();
  const trust: AnchorTrust = { logKeys: [cfg.rekor.logKey], witnessKeys: [publicKey] };
  const rekor = new RekorV2({ url: cfg.rekor.url, logKeys: trust.logKeys, timeoutMs: cfg.rekor.timeoutMs, fetch: overrides.fetch, now });
  const anchors = new PostgresAnchorStore(sql);
  await anchors.open();
  await sql.query(EVENTS_SCHEMA);
  // The C2SP id of the pinned log key, shown on GET / so an operator can compare it with the trust root.
  const logKeyId = (() => { try { return checkpointKeyId(cfg.rekor.logKey.origin, fromBase64(cfg.rekor.logKey.publicKey)); } catch { return ""; } })();

  const tracer = trace.getTracer("purse-witness");
  const meter = metrics.getMeter("purse-witness");
  const anchorsCounter = meter.createCounter("deadlatch.witness.anchors");
  const failuresCounter = meter.createCounter("deadlatch.witness.failures");

  const state: WitnessState = {
    stream: cfg.stream, publicKey, log: { url: cfg.rekor.url, keyId: logKeyId }, intervalMs: cfg.intervalMs,
    ticks: 0, anchored: 0, failures: 0, lastTickAt: null, lastTickOk: false, lastVerifyOk: false, lastError: null, head: null, lastAnchor: null, lag: 0,
  };
  meter.createObservableGauge("deadlatch.witness.lag").addCallback((r) => r.observe(state.lag, { stream: cfg.stream }));

  const last = await anchors.last(cfg.stream);
  if (last) state.lastAnchor = { seq: last.seq, head: last.head, logIndex: last.entry.logIndex, at: last.at };

  async function records(): Promise<Receipt[]> {
    const { rows } = await sql.query(`SELECT record FROM ${cfg.table} WHERE stream = $1 ORDER BY seq`, [cfg.stream]);
    return rows.map((r) => JSON.parse(String(r.record)) as Receipt);
  }
  async function event(kind: WitnessEventKind, detail: string): Promise<void> {
    await sql.query("INSERT INTO witness_events (stream, at, kind, detail) VALUES ($1, $2, $3, $4)", [cfg.stream, now(), kind, detail]);
  }
  function lagOf(): number {
    if (!state.head) return 0;
    if (!state.lastAnchor) return state.head.seq + 1;
    return Math.max(0, state.head.seq - state.lastAnchor.seq);
  }
  function done(at: string, ok: boolean, error: string | null, verified: boolean): void {
    state.lastTickAt = at; state.lastTickOk = ok; state.lastVerifyOk = verified; state.lastError = error; state.lag = lagOf();
    if (!ok) { state.failures++; failuresCounter.add(1, { stream: cfg.stream }); }
  }

  async function tick(): Promise<void> {
    const at = now();
    state.ticks++;
    await tracer.startActiveSpan("deadlatch.witness.tick", async (span) => {
      try {
        const recs = await records();
        if (recs.length === 0) { state.head = null; done(at, true, null, true); return; }
        const chain = verifyChain(recs);
        if (!chain.ok) {
          const msg = `chain broken at ${chain.brokenAt} (${chain.id}): ${chain.reason}`;
          await event("chain-broken", msg);
          done(at, false, msg, false);
          return;
        }
        const seq = recs.length - 1;
        const head = recs[seq]!.hash;
        state.head = { seq, hash: head };
        if (state.lastAnchor && state.lastAnchor.seq === seq && state.lastAnchor.head === head) { done(at, true, null, true); return; }
        await tracer.startActiveSpan("deadlatch.witness.anchor", async (inner) => {
          try {
            const a = await rekor.submit(cfg.stream, seq, head, signer);
            await anchors.append(a);
            state.lastAnchor = { seq, head, logIndex: a.entry.logIndex, at: a.at };
            state.anchored++;
            anchorsCounter.add(1, { stream: cfg.stream });
            await event("anchored", `seq ${seq} head ${head} log index ${a.entry.logIndex}`);
            done(at, true, null, true);
          } catch (e) {
            const msg = (e as Error).message;
            const kind: WitnessEventKind = /unique|duplicate|exists/i.test(msg) ? "anchor-conflict" : "anchor-failed";
            await event(kind, msg);
            done(at, false, msg, true);
          } finally { inner.end(); }
        });
      } catch (e) {
        done(at, false, (e as Error).message, false);
      } finally { span.end(); }
    });
  }

  function ready(): { ok: boolean; reason?: string } {
    const window = cfg.maxLag * cfg.intervalMs;
    if (!state.lastTickAt) return { ok: false, reason: "no tick yet" };
    const nowMs = Date.parse(now());
    if (nowMs - Date.parse(state.lastTickAt) > window) return { ok: false, reason: "last tick is stale" };
    if (!state.lastVerifyOk) return { ok: false, reason: state.lastError ?? "last tick failed" };
    if (state.head && state.lastAnchor?.head !== state.head.hash) {
      const age = state.lastAnchor ? nowMs - Date.parse(state.lastAnchor.at) : Number.POSITIVE_INFINITY;
      if (age > window) return { ok: false, reason: `head at seq ${state.head.seq} not anchored, ${state.lag} receipts behind${state.lastError ? `, last error ${state.lastError}` : ""}` };
    }
    return { ok: true };
  }

  return {
    publicKey, trust,
    state: () => ({ ...state, head: state.head ? { ...state.head } : null, lastAnchor: state.lastAnchor ? { ...state.lastAnchor } : null, log: { ...state.log } }),
    tick,
    anchors: (sinceSeq = -1) => anchors.list(cfg.stream, sinceSeq),
    async events(sinceN = 0) {
      const { rows } = await sql.query("SELECT n, stream, at, kind, detail FROM witness_events WHERE stream = $1 AND n > $2 ORDER BY n", [cfg.stream, sinceN]);
      return rows.map((r) => ({ n: Number(r.n), stream: String(r.stream), at: new Date(String(r.at)).toISOString(), kind: r.kind as WitnessEventKind, detail: String(r.detail) }));
    },
    async verify() { return verifyAnchored(await records(), await anchors.list(cfg.stream), trust, { stream: cfg.stream }); },
    ready,
    async close() { if (pool) await pool.end(); },
  };
}
