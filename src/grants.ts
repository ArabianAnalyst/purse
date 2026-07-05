// grants.ts — single-use, time-boxed authorizations. A grant binds one intent
// (payee + amount). claim() is atomic in single-threaded Node: it flips open->redeemed
// with no await inside, so two concurrent execute() calls cannot both claim the same grant.
import { randomUUID } from "node:crypto";
import type { NormalizedRequest } from "./types";
import type { Money } from "./money";

export type GrantState = "open" | "redeemed" | "expired" | "failed";
export type GrantOrigin = "policy" | "principal";

export interface Grant {
  id: string;
  payee: string;
  amount: Money;
  intent?: string;
  category?: string;
  origin: GrantOrigin;
  state: GrantState;
  createdAt: string;
  expiresAt: string;
  pendingId?: string;
}

export class GrantStore {
  private grants = new Map<string, Grant>();
  constructor(private ttlMs: number, private now: () => number = () => Date.now()) {}

  mint(req: NormalizedRequest, origin: GrantOrigin, pendingId?: string): Grant {
    const ts = this.now();
    const g: Grant = {
      id: randomUUID(),
      payee: req.payee,
      amount: req.amount,
      intent: req.intent,
      category: req.category,
      origin,
      state: "open",
      createdAt: new Date(ts).toISOString(),
      expiresAt: new Date(ts + this.ttlMs).toISOString(),
      pendingId,
    };
    this.grants.set(g.id, g);
    return g;
  }

  get(id: string): Grant | undefined {
    return this.grants.get(id);
  }

  private isExpired(g: Grant): boolean {
    return this.now() >= new Date(g.expiresAt).getTime();
  }

  /** Atomically take a redeemable grant. On success the grant is marked redeemed. */
  claim(id: string): { ok: true; grant: Grant } | { ok: false; reason: string } {
    const g = this.grants.get(id);
    if (!g) return { ok: false, reason: "grant not found" };
    if (g.state !== "open") return { ok: false, reason: `grant is ${g.state}` };
    if (this.isExpired(g)) { g.state = "expired"; return { ok: false, reason: "grant expired" }; }
    g.state = "redeemed"; // reserve the redemption before any async execution
    return { ok: true, grant: g };
  }

  markRedeemed(id: string): void { const g = this.grants.get(id); if (g) g.state = "redeemed"; }
  markFailed(id: string): void { const g = this.grants.get(id); if (g) g.state = "failed"; }

  /**
   * Reservation-aware ledger: settled spend (redeemed) PLUS open, unexpired grants
   * (reserved but not yet executed). Expired/failed grants release their reservation.
   * This is what makes the split-under-cap attack impossible at mint time.
   */
  spentSince(sinceMs: number, currency: string): Money {
    let total = 0;
    const nowMs = this.now();
    for (const g of this.grants.values()) {
      if (g.amount.currency !== currency) continue;
      if (new Date(g.createdAt).getTime() < sinceMs) continue;
      if (g.state === "redeemed") { total += g.amount.amount; continue; }
      if (g.state === "open" && nowMs < new Date(g.expiresAt).getTime()) { total += g.amount.amount; continue; }
      // expired or failed → released, not counted
    }
    return { amount: total, currency };
  }
}
