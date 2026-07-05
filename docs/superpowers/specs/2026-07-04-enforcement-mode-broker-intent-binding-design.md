---
title: Purse v0.2 — Enforcement Mode (broker + intent-binding + explainable audit)
type: decision
status: draft
serves: "Move Purse from advisory (agent executes) to enforcement (agent cannot execute) — the credential-custody + intent-binding build that makes 'a compromised agent cannot move money outside policy' hold by construction, and the proof layer that shows why every spend was allowed."
evidence: asserted
confidence: high
tags: [business, science, research, purse, money-rails, harness, control-agency-runtime, agents, payments, enforcement, intent-binding, audit]
links: [[harness-engineering]], [[caaf]], [[araba-operation]], [[products-saas]], [[map-your-work]]
created: 2026-07-04
---

# Purse v0.2 — Enforcement Mode

**Problem it solves:** Purse v0.1 decides and logs, but the agent still holds the credential and executes the payment itself — so a compromised agent can ignore the verdict. Enforcement mode removes the agent's ability to execute: the credential moves into a separate broker process, and every settled spend must bind to a single-use grant that policy or a human authorized. The security property stops being a rule the agent chooses to follow and becomes the absence of any other path.

This is a **design (`evidence: asserted`)** — not yet built. It scopes the v0.2 build and is the input to the implementation plan.

---

## 1. Framing — enforcement mode in CAR (Control / Agency / Runtime)

Per [[harness-engineering]], an agent's reliability lives in the **harness layer**, decomposed as Control / Agency / Runtime. Purse enforcement mode is a harness for the *payment action surface*, and each part of this build maps to one CAR layer. Stating it this way positions Purse against industry harness framing (Anthropic / OpenAI) instead of bespoke terms, and makes the design legible as one designed system rather than a bag of features.

| CAR layer | Definition (He et al.) | Purse enforcement mode |
|---|---|---|
| **Control** | Durable artifacts that shape behavior *before* a step | Policy config (allow/deny/caps, `requireApprovalOver`), policy-version hash, the deployment contract. This is Purse v0.1, reused. |
| **Agency** | The *mediated action surface* — how the model may act | The narrow `request` / `execute` interface. **Enforcement = shrinking Agency:** "call the rail" is removed from the agent's action surface; the broker mediates money movement. |
| **Runtime** | State, memory, retries, recovery *over time* | Grants (single-use + expiry), reservation accounting, the tamper-evident audit chain, fail-closed recovery. "Many agent failures are runtime failures — stale state, brittle retry loops" → our no-silent-retry, expiry-releases-reservation, and fail-closed contract are Runtime hygiene. |

The build is therefore: **shrink Agency to a narrow mediated interface, move the credential into a broker-process Runtime, and bind every settled spend to a single-use grant that Control (policy) or a principal authorized — with the audit chain and a HARNESS CARD proving it.**

---

## 2. Architecture — two processes, one credential, one direction of trust

```
   AGENT PROCESS                       BROKER PROCESS
   ┌────────────────┐                  ┌──────────────────────────────┐
   │ agent + tools  │                  │  Broker                       │
   │                │  request  ─────► │   • policy (v0.1 engine)      │  Control
   │  PurseClient   │  execute  ─────► │   • grant store (+ reserve)   │  Runtime
   │  (no cred,     │ ◄───── result    │   • audit store (hash chain)  │  Runtime
   │   no executor) │                  │   • Executor  ← credential    │  (custody)
   └────────────────┘                  └──────────────────────────────┘
        stdio (default) / loopback HTTP        principal API (approve/deny)
                                               ── separate channel, NOT agent-reachable ──
```

