# Purse × x402 — governed agent payments

The `X402Executor` settles a Purse grant over the [x402](https://www.x402.org) protocol
(HTTP 402 Payment Required + per-request stablecoin settlement). It runs **inside the broker
process**; the agent never holds the signer, the wallet, or the resource map.

## What runs today (zero deps, no secrets)

```bash
npm run demo:x402      # two-process governed-agent proof, over a local mock 402 resource
npm test               # includes x402-mock, x402-executor, x402-governed
```

The demo proves, end to end:
1. an in-policy spend settles over x402;
2. a prompt-injected off-allowlist payment is denied;
3. an over-threshold spend settles only after out-of-band principal approval;
4. a split-under-cap burst is blocked by reservation-aware velocity;
5. the tamper-evident audit chain verifies, and each settlement carries its x402 ref.

## Intent-binding at the rail (grant as ceiling)

In x402 the *resource* sets the price and the agent discovers/negotiates it at the rail, so the
grant is the **maximum authorized**, not a fixed number. `X402Executor` probes the resource for
its 402 challenge and **requires the challenged amount to be ≤ the grant amount** (same currency),
failing closed if the vendor demands more than was authorized. It settles the vendor's actual price
and records it as `paidAmount`. A compromised agent can pay *up to* what was authorized — never more.

> Note: the tamper-evident audit currently records the authorized **ceiling** (the grant amount),
> not the actual settled price — Phase 1's `scrubReceipt` keeps only `ok` + `ref`. Carrying the
> settled `paidAmount` into the chain is a small core (`src/`) follow-up, out of this examples-only phase.

## Going live on Base Sepolia (testnet)

The mock speaks in USD cents (`asset: "USD-cents"`, integer minor units) so the executor's
verification logic is exercised without a chain. To settle real testnet USDC:

1. `npm i x402 x402-fetch viem` (these belong to the broker deployment, not the zero-dep core).
2. Implement an `X402Signer` whose `sign()` produces a real EIP-3009 `transferWithAuthorization`
   from a funded Base Sepolia wallet (a `viem` account holding the test key — broker-side only).
3. Point `resolvePayee` at your real x402 resource URLs and configure a facilitator.
4. Provide a `toMoney` that converts USDC's **6-decimal** atomic units to your policy currency's
   minor units (e.g. `5_000_000` atomic USDC → `500` USD cents = divide by `10 ** 4`), keeping the
   ceiling check (challenged ≤ grant) intact.

The private key and facilitator credentials live only in the broker process. The agent client is
unchanged — it still only calls `request` / `execute` / `status`.

## Optional: drive it with a real LLM

```bash
ANTHROPIC_API_KEY=sk-... npm run demo:x402:llm
```

`governed-agent-llm.ts` runs a minimal Claude tool-use loop whose only payment tool is
`PurseClient.execute`, behind the same broker boundary. It is not part of `npm test` (needs an
API key + network) and is non-deterministic — it demonstrates the boundary with a real model.
