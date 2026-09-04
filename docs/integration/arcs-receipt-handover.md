# Purse → ARCS, receipt handover (spec v1)

The integration in one line. **Purse produces a hash-chained receipt for every decision. ARCS takes it as-is, verifies it independently, and binds it into the wider trail.** Purse's receipt is the source of truth. ARCS is the witness and aggregator above it, not the root of trust.

A receipt verifies on its own, with nothing from Purse and nothing from ARCS. That property is the whole point, so keep it.

Ships with `samples/purse-sample-receipts.json`, five real receipts from a live Purse run (2 allowed, 1 needs_approval, 2 denied), regenerated with `npm run samples`. The chain verifies, and editing any field breaks it.

> **What changed from the previous draft.** Purse now emits the shared Deadlatch receipt envelope from [`@olurabian/receipt`](https://github.com/ArabianAnalyst/receipt). The decision fields moved under `payload`, and the hash covers the envelope. Build against this shape; the earlier flat shape is retired.

---

## The receipt

Every `authorize()` call writes one immutable receipt. It takes this shape.

```jsonc
{
  "id": "6591699b-aac9-4898-9d1e-a8520b86ccb7",                 // uuid, unique per decision
  "ts": "2026-09-04T14:09:47.407Z",   // ISO-8601
  "kind": "decision",                 // Purse receipts are always "decision"
  "payload": {
    "request": {
      "amount": { "amount": 8000, "currency": "USD" },  // integer MINOR units: 8000 = $80.00
      "payee": "acme-supplies.example",
      "intent": "reorder toner",      // optional
      "category": "…",                // optional
      "agentId": "agent-7"            // optional
    },
    "status": "needs_approval",       // "allowed" | "denied" | "needs_approval"
    "reason": "needs approval: 80.00 USD is above the auto-approve threshold of 50.00 USD",
    "policyVersion": "4c94d6cb4f21",  // 12-char sha256 prefix of the policy that decided
    "event": "decision",              // "decision" | "grant_minted" | "executed" | "execution_failed" | "grant_expired"
    "explain": { "rule": "require-approval", "policyVersion": "4c94d6cb4f21", "evaluated": { … } },
    "grantId": "…",                   // present once a grant is minted
    "receipt": { "ok": true, "ref": "…", "paidAmount": { … } }  // present after settlement; scrubbed
  },
  "prevHash": "cef2c8ec11e916738d1edb637789b301ebcd770680e4b453a1b9ad9f342a1fd7",              // hash of the previous receipt, or 64 zeros for the first
  "hash": "6c057488c6bc7bb6fb99a2551afb62d3645dbd913786aff2a5d0c18abddfcc19"                   // sha256 over the envelope, see below
}
```

Two notes that bite if missed.

- **Amounts are integer minor units plus a currency code.** `{ "amount": 8000, "currency": "USD" }` is $80.00. Use the currency's minor-unit exponent, do not divide by 100 blindly.
- **Undefined fields are omitted.** Optional payload fields only appear when set. The hash is computed over what is present.

---

## Verifying a receipt (independently)

The `hash` is SHA-256 over the envelope's fields in **this exact order**, with `hash` itself excluded.

```js
sha256(JSON.stringify({ id, ts, kind, payload, prevHash }))
```

`payload` is serialized exactly as the producer wrote it (the parsed object's key order). In the chain, `prevHash` of the first receipt is 64 zeros. Each subsequent `prevHash` equals the previous receipt's `hash`. Alter a field and that receipt's `hash` no longer matches. Insert, drop, or reorder a receipt and the `prevHash` linkage breaks.

**You do not need to reimplement this.** The verifier is a zero-dependency package.

```js
import { verifyChain } from "@olurabian/receipt"; // npm i @olurabian/receipt

const records = JSON.parse(fs.readFileSync("purse-sample-receipts.json", "utf8"));
verifyChain(records);
// { ok: true }
// on tamper: { ok: false, brokenAt: 0, id: "32d9ad7f-218b-440b-939e-8164234f2a81", reason: "hash mismatch (a record was altered)" }
```

`@olurabian/purse` re-exports the same `verifyChain`. If ARCS prefers no dependency, reimplement the two checks above in any language; the only thing that must match byte for byte is the `JSON.stringify` key order.

---

## Division of labour

- **Purse (enforcer)** decides and writes the receipt. The receipt is verifiable on its own.
- **ARCS (hub)** ingests the receipt, verifies it independently, and anchors its `hash` into the wider KMS-signed trail so a set of receipts across tools becomes one cross-system record.
- ARCS does **not** re-mint or replace the receipt. The enforcer that made the decision owns the proof.

The trail should verify even if ARCS is offline. ARCS is the outside witness that makes a receipt evidence rather than one tool's word, it is not the thing you have to trust to believe the record.

---

## Two decisions to close

1. **Signing.** Receipts are hash-chained, which is tamper-evident. If we want per-receipt provenance on top, Purse adds an `ed25519` signature over `hash` and hands ARCS the public key. Otherwise ARCS's KMS signature provides provenance at the trail level. Proposed for v1, no per-receipt signing, with KMS handling provenance at the trail.
2. **Transport.** v1 simplest, Purse exports a JSON or JSONL bundle (exactly like the sample) and ARCS ingests it. Or Purse POSTs each receipt to an ARCS endpoint as it is written. Agree the easy one first; the receipt shape is the same either way.

---

## Files

- `samples/purse-sample-receipts.json` holds five real receipts. `verifyChain` returns `{ ok: true }`. Regenerate with `npm run samples`.
- The envelope, canonicalization, and verifier live in `@olurabian/receipt`, `src/hash.ts` and `src/chain.ts`.
- Purse's decision payload type lives in `@olurabian/purse`, `src/types.ts` (`DecisionPayload`).