- **Agent side** imports only `PurseClient`. No rail key, no `Executor`, no import path to either — they live in a different OS process. The isolation property holds by construction ("it isn't in your address space"), not by convention ("don't call it").
- **Broker side** holds everything that can move money: policy, grants, audit, and the executor + credential.
- **Transport:** line-delimited JSON over **stdio** by default (broker spawned as a child; zero-dependency, `node:` built-ins only). A **loopback HTTP** option uses `node:http` — same narrow interface, and it is the seam Purse Cloud grows along later. Package stays zero-dependency.

### The narrow interface (everything the agent can say — every field validated broker-side)

| Call | Agent → Broker | Broker → Agent |
|---|---|---|
| `request` | `{ amount, payee, intent?, category? }` | `{ decision, grantId?, pendingId?, reason, explain }` |
| `execute` | `{ grantId }` | `{ status: paid \| rejected, receipt?, reason, explain }` |
| `status` | `{ pendingId }` | `{ state: pending \| approved \| denied, grantId? }` |

The agent **cannot** mint grants, approve, read or set policy, reach the executor, or shape what the broker does beyond those four fields. The **principal API** (`approve`, `deny`, `pending`) is a **separate channel the agent process never holds** — that separation is what makes approval "out of band," and it is the deployment-contract requirement that custody and authorization live outside the agent.

---

## 3. The request → grant → execute flow

```
agent.request(spend)
  └─ broker runs policy (Control) →  denied          → audit(denied); done
                                     allowed         → mint grant (policy IS the authorization)
                                                        → return grantId   (small spends stay frictionless)
                                     needs_approval  → create pending; return pendingId

principal.approve(pendingId)          ← human / UI / system, OUT OF BAND (not the agent)
  └─ mint grant bound to that pending's exact payee + amount + intent

agent.execute(grantId)
  └─ grant open & matches? → executor.execute(grant)   ← credential used HERE, only here
       success → grant redeemed (terminal); audit(executed, receipt); return receipt
       failure → grant failed (no silent retry);        audit(execution_failed)
```

**The change from v0.1:** `authorize()` was terminal advice. Here a non-`denied` decision produces a **grant**, and execution is a separate, broker-only step gated on that grant. The agent's `allowed` no longer means "go pay" — it means "the broker will pay, on your behalf, once, this exact thing."

**Small spends vs approved spends (answers "where does intent come from"):**
- `allowed` (under `requireApprovalOver`) → **auto-minted grant**: policy is the authorization; the agent stays frictionless.
- `needs_approval` (over threshold) → grant is minted only when a **principal approves that specific pending request** out of band.

---

## 4. Grants — intent-binding (tightest safe default)

A grant binds to **exactly one intent** and is **single-use with an expiry**:

```ts
interface Grant {
  id: string;
  payee: string;
  amount: Money;                 // exact minor units + currency
  intent?: string; category?: string;
  origin: "policy" | "principal";      // auto-granted vs human-approved
  state: "open" | "redeemed" | "expired" | "failed";
  createdAt: string; expiresAt: string;    // grantTtlMs, default 15 min, configurable
  pendingId?: string;            // set when origin === "principal"
}
```

- `execute(grantId)` **re-validates the bound fields at redemption** — the broker never trusts that the grantId alone is enough (defense in depth against a leaked/guessed id).
- Redeeming flips `open → redeemed` (terminal). A second `execute` on the same grant is **rejected**. Single-use is enforced, not requested.
- Expired grants cannot redeem. Expiry releases the reservation (§5).

### The forgery-vs-misdirection boundary (honesty, stated in-brand)

Capability isolation (the process boundary) stops the agent **forging** the means to pay. Intent-binding stops the agent **misdirecting** a payment it is allowed to request — but only fully for **principal-approved** grants, which bind to an intent a human actually saw. **Auto-granted** small spends are authorized by policy alone, so within the allowlist and caps the agent still chooses payee and amount; the reservation-aware caps + allowlist **bound the blast radius, they do not eliminate it.** This is the same "caps as a backstop, not the authorization" honesty the v0.1 threat model already commits to. We state it; we do not paper over it.

---

