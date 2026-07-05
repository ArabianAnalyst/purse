// types.ts
import type { Money } from "./money";

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

/** One immutable, hash-chained entry in the audit log. */
export interface AuditRecord {
  id: string;
  ts: string; // ISO-8601
  request: NormalizedRequest;
  status: DecisionStatus;
  reason: string;
  /** Short hash of the policy that produced this decision. */
  policyVersion: string;
  /** Hash of the previous record (or 64 zeros for the first record). */
  prevHash: string;
  /** SHA-256 over this record's fields plus prevHash. */
  hash: string;
}

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
  receipt?: { ok: boolean; ref?: string };
}
