import type { ActionRecord, Outcome } from "@olurabian/tripwire";
import type { ReceiptLike } from "@olurabian/tripwire/monitor";
import type { DecisionPayload } from "@olurabian/purse";

interface Money { amount: number; currency: string }

const STATUS: Record<string, Outcome> = { allowed: "ok", denied: "blocked", needs_approval: "ok" };

/**
 * A Purse decision receipt as a Tripwire action record. Null for any other kind, which the source
 * reports as skipped. Throws for a decision without a request or with an unknown status, which the
 * source also reports as skipped, with the message.
 */
export function purseRecord(r: ReceiptLike<unknown>): ActionRecord | null {
  if (r.kind !== "decision") return null;
  const p = r.payload as Partial<DecisionPayload> | null;
  if (!p || typeof p !== "object" || !p.request || typeof p.request !== "object") throw new Error("decision payload without a request");
  const status = String(p.status);
  const byStatus = STATUS[status];
  if (!byStatus) throw new Error(`unknown decision status ${status}`);
  const action = p.event ?? "decision";
  const outcome: Outcome = action === "execution_failed" ? "error" : byStatus;
  const paid = p.receipt?.paidAmount as Money | undefined;
  const requested = p.request.amount as Money | undefined;
  const cost = paid ? paid.amount : action === "executed" ? requested?.amount : undefined;
  const meta: Record<string, unknown> = {
    grantId: p.grantId,
    policyVersion: p.policyVersion,
    reason: p.reason,
    status,
    paidAmount: paid,
    currency: requested?.currency,
  };
  if (status === "needs_approval") meta.pending = true;
  const record: ActionRecord = { action, input: p.request, outcome, meta };
  if (outcome === "error") record.error = p.reason;
  if (cost !== undefined) record.cost = cost;
  return record;
}
