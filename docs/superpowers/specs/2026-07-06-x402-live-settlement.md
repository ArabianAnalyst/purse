---
title: Purse x402 — live settlement on Base (real rail)
type: decision
status: draft
serves: "Turn the mock x402 proof into a real settlement with a verifiable tx hash — so the launch claim 'settles over x402 on Base' is literally true, not a mock."
evidence: asserted
confidence: high
tags: [business, science, purse, money-rails, x402, base, usdc, settlement]
links: [[purse-enforcement-mode]], [[harness-engineering]]
created: 2026-07-06
---

# Purse x402 — Live Settlement on Base

**Problem it solves:** the Phase 2 proof settles over a **local x402 mock** — real protocol flow, no real money. To claim "settles over x402 on Base" honestly (with a tx anyone can look up), the broker's executor needs a real signer, a real facilitator, and a real x402 seller to pay. This spec scopes exactly that, changing **only the executor's rail**; the broker, grants, reservations, and audit are untouched.

This is a **design (`evidence: asserted`)** — not yet built. When it is, the exact x402/viem package calls are pinned against the installed versions and turned into a TDD plan.

---

## 1. What changes (and what does not)

Unchanged: `Broker`, `GrantStore`, reservation-aware velocity, the `Executor` interface, the audit chain, the agent/broker process boundary, and the **zero-dependency `src/` core**. The security model is identical — the broker still holds the key, the agent still never sees it.

Changes are confined to a new **`examples/x402/live/`** folder (its own deps, never in core):
1. **A real `X402Signer`** — signs an EIP-3009 `transferWithAuthorization` for USDC with a viem account, replacing `MockSigner`.
2. **A real `toMoney`** — maps USDC atomic units (6 decimals) to the policy's minor units, keeping the ceiling check.
3. **Facilitator + resource config** — the executor probes a real x402 endpoint and settles through a facilitator.
4. **A self-hosted x402 seller endpoint** — a real 402-gated route the broker pays, so the run is end-to-end real without depending on a third party.

