// x402-executor.ts — an Executor that settles a grant over the x402 protocol.
// Flow: probe the resource for its 402 challenge, require the challenged amount to be
// <= the grant amount (grant as ceiling — the agent may pay up to what was authorized,
// never more), then sign + settle the vendor's actual price.
// Built and tested against the local mock; see examples/x402/README.md for the Base Sepolia path.
import type { Executor, Payable, Receipt } from "../executor.js";
import type { Money } from "../money.js";
import type { PaymentRequirements, X402Signer } from "./types.js";

/** Settlement proof: X-PAYMENT-RESPONSE (plain or base64 JSON, per x402 v1) first, then a JSON body with `ref`. */
function settlementRef(headerValue: string | null, bodyText: string): string | undefined {
  const tryParse = (s: string): Record<string, unknown> | undefined => {
    try { const v = JSON.parse(s); return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined; } catch { return undefined; }
  };
  const pick = (o: Record<string, unknown> | undefined): string | undefined => {
    if (!o) return undefined;
    for (const k of ["ref", "transaction", "txHash"]) { const v = o[k]; if (typeof v === "string" && v) return v; }
    return undefined;
  };
  if (headerValue) {
    const direct = pick(tryParse(headerValue));
    if (direct) return direct;
    try { const decoded = pick(tryParse(Buffer.from(headerValue, "base64").toString("utf8"))); if (decoded) return decoded; } catch { /* not base64 */ }
  }
  return pick(tryParse(bodyText));
}

export interface X402ExecutorOptions {
  /** Map a Purse payee (allowlisted vendor id) to the x402 resource URL. Return undefined to reject. */
  resolvePayee: (payee: string) => string | undefined;
  /** Produces the X-PAYMENT header for a challenge. Holds the wallet in a real deployment. */
  signer: X402Signer;
  /** Convert the challenge's atomic amount to Purse Money for the ceiling comparison.
   *  Default: treat `maxAmountRequired` as integer minor units in the grant's currency
   *  (true for the mock, where asset is "USD-cents"). Override for real USDC (6 decimals). */
  toMoney?: (reqs: PaymentRequirements, grantCurrency: string) => Money;
  /** Injectable fetch for testing; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

function defaultToMoney(reqs: PaymentRequirements, currency: string): Money {
  // The local mock speaks the grant's currency directly, tagged asset "USD-cents". Any other
  // asset is unrecognized by this default mapping -> return a non-integer so the ceiling guard
  // rejects (fail closed). A real deployment injects a toMoney that derives the currency from
  // reqs.asset (e.g. USDC 6-decimals) and enforces the match itself.
  if (reqs.asset !== "USD-cents") return { amount: Number.NaN, currency };
  return { amount: Number(reqs.maxAmountRequired), currency };
}

export class X402Executor implements Executor {
  constructor(private opts: X402ExecutorOptions) {}
  private get f(): typeof fetch { return this.opts.fetchImpl ?? fetch; }

  async execute(grant: Payable): Promise<Receipt> {
    const url = this.opts.resolvePayee(grant.payee);
    if (!url) return { ok: false, error: `no x402 resource mapped for payee "${grant.payee}"` };

    // 1. Probe for the 402 challenge.
    let challenge: PaymentRequirements;
    let x402Version: number;
    try {
      const res = await this.f(url);
      if (res.status !== 402) return { ok: false, error: `expected a 402 challenge, got ${res.status}` };
      const body = (await res.json()) as { x402Version?: number; accepts?: PaymentRequirements[] };
      const accept = body.accepts?.[0];
      if (!accept) return { ok: false, error: "402 challenge carried no payment requirements" };
      challenge = accept;
      x402Version = body.x402Version ?? 1;
    } catch (e) {
      return { ok: false, error: `challenge probe failed: ${(e as Error).message}` };
    }

    // 2. Intent-binding (grant as ceiling): the challenged amount MUST be <= the granted
    //    amount, same currency. The agent may pay UP TO what was authorized, never more.
    let challenged: Money;
    try {
      challenged = (this.opts.toMoney ?? defaultToMoney)(challenge, grant.amount.currency);
    } catch (e) {
      return { ok: false, error: `could not read the challenge amount: ${(e as Error).message}` };
    }
    if (!Number.isInteger(challenged.amount) || challenged.amount < 0 || challenged.currency !== grant.amount.currency || challenged.amount > grant.amount.amount) {
      return { ok: false, error: `402 amount (${challenge.maxAmountRequired} ${challenge.asset}) does not satisfy the grant ceiling (${grant.amount.amount} ${grant.amount.currency})` };
    }

    // 3. Sign and settle.
    try {
      const header = await this.opts.signer.sign(challenge, { x402Version });
      const res = await this.f(url, { headers: { "X-PAYMENT": header } });
      if (res.status !== 200) return { ok: false, error: `settlement failed: HTTP ${res.status}` };
      const headerValue = res.headers.get("x-payment-response");
      const bodyText = await res.text();
      const ref = settlementRef(headerValue, bodyText);
      if (!ref) return { ok: false, error: "settlement response carried no ref" };
      return { ok: true, ref, paidAmount: challenged, raw: { headerValue, bodyText } };
    } catch (e) {
      return { ok: false, error: `settlement failed: ${(e as Error).message}` };
    }
  }
}
