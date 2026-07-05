// policy.ts
// The Purse: every agent spend passes through authorize() and gets a decision
// plus an immutable audit record. Fail-closed by design.

import { createHash } from "node:crypto";
import type {
  PolicyConfig,
  AuthorizeRequest,
  NormalizedRequest,
  Decision,
  DecisionStatus,
  Explain,
  ExplainRule,
} from "./types";
import { parseMoney, format, add, zero, type Money } from "./money";
import { evaluate, type Ledger } from "./evaluate";
import { JsonlAuditStore, makeRecord, verifyChain, type AuditStore } from "./audit";

export interface PurseOptions extends PolicyConfig {
  /** Bring your own audit store. Defaults to an in-memory JSONL store. */
  store?: AuditStore;
  /** Convenience: persist the audit log to this JSONL file. */
  auditFile?: string;
}

export class Purse {
  private readonly cfg: PolicyConfig;
  private readonly currency: string;
  private readonly store: AuditStore;
  private readonly policyVersion: string;

  constructor(opts: PurseOptions = {}) {
    const { store, auditFile, ...policy } = opts;
    this.cfg = policy;
    this.currency = (policy.currency ?? "USD").toUpperCase();
    this.store = store ?? new JsonlAuditStore(auditFile);
    this.policyVersion = createHash("sha256")
      .update(JSON.stringify(policy))
      .digest("hex")
      .slice(0, 12);
  }

  /**
   * The one call every spend must pass through.
   * Returns "allowed" | "denied" | "needs_approval" and writes an audit record.
   */
  authorize(req: AuthorizeRequest): Decision {
    let normalized: NormalizedRequest;
    try {
      normalized = {
        amount: parseMoney(req.amount, this.currency),
        payee: req.payee, intent: req.intent, category: req.category, agentId: req.agentId,
      };
    } catch (e) {
      const safe: NormalizedRequest = { amount: zero(this.currency), payee: String(req.payee ?? "?") };
      return this.decide(safe, "denied", `denied: malformed request (${(e as Error).message})`, "malformed");
    }
    try {
      const ledger: Ledger = { spentSince: (s, c) => this.spentSince(s, c) };
      const ev = evaluate(this.cfg, normalized, ledger, this.currency, Date.now());
      return this.decide(normalized, ev.status, ev.reason, ev.rule, ev.reservation);
    } catch (e) {
      return this.decide(normalized, "denied", `denied: policy evaluation failed (${(e as Error).message})`, "eval-error");
    }
  }

  /** Sum of previously ALLOWED spends since a timestamp, in one currency. */
  private spentSince(sinceMs: number, currency: string): Money {
    let total = 0;
    for (const r of this.store.all()) {
      if (r.status !== "allowed") continue;
      if (r.request.amount.currency !== currency) continue;
      if (new Date(r.ts).getTime() < sinceMs) continue;
      total += r.request.amount.amount;
    }
    return { amount: total, currency };
  }

  private decide(
    req: NormalizedRequest, status: DecisionStatus, reason: string,
    rule: ExplainRule, reservation?: Explain["reservation"],
  ): Decision {
    const explain: Explain = {
      rule, policyVersion: this.policyVersion,
      evaluated: { amount: req.amount, payee: req.payee, category: req.category },
      reservation,
    };
    const rec = makeRecord(this.store, req, status, reason, this.policyVersion);
    return {
      status, reason, request: req, recordId: rec.id, explain,
      approvalId: status === "needs_approval" ? rec.id : undefined,
    };
  }

  /** The full audit log. */
  audit() {
    return this.store.all();
  }

  /** Prove the audit log has not been tampered with. */
  verify() {
    return verifyChain(this.store.all());
  }
}
