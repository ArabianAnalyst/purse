// broker.ts — the enforcement core. Holds the executor (credential). The agent can only
// reach request/execute/status; approve/deny/pending are the principal (out-of-band) API.
import { createHash } from "node:crypto";
import type { PolicyConfig, AuthorizeRequest, NormalizedRequest, DecisionStatus, Explain } from "./types";
import { parseMoney, zero, type Money } from "./money";
import { evaluate, type Ledger } from "./evaluate";
import { GrantStore, type Grant } from "./grants";
import { makeRecord, verifyChain, JsonlAuditStore, type AuditStore } from "./audit";
import { scrubReceipt, type Executor } from "./executor";

export interface BrokerOptions extends PolicyConfig {
  executor: Executor;
  grantTtlMs?: number;
  store?: AuditStore;
  auditFile?: string;
  now?: () => number;
}

export interface RequestResult {
  decision: DecisionStatus;
  grantId?: string;
  pendingId?: string;
  reason: string;
  explain: Explain;
}
export interface ExecuteResult {
  status: "paid" | "rejected";
  receipt?: { ok: boolean; ref?: string };
  reason: string;
}
export interface StatusResult { state: "pending" | "approved" | "denied" | "unknown"; grantId?: string }
export interface PendingView { id: string; payee: string; amount: Money; intent?: string; createdAt: string }

interface Pending {
  id: string;
  req: NormalizedRequest;
  createdAt: string;
  state: "pending" | "approved" | "denied";
  grantId?: string;
}

const DEFAULT_TTL_MS = 15 * 60_000;

export class Broker {
  private readonly cfg: PolicyConfig;
  private readonly currency: string;
  private readonly store: AuditStore;
  private readonly policyVersion: string;
  private readonly grants: GrantStore;
  private readonly executor: Executor;
  private readonly now: () => number;
  private readonly pendings = new Map<string, Pending>();

  constructor(opts: BrokerOptions) {
    const { executor, grantTtlMs, store, auditFile, now, ...policy } = opts;
    this.cfg = policy;
    this.currency = (policy.currency ?? "USD").toUpperCase();
    this.store = store ?? new JsonlAuditStore(auditFile);
    this.executor = executor;
    this.now = now ?? (() => Date.now());
    this.grants = new GrantStore(grantTtlMs ?? DEFAULT_TTL_MS, this.now);
    this.policyVersion = createHash("sha256").update(JSON.stringify(policy)).digest("hex").slice(0, 12);
  }

  private explain(req: NormalizedRequest, rule: Explain["rule"], extra: Partial<Explain> = {}): Explain {
    return {
      rule,
      policyVersion: this.policyVersion,
      evaluated: { amount: req.amount, payee: req.payee, category: req.category },
      ...extra,
    };
  }

  // ---- agent-facing ----

  request(raw: AuthorizeRequest): RequestResult {
    let req: NormalizedRequest;
    try {
      req = { amount: parseMoney(raw.amount, this.currency), payee: raw.payee, intent: raw.intent, category: raw.category, agentId: raw.agentId };
    } catch (e) {
      const safe: NormalizedRequest = { amount: zero(this.currency), payee: String(raw.payee ?? "?") };
      const explain = this.explain(safe, "malformed");
      const reason = `denied: malformed request (${(e as Error).message})`;
      makeRecord(this.store, { request: safe, status: "denied", reason, policyVersion: this.policyVersion, event: "decision", explain });
      return { decision: "denied", reason, explain };
    }

    let ev;
    try {
      const ledger: Ledger = { spentSince: (s, c) => this.grants.spentSince(s, c) };
      ev = evaluate(this.cfg, req, ledger, this.currency, this.now());
    } catch (e) {
      const explain = this.explain(req, "eval-error");
      const reason = `denied: policy evaluation failed (${(e as Error).message})`;
      makeRecord(this.store, { request: req, status: "denied", reason, policyVersion: this.policyVersion, event: "decision", explain });
      return { decision: "denied", reason, explain };
    }

    if (ev.status === "denied") {
      const explain = this.explain(req, ev.rule, { reservation: ev.reservation });
      makeRecord(this.store, { request: req, status: "denied", reason: ev.reason, policyVersion: this.policyVersion, event: "decision", explain });
      return { decision: "denied", reason: ev.reason, explain };
    }

    if (ev.status === "needs_approval") {
      const id = createHash("sha256").update(`${this.now()}:${req.payee}:${req.amount.amount}:${this.pendings.size}`).digest("hex").slice(0, 16);
      this.pendings.set(id, { id, req, createdAt: new Date(this.now()).toISOString(), state: "pending" });
      const explain = this.explain(req, ev.rule);
      makeRecord(this.store, { request: req, status: "needs_approval", reason: ev.reason, policyVersion: this.policyVersion, event: "decision", explain });
      return { decision: "needs_approval", pendingId: id, reason: ev.reason, explain };
    }

    // allowed → auto-mint a grant (policy is the authorization)
    const grant = this.grants.mint(req, "policy");
    const explain = this.explain(req, "within-policy", { grant: this.grantExplain(grant), approvedBy: "policy:auto" });
    makeRecord(this.store, { request: req, status: "allowed", reason: ev.reason, policyVersion: this.policyVersion, event: "grant_minted", explain, grantId: grant.id });
    return { decision: "allowed", grantId: grant.id, reason: ev.reason, explain };
  }

