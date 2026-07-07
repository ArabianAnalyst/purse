// server.ts — runs in the PARENT process (with the human/principal + the executor).
// Spawns the agent as a subordinate child and serves ONLY the agent-facing methods
// (request/execute/status). approve/deny/pending are never exposed over this channel.
import { spawn, type ChildProcess } from "node:child_process";
import type { Broker } from "./broker";
import type { WireRequest, WireResponse } from "./transport/types";
import type { AuthorizeRequest } from "./types";

/**
 * Spawn an agent child with a Node IPC channel. Runs the child with plain `node` by
 * default, so a compiled `.js` agent works with no extra dependencies. To run a
 * TypeScript child, pass a loader via `execArgv`, e.g. `{ execArgv: ["--import", "tsx"] }`.
 */
export function spawnAgent(childPath: string, opts: { execArgv?: string[] } = {}): ChildProcess {
  return spawn(process.execPath, [...(opts.execArgv ?? []), childPath], {
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
}

export function serveBroker(child: ChildProcess, broker: Broker): void {
  child.on("message", async (raw: WireRequest) => {
    const reply = (res: Omit<WireResponse, "id">) => child.send?.({ id: raw?.id ?? "", ...res });
    try {
      switch (raw?.method) {
        case "request":
          return reply({ ok: true, result: broker.request(raw.params as AuthorizeRequest) });
        case "execute":
          return reply({ ok: true, result: await broker.execute((raw.params as { grantId: string }).grantId) });
        case "status":
          return reply({ ok: true, result: broker.status((raw.params as { pendingId: string }).pendingId) });
        default:
          return reply({ ok: false, error: `unknown method: ${String(raw?.method)}` });
      }
    } catch (e) {
      reply({ ok: false, error: (e as Error).message });
    }
  });
}
