import pg from "pg";
import { PostgresStore, verifyChain, type SqlClient, type Store } from "@olurabian/receipt";
import { JsonlAuditStore, type DecisionPayload } from "@olurabian/purse";
import type { StoreConfig } from "./config.js";

export interface OpenedStore {
  store: Store<DecisionPayload>;
  kind: "postgres" | "jsonl";
  pending: () => number;
  degraded: () => Error | null;
  flush: () => Promise<void>;
  close: () => Promise<void>;
}

export async function openStore(cfg: StoreConfig, client?: SqlClient): Promise<OpenedStore> {
  if (cfg.kind === "jsonl") {
    const store = new JsonlAuditStore(cfg.file);
    const v = verifyChain(store.all());
    if (!v.ok) throw new Error(`audit file ${cfg.file} fails verification at index ${v.brokenAt} (${v.reason})`);
    return { store, kind: "jsonl", pending: () => 0, degraded: () => null, flush: async () => undefined, close: async () => undefined };
  }
  const pool = client ? null : new pg.Pool({ connectionString: cfg.url });
  const sql: SqlClient = client ?? (pool as unknown as SqlClient);
  const store = await PostgresStore.open<DecisionPayload>(sql, { stream: cfg.stream });
  return {
    store, kind: "postgres",
    pending: () => store.pending(), degraded: () => store.degraded(), flush: () => store.flush(),
    close: async () => { await store.flush().catch(() => undefined); if (pool) await pool.end(); },
  };
}
