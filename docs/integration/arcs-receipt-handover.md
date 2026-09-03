# Purse → ARCS, receipt handover

The integration in one line. **Purse produces a signed, hash-chained receipt for every decision. ARCS takes it as-is, verifies it independently, and binds it into the wider trail.** Purse's receipt is the source of truth. ARCS is the witness and aggregator above it, not the root of trust.

A receipt verifies on its own, with nothing from Purse and nothing from ARCS. That property is the whole point, so keep it.

Ships with `purse-sample-receipts.json`, five real receipts from a live Purse run (2 allowed, 1 needs_approval, 2 denied). The chain verifies, and editing any field breaks it.

---

## The receipt

Every `authorize()` call writes one immutable record. That record is the receipt. Shape:

```jsonc
{
  "id": "190f084b-…",                 // uuid, unique per decision
  "ts": "2026-09-03T11:31:36.514Z",   // ISO-8601
  "request": {
    "amount": { "amount": 8000, "currency": "USD" },  // integer MINOR units: 8000 = $80.00
    "payee": "acme-supplies.example",
    "intent": "reorder toner",        // optional
    "category": "…",                  // optional
    "agentId": "agent-7"              // optional
  },
  "status": "needs_approval",         // "allowed" | "denied" | "needs_approval"
  "reason": "needs approval: 80.00 USD is above the auto-approve threshold of 50.00 USD",
  "policyVersion": "4c94d6cb4f21",    // 12-char sha256 prefix of the policy that decided
  "event": "decision",                // "decision" | "grant_minted" | "executed" | "execution_failed" | "grant_expired"
  "explain": {                        // structured why, for audit
    "rule": "require-approval",
    "policyVersion": "4c94d6cb4f21",
    "evaluated": { "amount": { "amount": 8000, "currency": "USD" }, "payee": "acme-supplies.example" },
    "reservation": { … }              // present on velocity/cap decisions
  },
  "grantId": "…",                     // present once a grant is minted (execution path)
  "receipt": { "ok": true, "ref": "…", "paidAmount": { … } },  // present after settlement; scrubbed, never the raw rail payload
  "prevHash": "1f2fb9…",              // hash of the previous record, or 64 zeros for the first
  "hash": "2ed45a…"                   // sha256 over this record, see below
}
```

Two notes that bite if missed:

- **Amounts are integer minor units plus a currency code.** `{ "amount": 8000, "currency": "USD" }` is $80.00, not $8000. Do not divide by 100 blindly, use the currency's minor-unit exponent.
- **Undefined fields are omitted.** `intent`, `category`, `grantId`, `receipt`, `reservation` and friends only appear when set. The hash is computed over what is present.

---

## Verifying a receipt (independently)

The `hash` is SHA-256 over the record's fields in **this exact order**, with `hash` itself excluded and undefined fields omitted:

```js
sha256(JSON.stringify({
  id, ts, request, status, reason, policyVersion, event, explain, grantId, receipt, prevHash
}))
```

The chain: `prevHash` of the first record is 64 zeros (GENESIS). Each subsequent `prevHash` equals the previous record's `hash`. Alter a field and that record's `hash` no longer matches. Insert or drop a record and the `prevHash` linkage breaks.

**You do not need to reimplement this.** `verifyChain` is exported from the public package:

```js
import { verifyChain } from "@olurabian/purse"; // npm i @olurabian/purse

const records = JSON.parse(fs.readFileSync("purse-sample-receipts.json", "utf8"));
verifyChain(records);
// { ok: true }
// on tamper: { ok: false, brokenAt: 0, reason: "hash mismatch (a record was altered)" }
```

If ARCS prefers no dependency, reimplement the two checks above in any language. The only thing that must match byte-for-byte is the field order in the `JSON.stringify`.

---

## Division of labour

- **Purse (enforcer)** decides and writes the receipt. The receipt is verifiable on its own.
- **ARCS (hub)** ingests the receipt, verifies it independently, and anchors its `hash` into the wider KMS-signed trail so a set of receipts across tools becomes one cross-system record.
- ARCS does **not** re-mint or replace the receipt. The enforcer that made the decision owns the proof.

The trail should verify even if ARCS is offline. ARCS is the outside witness that makes a receipt evidence rather than one tool's word, it is not the thing you have to trust to believe the record.

---

## Two decisions to close

1. **Signing.** Receipts are hash-chained today, which is tamper-evident. If we want per-receipt provenance on top, Purse adds an `ed25519` signature over `hash` and hands ARCS the public key. Otherwise the receipt stays hash-chained and ARCS's KMS signature provides the provenance at the trail level. Pick one.
2. **Transport.** How receipts reach ARCS.
   - v1 simplest, Purse exports a JSON or JSONL bundle (exactly like the sample) and ARCS ingests it.
   - or, Purse POSTs each record to an ARCS ingestion endpoint as it is written.
   Agree the easy one first, the receipt shape is the same either way.

---

## Files

- `purse-sample-receipts.json` — five real receipts, `verifyChain` returns `{ ok: true }`.
- Format and chain implementation, `@olurabian/purse` → `src/audit.ts` (`hashRecord`, `verifyChain`).
