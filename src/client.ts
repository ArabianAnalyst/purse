// client.ts — the ONLY thing the agent process imports. No executor, no credential.
// Fail-closed: if the broker channel dies or errors, requests resolve to denied/rejected.
import { randomUUID } from "node:crypto";
import type { AuthorizeRequest } from "./types";
import type { RequestResult, ExecuteResult, StatusResult } from "./broker";
import type { AgentChannel, WireRequest, WireResponse } from "./transport/types";

export class PurseClient {
  private pending = new Map<string, (r: WireResponse) => void>();
  private closed = false;

  constructor(private channel: AgentChannel) {
    channel.onMessage((msg) => {
      const resolve = this.pending.get(msg.id);
      if (resolve) { this.pending.delete(msg.id); resolve(msg); }
    });
    channel.onClose(() => {
      this.closed = true;
      for (const [, resolve] of this.pending) resolve({ id: "", ok: false, error: "broker channel closed" });
      this.pending.clear();
    });
  }

  static fromProcess(): PurseClient {
    const channel: AgentChannel = {
      send: (msg) => { process.send?.(msg); },
      onMessage: (cb) => { process.on("message", (m) => cb(m as WireResponse)); },
      onClose: (cb) => { process.on("disconnect", cb); },
    };
    return new PurseClient(channel);
  }

  private call(method: WireRequest["method"], params: unknown): Promise<WireResponse> {
    if (this.closed) return Promise.resolve({ id: "", ok: false, error: "broker channel closed" });
    const id = randomUUID();
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      try { this.channel.send({ id, method, params }); }
      catch (e) { this.pending.delete(id); resolve({ id, ok: false, error: (e as Error).message }); }
    });
  }

  async request(spend: AuthorizeRequest): Promise<RequestResult> {
    const res = await this.call("request", spend);
    if (!res.ok) return { decision: "denied", reason: `denied: ${res.error ?? "broker unavailable"}`, explain: { rule: "eval-error", policyVersion: "", evaluated: { amount: { amount: 0, currency: "USD" }, payee: String(spend.payee) } } };
    return res.result as RequestResult;
  }

  async execute(grantId: string): Promise<ExecuteResult> {
    const res = await this.call("execute", { grantId });
    if (!res.ok) return { status: "rejected", reason: `rejected: ${res.error ?? "broker unavailable"}` };
    return res.result as ExecuteResult;
  }

  async status(pendingId: string): Promise<StatusResult> {
    const res = await this.call("status", { pendingId });
    if (!res.ok) return { state: "unknown" };
    return res.result as StatusResult;
  }
}
