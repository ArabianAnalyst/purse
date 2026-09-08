import { PGlite } from "@electric-sql/pglite";
import { PostgresStore, makeReceipt, type SqlClient } from "@olurabian/receipt";
import type { WitnessConfig } from "../../src/witness-config.js";
import { FakeRekor } from "./fake-rekor.js";

/** A PGlite with n receipts on `stream`, written through the real PostgresStore so the table is the broker's. */
export async function seedReceipts(db: PGlite, stream: string, n: number, from = 0): Promise<void> {
  const store = await PostgresStore.open<{ n: number }>(db as unknown as SqlClient, { stream });
  for (let i = from; i < from + n; i++) makeReceipt(store, { kind: "decision", payload: { n: i } }, { now: () => `2026-09-08T00:00:${String(i % 60).padStart(2, "0")}.000Z`, newId: () => `id-${i}` });
  await store.flush();
}

export interface Clock { now(): string; advance(ms: number): void }
export function clock(start = "2026-09-08T10:00:00.000Z"): Clock {
  let t = Date.parse(start);
  return { now: () => new Date(t).toISOString(), advance: (ms) => { t += ms; } };
}

export function witnessCfg(rekor: FakeRekor, over: Partial<WitnessConfig> = {}): WitnessConfig {
  return {
    databaseUrl: "postgres://unused", stream: "t", table: "receipts",
    key: { pem: undefined, file: undefined },
    trustedKeys: [],
    rekor: { url: rekor.url, logKey: rekor.logKey, timeoutMs: 5000 },
    intervalMs: 60000, maxLag: 2, port: 0, bind: "127.0.0.1", otel: false,
    ...over,
  };
}
