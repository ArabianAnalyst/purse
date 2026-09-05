import { Broker, verifyChain } from "@olurabian/purse";
import { instrumentBroker } from "@olurabian/deadlatch-otel";
import type { SqlClient } from "@olurabian/receipt";
import type { X402Signer } from "@olurabian/purse/x402";
import type { Config } from "./config.js";
import { openStore, type OpenedStore } from "./store.js";
import { buildExecutor } from "./executor.js";
import { startOtel } from "./otel.js";
import { createAgentServer, listen, type Listening } from "./agent-server.js";
import { createAdminServer, type Readiness } from "./admin-server.js";

export interface AppOverrides { sqlClient?: SqlClient; signer?: X402Signer }
export interface App {
  broker: Broker; store: OpenedStore; signerAddress?: string;
  ready(): Readiness;
  start(): Promise<{ agentUrl: string; adminUrl: string }>;
  stop(): Promise<void>;
}

export async function createApp(cfg: Config, overrides: AppOverrides = {}): Promise<App> {
  const stopOtel = cfg.otel ? startOtel() : null;
  const store = await openStore(cfg.store, overrides.sqlClient);
  if (store.kind === "jsonl") {
    console.error("purse-broker: PURSE_STORE=jsonl is for development only; receipts are in a local file, not Postgres");
  }
  const boot = verifyChain(store.store.all());
  if (!boot.ok) throw new Error(`audit chain fails verification at index ${boot.brokenAt} (${boot.reason})`);
  const { executor, signerAddress } = buildExecutor(cfg.executor, cfg.policy.currency, { signer: overrides.signer });
  const { grantTtlMs, ...policy } = cfg.policy;
  const broker = instrumentBroker(new Broker({ ...policy, executor, store: store.store, ...(grantTtlMs ? { grantTtlMs } : {}) }), { store });

  const ready = (): Readiness => {
    const d = store.degraded();
    if (d) return { ok: false, reason: `store degraded: ${d.message}` };
    const p = store.pending();
    if (p >= cfg.maxPending) return { ok: false, reason: `store has ${p} receipts pending (limit ${cfg.maxPending})` };
    return { ok: true };
  };

  let agent: Listening | null = null;
  let admin: Listening | null = null;
  return {
    broker, store, signerAddress, ready,
    async start() {
      agent = await listen(createAgentServer(broker), cfg.ports.agent, cfg.ports.bind);
      admin = await listen(createAdminServer(broker, store, cfg.adminToken, ready), cfg.ports.admin, cfg.ports.bind);
      return { agentUrl: agent.url, adminUrl: admin.url };
    },
    async stop() {
      await Promise.all([agent?.close(), admin?.close()]);
      await broker.flush().catch(() => undefined);
      await store.close();
      if (stopOtel) await stopOtel();
    },
  };
}
