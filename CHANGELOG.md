# Changelog

## 0.3.1 (2026-09-04)

`Broker.execute()` now waits for the audit store to make the decision durable before the executor runs, and for the outcome before it resolves. Adds `Broker.flush()` and `Purse.flush()`. Works with `PostgresStore` from `@olurabian/receipt` 0.2. No breaking changes.

## 0.3.0 (2026-09-04)

Audit records are `@olurabian/receipt` envelopes. Decision fields moved under `payload`. Audit files written by 0.2 are refused with a migration hint.
