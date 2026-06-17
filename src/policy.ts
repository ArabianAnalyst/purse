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
} from "./types";
import { parseMoney, format, gt, add, assertSameCurrency, zero, type Money } from "./money";
import { JsonlAuditStore, makeRecord, verifyChain, type AuditStore } from "./audit";

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesAny(value: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(value));
}

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
        payee: req.payee,
        intent: req.intent,
        category: req.category,
        agentId: req.agentId,
      };
    } catch (e) {
      // Fail closed: if we cannot even read the request, deny it.
      const safe: NormalizedRequest = { amount: zero(this.currency), payee: String(req.payee ?? "?") };
      return this.decide(safe, "denied", `denied: malformed request (${(e as Error).message})`);
    }

    try {
      return this.evaluate(normalized);
    } catch (e) {
      // Fail closed: any error while evaluating policy denies the spend.
      return this.decide(normalized, "denied", `denied: policy evaluation failed (${(e as Error).message})`);
    }
  }

  private evaluate(req: NormalizedRequest): Decision {
    const c = this.cfg;

    // 1. Blocklist wins over everything.
    if (c.deny && matchesAny(req.payee, c.deny)) {
      return this.decide(req, "denied", `denied: payee "${req.payee}" is blocked`);
    }

    // 2. Allowlist: if present, the payee must be on it.
    if (c.allow && c.allow.length > 0 && !matchesAny(req.payee, c.allow)) {
      return this.decide(req, "denied", `denied: payee "${req.payee}" is not on the allowlist`);
    }

    // 3. Category restriction.
    if (c.categories && c.categories.length > 0) {
      if (!req.category || !c.categories.includes(req.category)) {
        return this.decide(req, "denied", `denied: category "${req.category ?? "none"}" is not permitted`);
      }
    }

    // 4. Per-action ceiling.
    if (c.maxPerAction !== undefined) {
      const cap = parseMoney(c.maxPerAction, this.currency);
      assertSameCurrency(req.amount, cap);
      if (gt(req.amount, cap)) {
        return this.decide(req, "denied", `denied: ${format(req.amount)} exceeds the per-action cap of ${format(cap)}`);
      }
    }

    // 5. Velocity ceilings (daily / custom window).
    const velocity = this.checkVelocity(req);
    if (velocity) return velocity;

    // 6. Human-approval threshold.
    if (c.requireApprovalOver !== undefined) {
      const threshold = parseMoney(c.requireApprovalOver, this.currency);
      assertSameCurrency(req.amount, threshold);
      if (gt(req.amount, threshold)) {
        return this.decide(
          req,
          "needs_approval",
          `needs approval: ${format(req.amount)} is above the auto-approve threshold of ${format(threshold)}`,
        );
      }
    }

    // 7. Within policy.
    return this.decide(req, "allowed", "within policy");
  }

  private checkVelocity(req: NormalizedRequest): Decision | null {
    const windows: Array<{ cap: Money; windowMs: number; label: string }> = [];
    if (this.cfg.maxPerDay !== undefined) {
      windows.push({ cap: parseMoney(this.cfg.maxPerDay, this.currency), windowMs: 86_400_000, label: "daily" });
    }
    if (this.cfg.maxPerWindow !== undefined) {
      windows.push({
        cap: parseMoney(this.cfg.maxPerWindow.amount, this.currency),
        windowMs: this.cfg.maxPerWindow.windowMs,
        label: "window",
      });
    }

    for (const w of windows) {
      const spent = this.spentSince(Date.now() - w.windowMs, req.amount.currency);
      const projected = add(spent, req.amount);
      if (gt(projected, w.cap)) {
        return this.decide(
          req,
          "denied",
          `denied: would exceed the ${w.label} cap of ${format(w.cap)} (${format(spent)} already used)`,
        );
      }
    }
    return null;
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

  private decide(req: NormalizedRequest, status: DecisionStatus, reason: string): Decision {
    const rec = makeRecord(this.store, req, status, reason, this.policyVersion);
    return {
      status,
      reason,
      request: req,
      recordId: rec.id,
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