  async execute(grantId: string): Promise<ExecuteResult> {
    const claim = this.grants.claim(grantId);
    if (!claim.ok) {
      const existing = this.grants.get(grantId);
      const safe: NormalizedRequest = existing
        ? { amount: existing.amount, payee: existing.payee, intent: existing.intent, category: existing.category }
        : { amount: zero(this.currency), payee: "?" };
      makeRecord(this.store, { request: safe, status: "denied", reason: `rejected: ${claim.reason}`, policyVersion: this.policyVersion, event: "execution_failed", grantId: grantId });
      return { status: "rejected", reason: claim.reason };
    }
    const g = claim.grant;
    const req: NormalizedRequest = { amount: g.amount, payee: g.payee, intent: g.intent, category: g.category };

    let receipt;
    try {
      receipt = await this.executor.execute({ id: g.id, payee: g.payee, amount: g.amount });
    } catch (e) {
      this.grants.markFailed(g.id);
      const reason = "executor error";
      makeRecord(this.store, { request: req, status: "denied", reason, policyVersion: this.policyVersion, event: "execution_failed", grantId: g.id });
      return { status: "rejected", reason };
    }

    if (!receipt.ok) {
      this.grants.markFailed(g.id);
      const reason = "execution failed";
      const scrubbed = scrubReceipt(receipt);
      makeRecord(this.store, { request: req, status: "denied", reason, policyVersion: this.policyVersion, event: "execution_failed", grantId: g.id, receipt: scrubbed });
      return { status: "rejected", reason, receipt: scrubbed };
    }

    // claim() already marked it redeemed; keep it redeemed.
    const scrubbed = scrubReceipt(receipt);
    const explain = this.explain(req, "within-policy", { grant: this.grantExplain(g), approvedBy: g.origin === "principal" ? `principal:${g.pendingId ?? "?"}` : "policy:auto", receipt: scrubbed });
    makeRecord(this.store, { request: req, status: "allowed", reason: "executed", policyVersion: this.policyVersion, event: "executed", explain, grantId: g.id, receipt: scrubbed });
    return { status: "paid", receipt: scrubbed, reason: "executed" };
  }

  status(pendingId: string): StatusResult {
    const p = this.pendings.get(pendingId);
    if (!p) return { state: "unknown" };
    return { state: p.state, grantId: p.grantId };
  }

  // ---- principal-facing (out of band; NOT exposed over the agent transport) ----

  pending(): PendingView[] {
    return [...this.pendings.values()]
      .filter((p) => p.state === "pending")
      .map((p) => ({ id: p.id, payee: p.req.payee, amount: p.req.amount, intent: p.req.intent, createdAt: p.createdAt }));
  }

  approve(pendingId: string): { grantId?: string; reason: string } {
    const p = this.pendings.get(pendingId);
    if (!p) return { reason: "unknown pending id" };
    if (p.state !== "pending") return { reason: `pending is already ${p.state}` };
    const grant = this.grants.mint(p.req, "principal", pendingId);
    p.state = "approved";
    p.grantId = grant.id;
    const explain = this.explain(p.req, "within-policy", { grant: this.grantExplain(grant), approvedBy: `principal:${pendingId}` });
    makeRecord(this.store, { request: p.req, status: "allowed", reason: "principal approved", policyVersion: this.policyVersion, event: "grant_minted", explain, grantId: grant.id });
    return { grantId: grant.id, reason: "approved" };
  }

  deny(pendingId: string): { reason: string } {
    const p = this.pendings.get(pendingId);
    if (!p) return { reason: "unknown pending id" };
    if (p.state !== "pending") return { reason: `pending is already ${p.state}` };
    p.state = "denied";
    makeRecord(this.store, { request: p.req, status: "denied", reason: "principal denied", policyVersion: this.policyVersion, event: "decision" });
    return { reason: "denied" };
  }

  audit() { return this.store.all(); }
  verify() { return verifyChain(this.store.all()); }

  private grantExplain(g: Grant): NonNullable<Explain["grant"]> {
    return { id: g.id, boundTo: { payee: g.payee, amount: g.amount, intent: g.intent }, origin: g.origin };
  }
}