## 5. Anti-splitting velocity (deployment-contract item 4 — the subtle one)

v0.1's velocity check summed *executed* spends. That is insufficient here: an agent could `request` many under-cap spends, receive many auto-grants, and `execute` them all — each legal, the sum a drain. So in the broker **an open grant reserves budget**:

```
velocity_used(window) = Σ redeemed executions in window
                      + Σ open, unexpired grants        (reserved, not yet spent)
```

A grant is minted only if `used + this_amount ≤ cap`. Expiry or execution-failure **releases** the reservation. This closes the split-under-the-cap path at *mint* time — the cap becomes a property of reservations, not just settled spends. The reservation math is recorded in the explainability object (§7) so it is provable, not just asserted.

---

## 6. The Executor — credential custody

```ts
interface Executor {
  execute(grant: Grant): Promise<Receipt>;      // performs the real spend
}
interface Receipt {
  ok: boolean;
  ref?: string;                 // rail's transaction id
  paidAmount?: Money;
  error?: string;
  raw?: unknown;                // secrets scrubbed before it reaches audit/explain
}
```

- Constructed **inside the broker process**, handed to the `Broker` at startup with whatever credential it needs. The agent has no reference and no import path to it.
- Core ships a **`MockExecutor`** (deterministic receipts) for the demo and tests. Real adapters — Stripe, x402, Paystack — are separate examples / optional packages, never in the zero-dependency core. The interface is the contract; proving the interface is this build's job, not integrating a rail.

---

## 7. Audit + explainability-as-proof

Same tamper-evident hash chain, richer events, and a **structured `explain` object** alongside the existing human-readable `reason` string. Because `explain` sits inside the hashed, chained record, the *justification is tamper-evident too*: you cannot alter why a spend was allowed without breaking the chain.

**New events** (backward-compatible with v0.1 records via an optional `event` field):
`decision` → `grant_minted` (with `origin`) → `executed` (with `Receipt`) / `execution_failed` / `grant_expired`.

**The explain object:**

```ts
interface Explain {
  rule: "deny-list" | "allowlist-miss" | "per-action-cap" | "velocity" |
        "require-approval" | "within-policy" | "malformed" | "eval-error";
  policyVersion: string;                                   // already present in v0.1
  evaluated: { amount: Money; payee: string; category?: string };
  reservation?: { used: Money; reserved: Money; cap: Money };   // the anti-split math, made provable
  grant?: { id: string; boundTo: { payee: string; amount: Money; intent?: string }; origin: "policy" | "principal" };
  approvedBy?: string;                                     // "policy:auto" | "principal:<id>"
  receipt?: { ok: boolean; ref?: string };                // secrets scrubbed — never the credential
}
```

A single chained record now answers, provably: **what was requested → which rule decided → the exact cap math it fit under → which grant/intent it bound to → who approved → what settled.** This is the jump v0.1 made for *what*, now made for *why*: not "trust our log" but "here is the verifiable reason each spend was permitted." It is the compliance artifact Purse Cloud sells, and the Runtime's proof surface referenced by the HARNESS CARD (§9).

---

## 8. Code structure

v0.1 `Purse` (advisory) stays exported and behavior-unchanged. This is additive.

```
src/
  evaluate.ts   NEW  pure policy rules extracted from policy.ts; velocity ledger injected
  policy.ts     KEEP Purse (advisory) — now calls evaluate() with its audit-record ledger
  grants.ts     NEW  Grant type, GrantStore: mint / redeem / expire + reservation ledger
  executor.ts   NEW  Executor interface, Receipt, MockExecutor
  broker.ts     NEW  Broker: agent-side request/execute + principal-side approve/deny/pending
  client.ts     NEW  PurseClient — thin agent-side client (no cred, no executor)
  server.ts     NEW  broker host: reads narrow requests over transport → Broker → responses
  transport/    NEW  stdio (default, zero-dep) + loopback-http (node:http) framing
  audit.ts      EXT  new event types + explain object; same hash-chain mechanics
```

