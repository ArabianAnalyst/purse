# Changelog

## 0.4.0 (2026-09-04)

The x402 executor, its types, the mock signer, and the mock 402 server move from the examples into the package as the subpath `@olurabian/purse/x402`. `PaymentRequirements` gains `maxTimeoutSeconds` and `extra` (the EIP-712 domain name and version). `X402Signer.sign` receives the protocol version. No runtime dependencies added. The executor reads the settlement proof from the `X-PAYMENT-RESPONSE` header, plain or base64 JSON, before falling back to a JSON body, so real x402 servers settle correctly.

## 0.3.1 (2026-09-04)

`Broker.execute()` now waits for the audit store to make the decision durable before the executor runs, and for the outcome before it resolves. Adds `Broker.flush()` and `Purse.flush()`. Works with `PostgresStore` from `@olurabian/receipt` 0.2. No breaking changes. A grant whose decision cannot be made durable is released rather than left counted as spent. `execute()` documents both failure cases, before and after the executor runs.

## 0.3.0 (2026-09-04)

Audit records are `@olurabian/receipt` envelopes. Decision fields moved under `payload`. Audit files written by 0.2 are refused with a migration hint.