The existing `X402Executor` already does probe → **ceiling check** → sign → settle. That structure is why intent-binding survives: we inspect the 402 challenge and reject if it exceeds the grant **before** paying. A convenience client that auto-pays (e.g. `x402-fetch`'s `wrapFetchWithPayment`) would bypass that gate, so we keep the manual two-step and only swap the signer.

---

## 2. Decisions (resolved)

- **Network: Base Sepolia (testnet) by default.** A Sepolia settlement is a *real* x402 settlement with a real tx hash — "settles over x402 on Base, here's the tx" is fully honest, just testnet-value USDC. **Mainnet** is an optional one-shot (~$0.01 real USDC + a Basescan link) kept in reserve for a skeptic, not the default.
- **Topology: pay your own endpoint.** The broker (buyer) pays a seller endpoint you host. Real settlement, no dependency on a stranger's uptime, and you control the price. (An external x402 seller works too but is out of scope here.)
- **Custody unchanged.** The private key lives only in the broker process, from an env var, never committed, never in the agent child.
- **Deps stay out of core.** `examples/x402/live/` gets its own `package.json` (x402 client + viem + a seller middleware). The published `@olurabian/purse` package remains zero-dependency.

---

## 3. Prerequisites (you procure)

1. **A broker wallet** — a fresh EVM key. Generate locally:
   ```bash
   node -e "import('viem/accounts').then(m=>{const pk=m.generatePrivateKey();console.log('PK',pk);console.log('ADDR',m.privateKeyToAccount(pk).address)})"
   ```
   Put the key in `examples/x402/live/.env` as `BROKER_PRIVATE_KEY=0x…` (gitignored).
2. **Base Sepolia ETH** (gas) — a Base Sepolia faucet (Coinbase Developer Platform / Alchemy / QuickNode).
3. **Base Sepolia USDC** — Circle's faucet (faucet.circle.com) dispenses testnet USDC on Base Sepolia. Fund the broker wallet with a few USDC.
4. **A facilitator** — Coinbase CDP's x402 facilitator (a CDP account/key + the facilitator URL). Needed to verify + settle. Set `FACILITATOR_URL` (and any key) in `.env`.
5. **A seller receiving address** — can be a second address you control (or the same wallet). Set `SELLER_ADDRESS`.
6. **Decision:** testnet (default) or a mainnet one-shot. Mainnet swaps the network id, the USDC contract, a funded mainnet wallet, and real (tiny) USDC.

---

## 4. Architecture

### 4.1 Real `toMoney` (USDC 6-dec → USD cents) — concrete
```ts
// Base Sepolia USDC (verify the current contract at build): 6 decimals.
const USDC_BASE_SEPOLIA = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";

export function usdcToUsdCents(reqs: PaymentRequirements, currency: string): Money {
  const bad = { amount: Number.NaN, currency };            // NaN -> the ceiling guard rejects (fail closed)
  if (currency !== "USD") return bad;
  if ((reqs.network ?? "").toLowerCase() !== "base-sepolia") return bad;
  if ((reqs.asset ?? "").toLowerCase() !== USDC_BASE_SEPOLIA) return bad;
  const atomic = Number(reqs.maxAmountRequired);           // atomic USDC (6 decimals)
  if (!Number.isInteger(atomic) || atomic < 0) return bad;
  if (atomic % 10_000 !== 0) return bad;                   // sub-cent price -> reject, never round
  return { amount: atomic / 10_000, currency: "USD" };     // 10^(6-2) = 10^4 atomic per cent
}
```
This validates network + asset (closing the dead-currency gap from Phase 2), rejects sub-cent prices instead of rounding, and keeps the exact ceiling comparison (`challenged ≤ grant`) intact.

### 4.2 Real `X402Signer` (EIP-3009 via viem)
```ts
import { privateKeyToAccount } from "viem/accounts";
// The x402 "exact" scheme on EVM signs an EIP-3009 transferWithAuthorization for USDC.
// Use the x402 client's payment-header builder with a viem account; pin the exact
// function name/signature to the installed x402 package version at build.
export class ViemX402Signer implements X402Signer {
  private account = privateKeyToAccount(process.env.BROKER_PRIVATE_KEY as `0x${string}`);
  async sign(reqs: PaymentRequirements): Promise<string> {
    // Build + sign the authorization for `reqs`, return the base64 X-PAYMENT header value.
    // e.g. createPaymentHeader(this.account, reqs)  — exact API confirmed at build.
    return await buildX402PaymentHeader(reqs, this.account);
  }
}
```
It slots straight into the existing `X402Executor` (`signer` option); nothing else in the executor changes.

### 4.3 Self-hosted x402 seller (`examples/x402/live/seller.ts`)
```ts
import express from "express";
import { paymentMiddleware } from "x402-express"; // exact import pinned at build
const app = express();
app.use(paymentMiddleware(
  process.env.SELLER_ADDRESS!,                                   // receives the USDC
  { "GET /price": { price: "$0.01", network: "base-sepolia" } }, // the priced route
  { url: process.env.FACILITATOR_URL! },                         // facilitator
));
app.get("/price", (_req, res) => res.json({ ok: true, quote: "BTC 64000" }));
app.listen(4021, () => console.log("x402 seller on http://127.0.0.1:4021/price"));
```

### 4.4 Live broker host (`examples/x402/live/broker-host.ts`)
Same shape as the mock `broker-host.ts`, three swaps:
```ts
const broker = new Broker({
  maxPerAction: "$1", maxPerDay: "$1",
  allow: ["dojo.local"],
  requireApprovalOver: "$0.50",
  executor: new X402Executor({
    resolvePayee: (p) => (p === "dojo.local" ? "http://127.0.0.1:4021/price" : undefined),
    signer: new ViemX402Signer(),
    toMoney: usdcToUsdCents,
  }),
});
```
A scripted (or LLM) agent requests `$0.01 → dojo.local`, executes, and the broker settles real testnet USDC.

---

## 5. Verification (the proof)

1. `node seller.ts` (or `tsx`), fund the broker wallet, start the facilitator config.
2. Run the live host; the agent requests `$0.01 → dojo.local` → allowed → execute → **real settlement**.
3. The `Receipt.ref` is the settlement **tx hash**. Confirm it on `sepolia.basescan.org` — USDC moved from the broker wallet to `SELLER_ADDRESS`.
4. The audit `executed` record carries that ref; `verify().ok === true`.
5. **Ceiling still gates against a real challenge:** set the grant below the endpoint's price (or point at a $0.02 route with a $0.01 grant) → executor returns `{ok:false}`, no settlement. This proves intent-binding holds against a real 402, not just the mock.

Capture: the terminal run + the Basescan tx link. That pair is the drop upgrade — "settles over x402 on Base — [tx]," mock caveat gone.

---

## 6. Safety, risks, out of scope

- **Key handling:** `BROKER_PRIVATE_KEY` in a gitignored `.env`, broker process only, never the agent child. Testnet key is low-stakes but still not committed. Mainnet key: treat as real; fund with cents only.
- **Pinned-at-build:** the exact x402 package (`x402` / `x402-fetch` / `x402-express`) function names + the current Base Sepolia USDC contract are confirmed against installed versions when we write the TDD plan — this spec fixes the shape, not the exact SDK symbols.
- **Facilitator dependency:** if the CDP facilitator needs a key or is down, settlement fails closed (executor returns `{ok:false}`) — the enforcement proof is unaffected.
- **Out of scope:** mainnet as the default; paying third-party sellers; wrapping `x402-fetch` auto-pay (rejected — it bypasses the ceiling gate); carrying settled `paidAmount` into the `src/` audit (that is the separate v0.2.1 follow-up).

---

**Inputs → Outputs:** consumes the Phase 2 `X402Executor` + `X402Signer` interfaces and the `examples/x402/` mock scaffolding · produces a real Base settlement (tx hash) → feeds the build-in-public drop (upgrades "mock" to "on Base, here's the tx") and is `evidence-for` [[purse-enforcement-mode]].

## Connected (graph)
Hub: [[SaaS]]  ·  depends-on→[[purse-enforcement-mode]] (Phase 2 executor it extends)  ·  instance-of→[[harness-engineering]] (the Runtime rail, made real)  ·  feeds→the launch drop
