// types.ts
import type { Money } from "./money.js";
import type { Receipt } from "@olurabian/receipt";

/** What the agent is allowed to do. Amounts may be strings ("$5.00") or Money objects. */
export interface PolicyConfig {
  /** Default currency for bare amounts in this policy and in requests. Default "USD". */
  currency?: string;
  /** Ceiling on a single spend. */
  maxPerAction?: string | Money;
  /** Ceiling on total allowed spend in a rolling 24 hours. */
  maxPerDay?: string | Money;
  /** Ceiling over an arbitrary rolling window. */
  maxPerWindow?: { amount: string | Money; windowMs: number };
  /** Payee allowlist (glob supported: "*.aws.amazon.com"). If set, payee MUST match one. */
  allow?: string[];
  /** Payee blocklist (glob supported). Checked before the allowlist. */
  deny?: string[];
  /** Spends strictly above this amount return "needs_approval" instead of "allowed". */
  requireApprovalOver?: string | Money;
  /** If set, the request's category must be one of these. */
  categories?: string[];
}

export type DecisionStatus = "allowed" | "denied" | "needs_approval";

export interface AuthorizeRequest {
  amount: string | Money;
  payee: string;
  intent?: string;
  category?: string;
  agentId?: string;
}

export interface NormalizedRequest {
  amount: Money;
  payee: string;
  intent?: string;
  category?: string;
  agentId?: string;
}

export interface Decision {
  status: DecisionStatus;
  /** Human-readable explanation, safe to hand back to the agent or a reviewer. */
  reason: string;
  request: NormalizedRequest;
  /** Id of the audit record written for this decision. */
  recordId: string;
  /** Present only when status is "needs_approval". */
  approvalId?: string;
  explain?: Explain;
}

export type AuditEvent = "decision" | "grant_minted" | "executed" | "execution_failed" | "grant_expired";

/** What reaches the audit log / explain from a Receipt: ok + rail ref + the amount actually
 *  settled. Never the raw rail payload, the error text, or a credential. */
export interface ScrubbedReceipt {
  ok: boolean;
  ref?: string;
  paidAmount?: Money;
}

/** The payload of a Purse decision receipt, the `payload` of an @olurabian/receipt envelope. */
export interface DecisionPayload {
  request: NormalizedRequest;
  status: DecisionStatus;
  reason: string;
  /** Short hash of the policy that produced this decision. */
  policyVersion: string;
  event?: AuditEvent;
  explain?: Explain;
  grantId?: string;
  receipt?: ScrubbedReceipt;
}

/**
 * One immutable, hash-chained entry in the audit log: a Deadlatch receipt of
 * kind "decision". The decision fields live under `payload`; `prevHash` and
 * `hash` are on the envelope.
 */
export type AuditRecord = Receipt<DecisionPayload>;

export type ExplainRule =
  | "deny-list" | "allowlist-miss" | "category" | "per-action-cap"
  | "velocity" | "require-approval" | "within-policy" | "malformed" | "eval-error";

export interface Explain {
  rule: ExplainRule;
  policyVersion: string;
  evaluated: { amount: Money; payee: string; category?: string };
  reservation?: { used: Money; reserved: Money; cap: Money };
  grant?: { id: string; boundTo: { payee: string; amount: Money; intent?: string }; origin: "policy" | "principal" };
  approvedBy?: string;
  receipt?: ScrubbedReceipt;
}