**One targeted refactor** (the protocol permits improving code you are working in): extract a pure `evaluate(cfg, req, { spentSince })` so both `Purse` (ledger = allowed audit records) and `Broker` (ledger = redeemed + reserved grants) share one policy engine. Small, and it is what makes reservation-aware velocity possible without forking policy logic.

---

## 9. HARNESS CARD (the honest disclosure artifact)

Per [[harness-engineering]], disclose the Control artifacts, the action surface, and the Runtime policy of the agent system. This card ships in the spec and README so a deployer sees exactly what holds and what does not.

- **Control (before the step):** policy config (allow/deny, per-action cap, velocity caps, `requireApprovalOver`, categories); policy-version hash; the v0.1 deployment contract (single path, mediated execution, custody outside the agent, no splitting path, continuous verification).
- **Agency (mediated action surface):** the agent may only call `request`, `execute`, `status`. It cannot call any payment rail, mint grants, approve, or read/set policy. Every field validated broker-side.
- **Runtime (over time):** single-use grants with expiry; reservation-aware velocity; no silent retry on execution failure; fail-closed on every error path; tamper-evident audit chain with structured explainability.
- **What this deployment does NOT guarantee:** misdirection on auto-granted small spends is bounded by caps, not eliminated (§4); continuous capability-surface monitoring is out of scope (§10); the property holds only while the process boundary and single-path deployment hold.

---

## 10. Error handling, testing, and scope line

### Fail-closed everywhere (Runtime recovery contract)
- Broker unreachable / transport error → client returns `denied`, never assumes allowed.
- Grant missing / expired / already-redeemed / field-mismatch → `execute` rejected.
- Executor throws → `execution_failed`, grant marked failed, **no silent retry**.
- Policy evaluation error or malformed request → denied (as v0.1).

### Testing
- **Unit** — grant lifecycle (mint / redeem / expire; double-redeem rejected; tampered `execute` rejected); reservation-aware velocity **blocks the split-under-cap attack**; `evaluate()` parity with v0.1 advisory behavior; explain object shape + secret-scrubbing.
- **Integration** — full flow over the **real transport** with a child broker process + `MockExecutor`, demonstrating the agent process holds no credential; injection tries `execute` with no grant → rejected; over-threshold waits for principal approval then settles.
- **Audit** — chain verifies across the richer event stream; tamper still caught; explain fields are inside the hash.
- **Demo** — extend `demo-agent.ts` into a two-process demo showing all of the above, ending with `verify() === { ok: true }`.

### Explicitly OUT of scope for v0.2 (named so nobody assumes coverage)
- Continuous capability-surface monitoring — its own future spec (design-doc open item).
- Real rail adapters (Stripe / x402 / Paystack) — separate example packages.
- Bounded / multi-use grants ("up to $X, N times") — exact single-use only for now.
- Principal-channel auth / RBAC and the hosted approval UI — that is Purse Cloud, not this library.

---

**Inputs → Outputs:** consumes [[harness-engineering]] (CAR vocabulary + HARNESS CARD), the v0.1 threat model & continuous-verification design (`purse/docs/design/`), and the v0.1 policy/audit/money core · produces the v0.2 enforcement build (broker, grants, executor, explainable audit) → feeds [[products-saas]] and the Money Rails franchise; is `evidence-for` [[caaf]] (a shipped, ownable harness asset).

## Connected (graph)
Hub: [[SaaS]]  ·  instance-of→[[harness-engineering]] (Purse enforcement = a CAR harness for the payment surface)  ·  evidence-for→[[caaf]] (a shipped harness asset = the moat economics)  ·  feeds→[[products-saas]], [[araba-operation]]  ·  lineage←v0.1 threat model + continuous-verification design  ·  depends-on→[[map-your-work]] (node/edge method it is filed under)
