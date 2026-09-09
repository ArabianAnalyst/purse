import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PostgresStore, makeReceipt, type SqlClient } from "@olurabian/receipt";
import type { DecisionPayload } from "@olurabian/purse";
import type { MonitorConfig } from "../../src/monitor-config.js";

export { clock } from "./witness-fixture.js";

const T0 = Date.UTC(2026, 8, 9, 0, 0, 0);
export const minute = (m: number) => new Date(T0 + m * 60_000).toISOString();

interface Opts { amount?: number; payee?: string; currency?: string }

export function minted(grantId: string, o: Opts = {}): DecisionPayload {
  return { request: { amount: { amount: o.amount ?? 1250, currency: o.currency ?? "USD" }, payee: o.payee ?? "api.stripe.com", intent: "credits" }, status: "allowed", reason: "within policy", policyVersion: "p1", event: "grant_minted", grantId };
}

export function executed(grantId: string, o: Opts & { paid?: number; paidCurrency?: string } = {}): DecisionPayload {
  const currency = o.currency ?? "USD";
  const paidAmount = o.paid === undefined ? undefined : { amount: o.paid, currency: o.paidCurrency ?? currency };
  return { request: { amount: { amount: o.amount ?? 1250, currency }, payee: o.payee ?? "api.stripe.com", intent: "credits" }, status: "allowed", reason: "executed", policyVersion: "p1", event: "executed", grantId, receipt: { ok: true, ref: "pi_1", paidAmount } };
}

export function failed(grantId: string, reason = "rejected: grant not found"): DecisionPayload {
  return { request: { amount: { amount: 0, currency: "USD" }, payee: "?" }, status: "denied", reason, policyVersion: "p1", event: "execution_failed", grantId };
}

/** Writes decisions through the broker's own store, one per minute from `startMinute`, seq assigned by the table. */
export async function seedDecisions(db: PGlite, stream: string, payloads: DecisionPayload[], startMinute = 0): Promise<void> {
  await seedRaw(db, stream, payloads.map((p) => ({ kind: "decision", payload: p })), startMinute);
}

/** Opens the broker's store once so the receipts table exists, for tests that start from an empty stream. */
export const ensureReceipts = (db: PGlite, stream: string): Promise<void> => seedRaw(db, stream, []);

export async function seedRaw(db: PGlite, stream: string, items: Array<{ kind: string; payload: unknown }>, startMinute = 0): Promise<void> {
  const store = await PostgresStore.open<unknown>(db as unknown as SqlClient, { stream });
  let i = 0;
  for (const it of items) {
    const n = startMinute + i++;
    makeReceipt(store, { kind: it.kind, payload: it.payload }, { now: () => minute(n), newId: () => `id-${stream}-${n}` });
  }
  await store.flush();
}

export function monitorCfg(over: Partial<MonitorConfig> = {}): MonitorConfig {
  const dir = mkdtempSync(join(tmpdir(), "purse-monitor-"));
  return {
    databaseUrl: "postgres://unused", stream: "t", table: "receipts",
    intervalMs: 60_000,
    window: { count: 500, ms: 24 * 60 * 60_000 },
    velocity: { count: 5, ms: 10 * 60_000 },
    maxBehind: 2500,
    start: "beginning", // tests seed history first, so they judge from the beginning unless they say otherwise
    disable: [], expectationsModule: undefined,
    deadlatch: { url: "https://deadlatch.test", projectKey: "dl_live_aaaaaaaabbbb" },
    flagsFile: join(dir, "flags.jsonl"),
    port: 0, bind: "127.0.0.1", otel: false,
    ...over,
  };
}

/** A scripted hosted side. Each path has its own queue of steps; an exhausted queue answers 202 for flags and 204 for heartbeats. */
export type Step = number | "network";
export function fakeDeadlatch(script: { flags?: Step[]; heartbeat?: Step[] } = {}) {
  const queues = { flags: [...(script.flags ?? [])], heartbeat: [...(script.heartbeat ?? [])] };
  const calls: { path: "flags" | "heartbeat"; headers: Record<string, string>; body: unknown }[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).endsWith("/api/v1/heartbeat") ? "heartbeat" : "flags";
    calls.push({ path, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: init?.body ? JSON.parse(String(init.body)) : null });
    const step = queues[path].shift() ?? (path === "flags" ? 202 : 204);
    if (step === "network") throw new TypeError("fetch failed");
    if (step === 204) return new Response(null, { status: 204 });
    const body = step === 202 ? JSON.stringify({ accepted: 1, duplicates: 0 }) : JSON.stringify({ error: `status ${step}` });
    return new Response(body, { status: step, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls, flagsCalls: () => calls.filter((c) => c.path === "flags"), heartbeats: () => calls.filter((c) => c.path === "heartbeat") };
}
