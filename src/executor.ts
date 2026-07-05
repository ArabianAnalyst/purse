// executor.ts — the credential-holding execution layer. Constructed INSIDE the broker
// process; the agent never holds a reference to it. Core ships only MockExecutor.
import type { Money } from "./money";

export interface Receipt {
  ok: boolean;
  ref?: string;          // the rail's transaction id
  paidAmount?: Money;
  error?: string;
  raw?: unknown;         // rail-specific payload; scrubbed before it reaches the audit log
}

/** The minimal shape an executor needs from a Grant. */
export interface Payable {
  id: string;
  payee: string;
  amount: Money;
}

export interface Executor {
  execute(grant: Payable): Promise<Receipt>;
}

/** Deterministic in-memory executor for the demo and tests. Moves no real money. */
export class MockExecutor implements Executor {
  constructor(private opts: { fail?: boolean } = {}) {}
  async execute(grant: Payable): Promise<Receipt> {
    if (this.opts.fail) return { ok: false, error: "mock: forced failure" };
    return { ok: true, ref: `mock_${grant.id.slice(0, 8)}`, paidAmount: grant.amount };
  }
}

/** Only ok + ref reach the audit log / explain. Never the raw payload or a credential. */
export function scrubReceipt(r: Receipt): { ok: boolean; ref?: string } {
  return { ok: r.ok, ref: r.ref };
}
