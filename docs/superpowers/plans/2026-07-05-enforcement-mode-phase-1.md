# Purse v0.2 Enforcement Mode — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add enforcement mode to Purse — a broker process that holds the credential and executes payments, so the agent can only *request* spends and *redeem* single-use grants that policy or a human approved, with an explainable tamper-evident audit trail.

**Architecture:** The v0.1 `Purse` (advisory) stays untouched and exported. A pure `evaluate()` function is extracted so both `Purse` (ledger = allowed audit records) and the new `Broker` (ledger = redeemed + reserved grants) share one policy engine. The `Broker` runs in a parent process holding the `Executor` (credential); the agent runs as a spawned child holding only `PurseClient`, which talks to the broker over the Node child-process IPC channel. Every non-denied decision mints a `Grant`; execution is a separate broker-only step gated on that grant. Open grants reserve budget so a split-under-cap attack is blocked at mint time. Each lifecycle event writes a hash-chained audit record carrying a structured `Explain` object.

**Tech Stack:** TypeScript (ES2022, ESM, `strict`, `noUncheckedIndexedAccess`), Node ≥18 built-ins only (`node:crypto`, `node:child_process`, `node:http`), `tsx` for running TS, zero runtime dependencies in core. Tests are plain `check(name, cond)` scripts (no framework), matching `test/policy.test.ts`.

## Global Constraints

- **Zero runtime dependencies in `src/`.** Only `node:` built-ins. (MCP SDK + zod stay `optionalDependencies`; x402 is Phase 2 and lives under `examples/`.)
- **Fail closed everywhere.** Any error, unreachable broker, or unreadable request results in `denied` / `rejected` — never `allowed` / `paid`.
- **Money is integer minor units** via `parseMoney` / `Money` (`src/money.ts`). Never floats. One currency per policy; never convert.
- **Do not change v0.1 public behavior.** `Purse` (advisory) keeps its current API and must keep `test/policy.test.ts` green.
- **Credential/executor live only in the broker process.** No import path to `Executor` or a rail credential from the agent/client side.
- **TS strict + `noUncheckedIndexedAccess`.** Guard array/`Map` access (`x[i]!` only when provably present).
- **ESM imports use no file extension** in this project (bundler resolution), matching existing `src/` imports.
- Run a single test file with: `npx tsx test/<name>.test.ts`. Build with `npm run build` (`tsc`).

---

### Task 1: Extract pure `evaluate()` + Explain foundation; refactor `Purse` to use it

**Files:**
- Create: `src/evaluate.ts`
- Modify: `src/types.ts` (add `ExplainRule`, `Explain`; extend `Decision` with optional `explain`)
- Modify: `src/policy.ts` (refactor `evaluate`/`decide` to call the shared function; move glob helpers out)
- Test: `test/evaluate.test.ts`

**Interfaces:**
- Consumes: `PolicyConfig`, `NormalizedRequest`, `DecisionStatus` (`src/types.ts`); `Money`, `parseMoney`, `format`, `gt`, `add`, `assertSameCurrency` (`src/money.ts`).
- Produces:
  - `type ExplainRule = "deny-list" | "allowlist-miss" | "category" | "per-action-cap" | "velocity" | "require-approval" | "within-policy" | "malformed" | "eval-error"`
  - `interface Explain { rule: ExplainRule; policyVersion: string; evaluated: { amount: Money; payee: string; category?: string }; reservation?: { used: Money; reserved: Money; cap: Money }; grant?: { id: string; boundTo: { payee: string; amount: Money; intent?: string }; origin: "policy" | "principal" }; approvedBy?: string; receipt?: { ok: boolean; ref?: string } }`
  - `interface Ledger { spentSince(sinceMs: number, currency: string): Money }` (in `evaluate.ts`)
  - `interface EvaluationResult { status: DecisionStatus; reason: string; rule: ExplainRule; reservation?: { used: Money; reserved: Money; cap: Money } }` (in `evaluate.ts`)
  - `function evaluate(cfg: PolicyConfig, req: NormalizedRequest, ledger: Ledger, currency: string, nowMs: number): EvaluationResult`

- [ ] **Step 1: Add shared types to `src/types.ts`**

Append to `src/types.ts`:

```ts
import type { Money } from "./money"; // already imported at top — do not duplicate

export type ExplainRule =
  | "deny-list" | "allowlist-miss" | "category" | "per-action-cap"
  | "velocity" | "require-approval" | "within-policy" | "malformed" | "eval-error";

export interface Explain {
  rule: ExplainRule;
  policyVersion: string;
  evaluated: { amount: Money; payee: string; category?: string };
  reservation?: { used: Money; reserved: Money; cap: Money };
  grant?: { id: string; boundTo: { payee: string; amount: Money; intent?: string }; origin: "policy" | "principal" };
  approvedBy?: string;
  receipt?: { ok: boolean; ref?: string };
}
```

Add `explain?: Explain;` to the existing `Decision` interface.

- [ ] **Step 2: Write the failing test** — `test/evaluate.test.ts`

```ts
import { evaluate, type Ledger } from "../src/evaluate";
import { parseMoney, zero } from "../src/money";
import type { NormalizedRequest } from "../src/types";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

const empty: Ledger = { spentSince: (_s, c) => zero(c) };
function req(amount: string, payee: string, category?: string): NormalizedRequest {
  return { amount: parseMoney(amount, "USD"), payee, category };
}

// rule reporting
check("deny-list rule", evaluate({ deny: ["evil.io"] }, req("$1", "evil.io"), empty, "USD", 0).rule === "deny-list");
check("allowlist-miss rule", evaluate({ allow: ["ok.com"] }, req("$1", "x.io"), empty, "USD", 0).rule === "allowlist-miss");
check("per-action-cap rule", evaluate({ maxPerAction: "$5" }, req("$6", "x"), empty, "USD", 0).rule === "per-action-cap");
check("within-policy rule", evaluate({}, req("$1", "x"), empty, "USD", 0).rule === "within-policy");
check("require-approval status", evaluate({ requireApprovalOver: "$2" }, req("$3", "x"), empty, "USD", 0).status === "needs_approval");

// velocity uses injected ledger + reservation reported
{
  const used = parseMoney("$3", "USD");
  const ledger: Ledger = { spentSince: (_s, c) => (c === "USD" ? used : zero(c)) };
  const r = evaluate({ maxPerDay: "$3" }, req("$1", "x"), ledger, "USD", 86_400_001);
  check("velocity denies over cap", r.status === "denied" && r.rule === "velocity");
  check("velocity reports reservation", r.reservation?.cap.amount === 300 && r.reservation?.used.amount === 300);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx test/evaluate.test.ts`
Expected: FAIL — cannot find module `../src/evaluate`.

- [ ] **Step 4: Create `src/evaluate.ts`**

```ts
// evaluate.ts — the pure policy engine, shared by Purse (advisory) and Broker (enforcement).
// The caller injects a Ledger (how much has been spent/reserved) and the clock, so this
// function is deterministic and side-effect free.
import type { PolicyConfig, NormalizedRequest, DecisionStatus, ExplainRule } from "./types";
import { parseMoney, format, gt, add, assertSameCurrency, type Money } from "./money";

export interface Ledger {
  spentSince(sinceMs: number, currency: string): Money;
}

export interface EvaluationResult {
  status: DecisionStatus;
  reason: string;
  rule: ExplainRule;
  reservation?: { used: Money; reserved: Money; cap: Money };
}

export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}
export function matchesAny(value: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(value));
}

export function evaluate(
  cfg: PolicyConfig,
  req: NormalizedRequest,
  ledger: Ledger,
  currency: string,
  nowMs: number,
): EvaluationResult {
  if (cfg.deny && matchesAny(req.payee, cfg.deny))
    return { status: "denied", reason: `denied: payee "${req.payee}" is blocked`, rule: "deny-list" };

  if (cfg.allow && cfg.allow.length > 0 && !matchesAny(req.payee, cfg.allow))
    return { status: "denied", reason: `denied: payee "${req.payee}" is not on the allowlist`, rule: "allowlist-miss" };

  if (cfg.categories && cfg.categories.length > 0) {
    if (!req.category || !cfg.categories.includes(req.category))
      return { status: "denied", reason: `denied: category "${req.category ?? "none"}" is not permitted`, rule: "category" };
  }

  if (cfg.maxPerAction !== undefined) {
    const cap = parseMoney(cfg.maxPerAction, currency);
    assertSameCurrency(req.amount, cap);
    if (gt(req.amount, cap))
      return { status: "denied", reason: `denied: ${format(req.amount)} exceeds the per-action cap of ${format(cap)}`, rule: "per-action-cap" };
  }

  const windows: Array<{ cap: Money; windowMs: number; label: string }> = [];
  if (cfg.maxPerDay !== undefined) windows.push({ cap: parseMoney(cfg.maxPerDay, currency), windowMs: 86_400_000, label: "daily" });
  if (cfg.maxPerWindow !== undefined) windows.push({ cap: parseMoney(cfg.maxPerWindow.amount, currency), windowMs: cfg.maxPerWindow.windowMs, label: "window" });
  for (const w of windows) {
    const used = ledger.spentSince(nowMs - w.windowMs, req.amount.currency);
    const projected = add(used, req.amount);
    if (gt(projected, w.cap))
      return {
        status: "denied",
        reason: `denied: would exceed the ${w.label} cap of ${format(w.cap)} (${format(used)} already used)`,
        rule: "velocity",
        reservation: { used, reserved: req.amount, cap: w.cap },
      };
  }

  if (cfg.requireApprovalOver !== undefined) {
    const threshold = parseMoney(cfg.requireApprovalOver, currency);
    assertSameCurrency(req.amount, threshold);
    if (gt(req.amount, threshold))
      return { status: "needs_approval", reason: `needs approval: ${format(req.amount)} is above the auto-approve threshold of ${format(threshold)}`, rule: "require-approval" };
  }

  return { status: "allowed", reason: "within policy", rule: "within-policy" };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx test/evaluate.test.ts`
Expected: PASS — `7 passed, 0 failed`.

- [ ] **Step 6: Refactor `src/policy.ts` to use `evaluate()`** (keep v0.1 behavior)

Replace the body of `evaluate`/`checkVelocity` usage in the `Purse` class. Delete the private `globToRegExp`/`matchesAny`/`evaluate`/`checkVelocity` methods and the now-unused imports, then wire the shared function:

```ts
// at top of policy.ts, replace the glob/money import block with:
import { evaluate, type Ledger } from "./evaluate";
import { parseMoney, format, add, zero, type Money } from "./money";
import type { PolicyConfig, AuthorizeRequest, NormalizedRequest, Decision, DecisionStatus, Explain, ExplainRule } from "./types";
```

Inside the class, replace the old `evaluate(...)` call site in `authorize` with:

```ts
  authorize(req: AuthorizeRequest): Decision {
    let normalized: NormalizedRequest;
    try {
      normalized = {
        amount: parseMoney(req.amount, this.currency),
        payee: req.payee, intent: req.intent, category: req.category, agentId: req.agentId,
      };
    } catch (e) {
      const safe: NormalizedRequest = { amount: zero(this.currency), payee: String(req.payee ?? "?") };
      return this.decide(safe, "denied", `denied: malformed request (${(e as Error).message})`, "malformed");
    }
    try {
      const ledger: Ledger = { spentSince: (s, c) => this.spentSince(s, c) };
      const ev = evaluate(this.cfg, normalized, ledger, this.currency, Date.now());
      return this.decide(normalized, ev.status, ev.reason, ev.rule, ev.reservation);
    } catch (e) {
      return this.decide(normalized, "denied", `denied: policy evaluation failed (${(e as Error).message})`, "eval-error");
    }
  }
```

Update `decide` to build and attach an `Explain` (keeps `makeRecord` call as-is for now — Task 2 changes its signature):

```ts
  private decide(
    req: NormalizedRequest, status: DecisionStatus, reason: string,
    rule: ExplainRule, reservation?: Explain["reservation"],
  ): Decision {
    const explain: Explain = {
      rule, policyVersion: this.policyVersion,
      evaluated: { amount: req.amount, payee: req.payee, category: req.category },
      reservation,
    };
    const rec = makeRecord(this.store, req, status, reason, this.policyVersion);
    return {
      status, reason, request: req, recordId: rec.id, explain,
      approvalId: status === "needs_approval" ? rec.id : undefined,
    };
  }
```

Keep `spentSince`, `audit`, `verify` unchanged.

- [ ] **Step 7: Verify advisory parity + build**

Run: `npx tsx test/policy.test.ts`
Expected: PASS — existing checks all `ok` (no behavior change).
Run: `npm run build`
Expected: `tsc` exits 0, no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/evaluate.ts src/types.ts src/policy.ts test/evaluate.test.ts
git commit -m "refactor: extract pure evaluate() + Explain foundation; Purse uses it"
```

---

### Task 2: Extend the audit record with `event` + `explain` (backward-compatible chain)

**Files:**
- Modify: `src/types.ts` (extend `AuditRecord`; add `AuditEvent`)
- Modify: `src/audit.ts` (`makeRecord` takes an input object; `hashRecord` covers new fields)
- Modify: `src/policy.ts` (update the `makeRecord` call to the new signature; pass `explain`)
- Test: `test/audit-explain.test.ts`

**Interfaces:**
- Consumes: `AuditRecord`, `NormalizedRequest`, `DecisionStatus`, `Explain` (`src/types.ts`); `AuditStore` (`src/audit.ts`).
- Produces:
  - `type AuditEvent = "decision" | "grant_minted" | "executed" | "execution_failed" | "grant_expired"`
  - `interface RecordInput { request: NormalizedRequest; status: DecisionStatus; reason: string; policyVersion: string; event?: AuditEvent; explain?: Explain; grantId?: string; receipt?: { ok: boolean; ref?: string } }`
  - `function makeRecord(store: AuditStore, input: RecordInput): AuditRecord`

- [ ] **Step 1: Extend types** — in `src/types.ts`

Add:

```ts
export type AuditEvent = "decision" | "grant_minted" | "executed" | "execution_failed" | "grant_expired";
```

Add these optional fields to the existing `AuditRecord` interface (after `reason`):

```ts
  event?: AuditEvent;
  explain?: Explain;
  grantId?: string;
  receipt?: { ok: boolean; ref?: string };
```

- [ ] **Step 2: Write the failing test** — `test/audit-explain.test.ts`

```ts
import { JsonlAuditStore, makeRecord, verifyChain, hashRecord } from "../src/audit";
import { parseMoney } from "../src/money";
import type { NormalizedRequest, Explain } from "../src/types";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

const req: NormalizedRequest = { amount: parseMoney("$1", "USD"), payee: "x" };
const explain: Explain = { rule: "within-policy", policyVersion: "v1", evaluated: { amount: req.amount, payee: "x" } };

const store = new JsonlAuditStore();
makeRecord(store, { request: req, status: "allowed", reason: "ok", policyVersion: "v1", event: "decision", explain });
makeRecord(store, { request: req, status: "allowed", reason: "paid", policyVersion: "v1", event: "executed", receipt: { ok: true, ref: "r1" } });

check("chain with explain verifies", verifyChain(store.all()).ok === true);
check("explain is persisted", store.all()[0]!.explain?.rule === "within-policy");
check("event is persisted", store.all()[1]!.event === "executed");

// tampering the explain breaks the chain
const tampered = store.all();
tampered[0]!.explain!.rule = "deny-list";
check("tampered explain is detected", verifyChain(tampered).ok === false);

// a v0.1-shaped record (no event/explain) still hashes stably
const legacy = { id: "a", ts: "2026-01-01T00:00:00.000Z", request: req, status: "allowed" as const, reason: "ok", policyVersion: "v1", prevHash: "0".repeat(64) };
const h1 = hashRecord(legacy);
const h2 = hashRecord({ ...legacy, event: undefined, explain: undefined });
check("undefined new fields do not change legacy hash", h1 === h2);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx test/audit-explain.test.ts`
Expected: FAIL — `makeRecord` current signature is `(store, request, status, reason, policyVersion)`, so the object-argument call is a type error / wrong shape.

- [ ] **Step 4: Update `src/audit.ts`**

Replace `hashRecord` and `makeRecord`:

```ts
/** Deterministic hash over every field except `hash` itself. Undefined fields are omitted by JSON.stringify, so v0.1 records hash identically. */
export function hashRecord(rec: Omit<AuditRecord, "hash">): string {
  const payload = JSON.stringify({
    id: rec.id,
    ts: rec.ts,
    request: rec.request,
    status: rec.status,
    reason: rec.reason,
    policyVersion: rec.policyVersion,
    event: rec.event,
    explain: rec.explain,
    grantId: rec.grantId,
    receipt: rec.receipt,
    prevHash: rec.prevHash,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export interface RecordInput {
  request: NormalizedRequest;
  status: DecisionStatus;
  reason: string;
  policyVersion: string;
  event?: AuditEvent;
  explain?: Explain;
  grantId?: string;
  receipt?: { ok: boolean; ref?: string };
}

/** Build, hash, and append a record. Returns the finished record. */
export function makeRecord(store: AuditStore, input: RecordInput): AuditRecord {
  const base: Omit<AuditRecord, "hash"> = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    request: input.request,
    status: input.status,
    reason: input.reason,
    policyVersion: input.policyVersion,
    event: input.event,
    explain: input.explain,
    grantId: input.grantId,
    receipt: input.receipt,
    prevHash: store.lastHash(),
  };
  const rec: AuditRecord = { ...base, hash: hashRecord(base) };
  store.append(rec);
  return rec;
}
```

Update the imports at the top of `src/audit.ts` to include the new types:

```ts
import type { AuditRecord, NormalizedRequest, DecisionStatus, AuditEvent, Explain } from "./types";
```

> Note: because `hashRecord` now lists new keys, a `JsonlAuditStore` pointed at a **v0.1 audit file** re-hashes each legacy record with `event/explain/grantId/receipt` all `undefined` — `JSON.stringify` omits them, so the bytes and therefore the hash are identical to what v0.1 wrote. Existing chains keep verifying.

- [ ] **Step 5: Update the `makeRecord` call in `src/policy.ts`**

In `decide`, change the record call to pass the object and the explain:

```ts
    const rec = makeRecord(this.store, {
      request: req, status, reason, policyVersion: this.policyVersion,
      event: "decision", explain,
    });
```

- [ ] **Step 6: Run tests + build**

Run: `npx tsx test/audit-explain.test.ts`
Expected: PASS — `5 passed, 0 failed`.
Run: `npx tsx test/policy.test.ts`
Expected: PASS — advisory still green (records now carry `event:"decision"` + `explain`, chain still verifies).
Run: `npm run build`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/audit.ts src/policy.ts test/audit-explain.test.ts
git commit -m "feat: audit records carry event + explain (backward-compatible chain)"
```

---

### Task 3: `Executor` interface, `Receipt`, and `MockExecutor`

**Files:**
- Create: `src/executor.ts`
- Test: `test/executor.test.ts`

**Interfaces:**
- Consumes: `Money` (`src/money.ts`); `Grant` (`src/grants.ts`, Task 4) — for typing only, so `executor.ts` imports the `Grant` **type**. To avoid a forward dependency, `executor.ts` defines `Executor` against a minimal structural shape it needs.
- Produces:
  - `interface Receipt { ok: boolean; ref?: string; paidAmount?: Money; error?: string; raw?: unknown }`
  - `interface Payable { id: string; payee: string; amount: Money }` (the subset of a Grant an executor needs)
  - `interface Executor { execute(grant: Payable): Promise<Receipt> }`
  - `class MockExecutor implements Executor` with constructor `{ fail?: boolean }`
  - `function scrubReceipt(r: Receipt): { ok: boolean; ref?: string }`

- [ ] **Step 1: Write the failing test** — `test/executor.test.ts`

```ts
import { MockExecutor, scrubReceipt } from "../src/executor";
import { parseMoney } from "../src/money";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

const payable = { id: "g_1234abcd", payee: "api.stripe.com", amount: parseMoney("$5", "USD") };

const ok = await new MockExecutor().execute(payable);
check("mock succeeds by default", ok.ok === true && typeof ok.ref === "string");
check("mock echoes paid amount", ok.paidAmount?.amount === 500);

const bad = await new MockExecutor({ fail: true }).execute(payable);
check("mock can be forced to fail", bad.ok === false && typeof bad.error === "string");

const scrubbed = scrubReceipt({ ok: true, ref: "r1", raw: { secret: "sk_live_xxx" } });
check("scrub drops raw/secret fields", (scrubbed as Record<string, unknown>).raw === undefined && scrubbed.ref === "r1");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx test/executor.test.ts`
Expected: FAIL — cannot find module `../src/executor`.

- [ ] **Step 3: Create `src/executor.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx test/executor.test.ts`
Expected: PASS — `4 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/executor.ts test/executor.test.ts
git commit -m "feat: Executor interface + Receipt + MockExecutor + scrubReceipt"
```

---

### Task 4: `Grant` + `GrantStore` (mint / claim / expire)

**Files:**
- Create: `src/grants.ts`
- Test: `test/grants.test.ts`

**Interfaces:**
- Consumes: `NormalizedRequest` (`src/types.ts`); `Money` (`src/money.ts`); `randomUUID` (`node:crypto`).
- Produces:
  - `type GrantState = "open" | "redeemed" | "expired" | "failed"`
  - `type GrantOrigin = "policy" | "principal"`
  - `interface Grant { id: string; payee: string; amount: Money; intent?: string; category?: string; origin: GrantOrigin; state: GrantState; createdAt: string; expiresAt: string; pendingId?: string }`
  - `class GrantStore` with: `constructor(ttlMs: number, now?: () => number)`, `mint(req: NormalizedRequest, origin: GrantOrigin, pendingId?: string): Grant`, `get(id: string): Grant | undefined`, `claim(id: string): { ok: true; grant: Grant } | { ok: false; reason: string }`, `markRedeemed(id: string): void`, `markFailed(id: string): void`, `spentSince(sinceMs: number, currency: string): Money`

- [ ] **Step 1: Write the failing test** — `test/grants.test.ts`

```ts
import { GrantStore } from "../src/grants";
import { parseMoney } from "../src/money";
import type { NormalizedRequest } from "../src/types";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}
function req(amount: string, payee = "x"): NormalizedRequest {
  return { amount: parseMoney(amount, "USD"), payee };
}

// controllable clock
let t = 1_000_000;
const store = new GrantStore(60_000, () => t); // 60s ttl

const g = store.mint(req("$5"), "policy");
check("mint returns an open grant", g.state === "open");
check("mint sets expiry from ttl", new Date(g.expiresAt).getTime() === 1_060_000);

const c1 = store.claim(g.id);
check("first claim succeeds", c1.ok === true);
store.markRedeemed(g.id);
const c2 = store.claim(g.id);
check("second claim on redeemed grant is rejected", c2.ok === false);

// expiry
const g2 = store.mint(req("$2"), "policy");
t = 1_000_000 + 60_001; // advance past ttl
const c3 = store.claim(g2.id);
check("expired grant cannot be claimed", c3.ok === false && c3.reason.includes("expired"));

// unknown id
check("unknown grant id is rejected", store.claim("nope").ok === false);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx test/grants.test.ts`
Expected: FAIL — cannot find module `../src/grants`.

- [ ] **Step 3: Create `src/grants.ts`**

```ts
// grants.ts — single-use, time-boxed authorizations. A grant binds one intent
// (payee + amount). claim() is atomic in single-threaded Node: it flips open->redeemed
// with no await inside, so two concurrent execute() calls cannot both claim the same grant.
import { randomUUID } from "node:crypto";
import type { NormalizedRequest } from "./types";
import type { Money } from "./money";

export type GrantState = "open" | "redeemed" | "expired" | "failed";
export type GrantOrigin = "policy" | "principal";

export interface Grant {
  id: string;
  payee: string;
  amount: Money;
  intent?: string;
  category?: string;
  origin: GrantOrigin;
  state: GrantState;
  createdAt: string;
  expiresAt: string;
  pendingId?: string;
}

export class GrantStore {
  private grants = new Map<string, Grant>();
  constructor(private ttlMs: number, private now: () => number = () => Date.now()) {}

  mint(req: NormalizedRequest, origin: GrantOrigin, pendingId?: string): Grant {
    const ts = this.now();
    const g: Grant = {
      id: randomUUID(),
      payee: req.payee,
      amount: req.amount,
      intent: req.intent,
      category: req.category,
      origin,
      state: "open",
      createdAt: new Date(ts).toISOString(),
      expiresAt: new Date(ts + this.ttlMs).toISOString(),
      pendingId,
    };
    this.grants.set(g.id, g);
    return g;
  }

  get(id: string): Grant | undefined {
    return this.grants.get(id);
  }

  private isExpired(g: Grant): boolean {
    return this.now() >= new Date(g.expiresAt).getTime();
  }

  /** Atomically take a redeemable grant. On success the grant is marked redeemed. */
  claim(id: string): { ok: true; grant: Grant } | { ok: false; reason: string } {
    const g = this.grants.get(id);
    if (!g) return { ok: false, reason: "grant not found" };
    if (g.state !== "open") return { ok: false, reason: `grant is ${g.state}` };
    if (this.isExpired(g)) { g.state = "expired"; return { ok: false, reason: "grant expired" }; }
    g.state = "redeemed"; // reserve the redemption before any async execution
    return { ok: true, grant: g };
  }

  markRedeemed(id: string): void { const g = this.grants.get(id); if (g) g.state = "redeemed"; }
  markFailed(id: string): void { const g = this.grants.get(id); if (g) g.state = "failed"; }

  /**
   * Reservation-aware ledger: settled spend (redeemed) PLUS open, unexpired grants
   * (reserved but not yet executed). Expired/failed grants release their reservation.
   * This is what makes the split-under-cap attack impossible at mint time.
   */
  spentSince(sinceMs: number, currency: string): Money {
    let total = 0;
    const nowMs = this.now();
    for (const g of this.grants.values()) {
      if (g.amount.currency !== currency) continue;
      if (new Date(g.createdAt).getTime() < sinceMs) continue;
      if (g.state === "redeemed") { total += g.amount.amount; continue; }
      if (g.state === "open" && nowMs < new Date(g.expiresAt).getTime()) { total += g.amount.amount; continue; }
      // expired or failed → released, not counted
    }
    return { amount: total, currency };
  }
}
```

> Note: `claim()` sets `state = "redeemed"` up front (optimistic reservation). The broker (Task 6) calls the executor after a successful claim; if the executor throws or returns `ok:false`, the broker calls `markFailed(id)` to release the reservation and record the failure. This prevents a double-spend across the `await` inside `execute()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx test/grants.test.ts`
Expected: PASS — `6 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/grants.ts test/grants.test.ts
git commit -m "feat: Grant + GrantStore with atomic claim and expiry"
```

---

### Task 5: Reservation-aware velocity — prove the anti-splitting property

**Files:**
- Test: `test/grants-reservation.test.ts` (no `src` change if Task 4's `spentSince` is complete; this task exists to lock the anti-split invariant behind its own reviewer gate and to catch regressions.)

**Interfaces:**
- Consumes: `GrantStore` (Task 4); `evaluate`, `Ledger` (Task 1).

- [ ] **Step 1: Write the failing test** — `test/grants-reservation.test.ts`

```ts
import { GrantStore } from "../src/grants";
import { evaluate, type Ledger } from "../src/evaluate";
import { parseMoney } from "../src/money";
import type { NormalizedRequest } from "../src/types";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}
function req(amount: string, payee = "x"): NormalizedRequest {
  return { amount: parseMoney(amount, "USD"), payee };
}

let t = 5_000_000;
const store = new GrantStore(600_000, () => t); // 10 min ttl
const ledger: Ledger = { spentSince: (s, c) => store.spentSince(s, c) };
const cfg = { maxPerDay: "$3.00" };

// Simulate the split-under-cap attack: mint under-cap grants without executing them.
store.mint(req("$2.00"), "policy"); // reserves $2 of the $3 daily cap

// A second $2 request must now be denied by reservation, even though nothing executed.
const ev = evaluate(cfg, req("$2.00"), ledger, "USD", t);
check("open grant reserves budget (split attack blocked)", ev.status === "denied" && ev.rule === "velocity");

// A $1 request still fits ($2 reserved + $1 = $3 <= cap).
check("remaining budget still spendable", evaluate(cfg, req("$1.00"), ledger, "USD", t).status === "allowed");

// Let the reservation expire → budget is released.
t = 5_000_000 + 600_001;
check("expired reservation is released", evaluate(cfg, req("$2.00"), ledger, "USD", t).status === "allowed");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it passes** (Task 4 already implements the behavior)

Run: `npx tsx test/grants-reservation.test.ts`
Expected: PASS — `3 passed, 0 failed`. If any check fails, fix `GrantStore.spentSince` to count open-unexpired + redeemed grants and exclude expired/failed.

- [ ] **Step 3: Commit**

```bash
git add test/grants-reservation.test.ts
git commit -m "test: lock reservation-aware velocity (split-under-cap blocked)"
```

---

### Task 6: `Broker` — request / execute / approve / deny / status / pending (in-process)

**Files:**
- Create: `src/broker.ts`
- Test: `test/broker.test.ts`

**Interfaces:**
- Consumes: `evaluate`, `Ledger` (Task 1); `makeRecord`, `JsonlAuditStore`, `AuditStore`, `verifyChain` (`src/audit.ts`); `GrantStore`, `Grant` (Task 4); `Executor`, `scrubReceipt` (Task 3); `parseMoney`, `zero` (`src/money.ts`); `createHash` (`node:crypto`).
- Produces:
  - `interface BrokerOptions extends PolicyConfig { executor: Executor; grantTtlMs?: number; store?: AuditStore; auditFile?: string; now?: () => number }`
  - `interface RequestResult { decision: DecisionStatus; grantId?: string; pendingId?: string; reason: string; explain: Explain }`
  - `interface ExecuteResult { status: "paid" | "rejected"; receipt?: { ok: boolean; ref?: string }; reason: string }`
  - `interface StatusResult { state: "pending" | "approved" | "denied" | "unknown"; grantId?: string }`
  - `interface PendingView { id: string; payee: string; amount: Money; intent?: string; createdAt: string }`
  - `class Broker` with agent methods `request(raw)`, `execute(grantId)`, `status(pendingId)` and principal methods `approve(pendingId)`, `deny(pendingId)`, `pending()`, plus `audit()` and `verify()`.

- [ ] **Step 1: Write the failing test** — `test/broker.test.ts`

```ts
import { Broker } from "../src/broker";
import { MockExecutor } from "../src/executor";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

// Scene 1: allowed → auto-grant → execute → paid
{
  const b = new Broker({ maxPerAction: "$5", allow: ["api.stripe.com"], requireApprovalOver: "$50", executor: new MockExecutor() });
  const r = b.request({ amount: "$3", payee: "api.stripe.com", intent: "credits" });
  check("under-threshold request is allowed with a grant", r.decision === "allowed" && !!r.grantId);
  const x = await b.execute(r.grantId!);
  check("execute settles via executor", x.status === "paid" && x.receipt?.ok === true);
  const x2 = await b.execute(r.grantId!);
  check("second execute on same grant is rejected (single-use)", x2.status === "rejected");
}

// Scene 2: prompt-injected payee is denied, no grant
{
  const b = new Broker({ allow: ["api.stripe.com"], executor: new MockExecutor() });
  const r = b.request({ amount: "$1", payee: "attacker.evil", intent: "urgent invoice" });
  check("off-allowlist payee is denied", r.decision === "denied" && !r.grantId);
  const x = await b.execute("any-made-up-id");
  check("execute with no valid grant is rejected", x.status === "rejected");
}

// Scene 3: over-threshold waits for principal approval, then executes
{
  const b = new Broker({ requireApprovalOver: "$50", executor: new MockExecutor() });
  const r = b.request({ amount: "$120", payee: "api.stripe.com", intent: "annual" });
  check("over-threshold needs approval with a pendingId", r.decision === "needs_approval" && !!r.pendingId);
  check("cannot execute a pending before approval", (await b.execute(r.pendingId!)).status === "rejected");
  const ap = b.approve(r.pendingId!);
  check("approve mints a grant", !!ap.grantId);
  check("status reflects approval", b.status(r.pendingId!).state === "approved");
  check("approved grant executes", (await b.execute(ap.grantId!)).status === "paid");
}

// Scene 4: split-under-cap attack blocked by reservations
{
  const b = new Broker({ maxPerDay: "$3", requireApprovalOver: "$50", executor: new MockExecutor() });
  b.request({ amount: "$2", payee: "api.stripe.com" }); // reserves $2
  const second = b.request({ amount: "$2", payee: "api.stripe.com" });
  check("second under-cap request denied by reservation", second.decision === "denied");
}

// Scene 5: executor failure releases the grant and is recorded; chain verifies
{
  const b = new Broker({ requireApprovalOver: "$50", executor: new MockExecutor({ fail: true }) });
  const r = b.request({ amount: "$1", payee: "api.stripe.com" });
  const x = await b.execute(r.grantId!);
  check("executor failure yields rejected", x.status === "rejected");
  check("audit chain verifies across the lifecycle", b.verify().ok === true);
  check("explain is present on decisions", b.audit()[0]!.explain?.rule === "within-policy");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx test/broker.test.ts`
Expected: FAIL — cannot find module `../src/broker`.

- [ ] **Step 3: Create `src/broker.ts`**

```ts
// broker.ts — the enforcement core. Holds the executor (credential). The agent can only
// reach request/execute/status; approve/deny/pending are the principal (out-of-band) API.
import { createHash } from "node:crypto";
import type { PolicyConfig, AuthorizeRequest, NormalizedRequest, DecisionStatus, Explain } from "./types";
import { parseMoney, zero, type Money } from "./money";
import { evaluate, type Ledger } from "./evaluate";
import { GrantStore, type Grant } from "./grants";
import { makeRecord, verifyChain, JsonlAuditStore, type AuditStore } from "./audit";
import { scrubReceipt, type Executor } from "./executor";

export interface BrokerOptions extends PolicyConfig {
  executor: Executor;
  grantTtlMs?: number;
  store?: AuditStore;
  auditFile?: string;
  now?: () => number;
}

export interface RequestResult {
  decision: DecisionStatus;
  grantId?: string;
  pendingId?: string;
  reason: string;
  explain: Explain;
}
export interface ExecuteResult {
  status: "paid" | "rejected";
  receipt?: { ok: boolean; ref?: string };
  reason: string;
}
export interface StatusResult { state: "pending" | "approved" | "denied" | "unknown"; grantId?: string }
export interface PendingView { id: string; payee: string; amount: Money; intent?: string; createdAt: string }

interface Pending {
  id: string;
  req: NormalizedRequest;
  createdAt: string;
  state: "pending" | "approved" | "denied";
  grantId?: string;
}

const DEFAULT_TTL_MS = 15 * 60_000;

export class Broker {
  private readonly cfg: PolicyConfig;
  private readonly currency: string;
  private readonly store: AuditStore;
  private readonly policyVersion: string;
  private readonly grants: GrantStore;
  private readonly executor: Executor;
  private readonly now: () => number;
  private readonly pendings = new Map<string, Pending>();

  constructor(opts: BrokerOptions) {
    const { executor, grantTtlMs, store, auditFile, now, ...policy } = opts;
    this.cfg = policy;
    this.currency = (policy.currency ?? "USD").toUpperCase();
    this.store = store ?? new JsonlAuditStore(auditFile);
    this.executor = executor;
    this.now = now ?? (() => Date.now());
    this.grants = new GrantStore(grantTtlMs ?? DEFAULT_TTL_MS, this.now);
    this.policyVersion = createHash("sha256").update(JSON.stringify(policy)).digest("hex").slice(0, 12);
  }

  private explain(req: NormalizedRequest, rule: Explain["rule"], extra: Partial<Explain> = {}): Explain {
    return {
      rule,
      policyVersion: this.policyVersion,
      evaluated: { amount: req.amount, payee: req.payee, category: req.category },
      ...extra,
    };
  }

  // ---- agent-facing ----

  request(raw: AuthorizeRequest): RequestResult {
    let req: NormalizedRequest;
    try {
      req = { amount: parseMoney(raw.amount, this.currency), payee: raw.payee, intent: raw.intent, category: raw.category, agentId: raw.agentId };
    } catch (e) {
      const safe: NormalizedRequest = { amount: zero(this.currency), payee: String(raw.payee ?? "?") };
      const explain = this.explain(safe, "malformed");
      const reason = `denied: malformed request (${(e as Error).message})`;
      makeRecord(this.store, { request: safe, status: "denied", reason, policyVersion: this.policyVersion, event: "decision", explain });
      return { decision: "denied", reason, explain };
    }

    let ev;
    try {
      const ledger: Ledger = { spentSince: (s, c) => this.grants.spentSince(s, c) };
      ev = evaluate(this.cfg, req, ledger, this.currency, this.now());
    } catch (e) {
      const explain = this.explain(req, "eval-error");
      const reason = `denied: policy evaluation failed (${(e as Error).message})`;
      makeRecord(this.store, { request: req, status: "denied", reason, policyVersion: this.policyVersion, event: "decision", explain });
      return { decision: "denied", reason, explain };
    }

    if (ev.status === "denied") {
      const explain = this.explain(req, ev.rule, { reservation: ev.reservation });
      makeRecord(this.store, { request: req, status: "denied", reason: ev.reason, policyVersion: this.policyVersion, event: "decision", explain });
      return { decision: "denied", reason: ev.reason, explain };
    }

    if (ev.status === "needs_approval") {
      const id = createHash("sha256").update(`${this.now()}:${req.payee}:${req.amount.amount}:${this.pendings.size}`).digest("hex").slice(0, 16);
      this.pendings.set(id, { id, req, createdAt: new Date(this.now()).toISOString(), state: "pending" });
      const explain = this.explain(req, ev.rule);
      makeRecord(this.store, { request: req, status: "needs_approval", reason: ev.reason, policyVersion: this.policyVersion, event: "decision", explain });
      return { decision: "needs_approval", pendingId: id, reason: ev.reason, explain };
    }

    // allowed → auto-mint a grant (policy is the authorization)
    const grant = this.grants.mint(req, "policy");
    const explain = this.explain(req, "within-policy", { grant: this.grantExplain(grant), approvedBy: "policy:auto" });
    makeRecord(this.store, { request: req, status: "allowed", reason: ev.reason, policyVersion: this.policyVersion, event: "grant_minted", explain, grantId: grant.id });
    return { decision: "allowed", grantId: grant.id, reason: ev.reason, explain };
  }

  async execute(grantId: string): Promise<ExecuteResult> {
    const claim = this.grants.claim(grantId);
    if (!claim.ok) {
      const safe: NormalizedRequest = { amount: zero(this.currency), payee: "?" };
      makeRecord(this.store, { request: safe, status: "denied", reason: `rejected: ${claim.reason}`, policyVersion: this.policyVersion, event: "execution_failed" });
      return { status: "rejected", reason: claim.reason };
    }
    const g = claim.grant;
    const req: NormalizedRequest = { amount: g.amount, payee: g.payee, intent: g.intent, category: g.category };

    let receipt;
    try {
      receipt = await this.executor.execute({ id: g.id, payee: g.payee, amount: g.amount });
    } catch (e) {
      this.grants.markFailed(g.id);
      const reason = `executor error: ${(e as Error).message}`;
      makeRecord(this.store, { request: req, status: "denied", reason, policyVersion: this.policyVersion, event: "execution_failed", grantId: g.id });
      return { status: "rejected", reason };
    }

    if (!receipt.ok) {
      this.grants.markFailed(g.id);
      const reason = receipt.error ?? "execution failed";
      const scrubbed = scrubReceipt(receipt);
      makeRecord(this.store, { request: req, status: "denied", reason, policyVersion: this.policyVersion, event: "execution_failed", grantId: g.id, receipt: scrubbed });
      return { status: "rejected", reason, receipt: scrubbed };
    }

    // claim() already marked it redeemed; keep it redeemed.
    const scrubbed = scrubReceipt(receipt);
    const explain = this.explain(req, "within-policy", { grant: this.grantExplain(g), approvedBy: g.origin === "principal" ? `principal:${g.pendingId ?? "?"}` : "policy:auto", receipt: scrubbed });
    makeRecord(this.store, { request: req, status: "allowed", reason: "executed", policyVersion: this.policyVersion, event: "executed", explain, grantId: g.id, receipt: scrubbed });
    return { status: "paid", receipt: scrubbed, reason: "executed" };
  }

  status(pendingId: string): StatusResult {
    const p = this.pendings.get(pendingId);
    if (!p) return { state: "unknown" };
    return { state: p.state, grantId: p.grantId };
  }

  // ---- principal-facing (out of band; NOT exposed over the agent transport) ----

  pending(): PendingView[] {
    return [...this.pendings.values()]
      .filter((p) => p.state === "pending")
      .map((p) => ({ id: p.id, payee: p.req.payee, amount: p.req.amount, intent: p.req.intent, createdAt: p.createdAt }));
  }

  approve(pendingId: string): { grantId?: string; reason: string } {
    const p = this.pendings.get(pendingId);
    if (!p) return { reason: "unknown pending id" };
    if (p.state !== "pending") return { reason: `pending is already ${p.state}` };
    const grant = this.grants.mint(p.req, "principal", pendingId);
    p.state = "approved";
    p.grantId = grant.id;
    const explain = this.explain(p.req, "within-policy", { grant: this.grantExplain(grant), approvedBy: `principal:${pendingId}` });
    makeRecord(this.store, { request: p.req, status: "allowed", reason: "principal approved", policyVersion: this.policyVersion, event: "grant_minted", explain, grantId: grant.id });
    return { grantId: grant.id, reason: "approved" };
  }

  deny(pendingId: string): { reason: string } {
    const p = this.pendings.get(pendingId);
    if (!p) return { reason: "unknown pending id" };
    if (p.state !== "pending") return { reason: `pending is already ${p.state}` };
    p.state = "denied";
    makeRecord(this.store, { request: p.req, status: "denied", reason: "principal denied", policyVersion: this.policyVersion, event: "decision" });
    return { reason: "denied" };
  }

  audit() { return this.store.all(); }
  verify() { return verifyChain(this.store.all()); }

  private grantExplain(g: Grant): NonNullable<Explain["grant"]> {
    return { id: g.id, boundTo: { payee: g.payee, amount: g.amount, intent: g.intent }, origin: g.origin };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx test/broker.test.ts`
Expected: PASS — `13 passed, 0 failed`.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/broker.ts test/broker.test.ts
git commit -m "feat: Broker — grant lifecycle, mediated execution, principal approval"
```

---

### Task 7: Transport (Node IPC) + `PurseClient` + `serveBroker` + cross-process integration

**Files:**
- Create: `src/transport/types.ts`
- Create: `src/client.ts`
- Create: `src/server.ts`
- Create: `test/fixtures/agent-child.ts` (child entry the integration test spawns)
- Test: `test/transport.test.ts`

**Interfaces:**
- Consumes: `Broker`, `RequestResult`, `ExecuteResult`, `StatusResult` (Task 6); `AuthorizeRequest` (`src/types.ts`); `node:child_process`.
- Produces:
  - `interface WireRequest { id: string; method: "request" | "execute" | "status"; params: unknown }`
  - `interface WireResponse { id: string; ok: boolean; result?: unknown; error?: string }`
  - `interface AgentChannel { send(msg: WireRequest): void; onMessage(cb: (msg: WireResponse) => void): void; onClose(cb: () => void): void }`
  - `class PurseClient` with `constructor(channel: AgentChannel)`, `request(spend): Promise<RequestResult>`, `execute(grantId): Promise<ExecuteResult>`, `status(pendingId): Promise<StatusResult>`, and static `PurseClient.fromProcess(): PurseClient` (builds a channel from `process.send`/`process.on('message')`).
  - `function serveBroker(child: import("node:child_process").ChildProcess, broker: Broker): void` — wires the child's IPC messages to the broker's **agent methods only**.
  - `function spawnAgent(childPath: string): import("node:child_process").ChildProcess` — spawns a TS child with an IPC channel.

- [ ] **Step 1: Write the failing test** — `test/transport.test.ts`

```ts
import { spawnAgent, serveBroker } from "../src/server";
import { Broker } from "../src/broker";
import { MockExecutor } from "../src/executor";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

// The broker lives HERE (parent, holds the executor/credential).
const broker = new Broker({ maxPerAction: "$5", allow: ["api.stripe.com"], requireApprovalOver: "$50", executor: new MockExecutor() });
const child = spawnAgent(new URL("./fixtures/agent-child.ts", import.meta.url).pathname);
serveBroker(child, broker);

// The child (agent) runs a scripted flow and reports its results back on a "report" message.
const report: Record<string, unknown> = await new Promise((resolve) => {
  child.on("message", (m: { kind?: string; data?: Record<string, unknown> }) => {
    if (m && m.kind === "report") resolve(m.data ?? {});
  });
});
child.kill();

check("agent got a grant for an in-policy spend", report.allowedGrant === true);
check("agent settled the spend across the process boundary", report.paid === true);
check("agent's injected off-allowlist payment was denied", report.injectionDenied === true);
check("audit chain (broker side) verifies after cross-process flow", broker.verify().ok === true);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Write the child fixture** — `test/fixtures/agent-child.ts`

```ts
// Runs in a SEPARATE process. Holds only PurseClient — no Broker, no Executor, no credential.
import { PurseClient } from "../../src/client";

const purse = PurseClient.fromProcess();

const out: Record<string, unknown> = {};

// in-policy spend → grant → execute
const r = await purse.request({ amount: "$3", payee: "api.stripe.com", intent: "credits" });
out.allowedGrant = r.decision === "allowed" && !!r.grantId;
if (r.grantId) {
  const x = await purse.execute(r.grantId);
  out.paid = x.status === "paid";
}

// prompt injection → off-allowlist payee must be denied
const bad = await purse.request({ amount: "$1", payee: "attacker.evil", intent: "urgent" });
out.injectionDenied = bad.decision === "denied";

process.send?.({ kind: "report", data: out });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx test/transport.test.ts`
Expected: FAIL — cannot find modules `../src/server` / `../src/client`.

- [ ] **Step 4: Create `src/transport/types.ts`**

```ts
export interface WireRequest {
  id: string;
  method: "request" | "execute" | "status";
  params: unknown;
}
export interface WireResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}
export interface AgentChannel {
  send(msg: WireRequest): void;
  onMessage(cb: (msg: WireResponse) => void): void;
  onClose(cb: () => void): void;
}
```

- [ ] **Step 5: Create `src/client.ts`**

```ts
// client.ts — the ONLY thing the agent process imports. No executor, no credential.
// Fail-closed: if the broker channel dies or errors, requests resolve to denied/rejected.
import { randomUUID } from "node:crypto";
import type { AuthorizeRequest } from "./types";
import type { RequestResult, ExecuteResult, StatusResult } from "./broker";
import type { AgentChannel, WireRequest, WireResponse } from "./transport/types";

export class PurseClient {
  private pending = new Map<string, (r: WireResponse) => void>();
  private closed = false;

  constructor(private channel: AgentChannel) {
    channel.onMessage((msg) => {
      const resolve = this.pending.get(msg.id);
      if (resolve) { this.pending.delete(msg.id); resolve(msg); }
    });
    channel.onClose(() => {
      this.closed = true;
      for (const [, resolve] of this.pending) resolve({ id: "", ok: false, error: "broker channel closed" });
      this.pending.clear();
    });
  }

  static fromProcess(): PurseClient {
    const channel: AgentChannel = {
      send: (msg) => { process.send?.(msg); },
      onMessage: (cb) => { process.on("message", (m) => cb(m as WireResponse)); },
      onClose: (cb) => { process.on("disconnect", cb); },
    };
    return new PurseClient(channel);
  }

  private call(method: WireRequest["method"], params: unknown): Promise<WireResponse> {
    if (this.closed) return Promise.resolve({ id: "", ok: false, error: "broker channel closed" });
    const id = randomUUID();
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      try { this.channel.send({ id, method, params }); }
      catch (e) { this.pending.delete(id); resolve({ id, ok: false, error: (e as Error).message }); }
    });
  }

  async request(spend: AuthorizeRequest): Promise<RequestResult> {
    const res = await this.call("request", spend);
    if (!res.ok) return { decision: "denied", reason: `denied: ${res.error ?? "broker unavailable"}`, explain: { rule: "eval-error", policyVersion: "", evaluated: { amount: { amount: 0, currency: "USD" }, payee: String(spend.payee) } } };
    return res.result as RequestResult;
  }

  async execute(grantId: string): Promise<ExecuteResult> {
    const res = await this.call("execute", { grantId });
    if (!res.ok) return { status: "rejected", reason: `rejected: ${res.error ?? "broker unavailable"}` };
    return res.result as ExecuteResult;
  }

  async status(pendingId: string): Promise<StatusResult> {
    const res = await this.call("status", { pendingId });
    if (!res.ok) return { state: "unknown" };
    return res.result as StatusResult;
  }
}
```

- [ ] **Step 6: Create `src/server.ts`**

```ts
// server.ts — runs in the PARENT process (with the human/principal + the executor).
// Spawns the agent as a subordinate child and serves ONLY the agent-facing methods
// (request/execute/status). approve/deny/pending are never exposed over this channel.
import { spawn, type ChildProcess } from "node:child_process";
import type { Broker } from "./broker";
import type { WireRequest, WireResponse } from "./transport/types";
import type { AuthorizeRequest } from "./types";

/** Spawn a TypeScript agent child with a Node IPC channel (zero extra deps; uses tsx as a loader). */
export function spawnAgent(childPath: string): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", childPath], {
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
}

export function serveBroker(child: ChildProcess, broker: Broker): void {
  child.on("message", async (raw: WireRequest) => {
    const reply = (res: Omit<WireResponse, "id">) => child.send?.({ id: raw?.id ?? "", ...res });
    try {
      switch (raw?.method) {
        case "request":
          return reply({ ok: true, result: broker.request(raw.params as AuthorizeRequest) });
        case "execute":
          return reply({ ok: true, result: await broker.execute((raw.params as { grantId: string }).grantId) });
        case "status":
          return reply({ ok: true, result: broker.status((raw.params as { pendingId: string }).pendingId) });
        default:
          return reply({ ok: false, error: `unknown method: ${String(raw?.method)}` });
      }
    } catch (e) {
      reply({ ok: false, error: (e as Error).message });
    }
  });
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx tsx test/transport.test.ts`
Expected: PASS — `4 passed, 0 failed`.
(If the child fails to load, confirm `tsx` is installed — it is a devDependency — and that `process.execPath` points at Node ≥18.)

- [ ] **Step 8: Build**

Run: `npm run build`
Expected: exits 0. (`test/` and `examples/` are excluded from `tsconfig`, so the fixture is not type-checked by the build; it is exercised by `tsx` at test time.)

- [ ] **Step 9: Commit**

```bash
git add src/transport/types.ts src/client.ts src/server.ts test/fixtures/agent-child.ts test/transport.test.ts
git commit -m "feat: Node-IPC transport — PurseClient + serveBroker, agent as subordinate child"
```

---

### Task 8: Loopback HTTP transport (optional alternative; the Cloud seam)

**Files:**
- Create: `src/transport/http.ts`
- Test: `test/transport-http.test.ts`

**Interfaces:**
- Consumes: `Broker` (Task 6); `AuthorizeRequest` (`src/types.ts`); `node:http`.
- Produces:
  - `function serveHttp(broker: Broker, opts?: { host?: string; port?: number }): Promise<{ url: string; close(): Promise<void> }>` — binds `127.0.0.1`, POST `/request` `/execute` `/status` only.
  - `class HttpPurseClient` with `constructor(baseUrl: string)` and the same `request` / `execute` / `status` methods as `PurseClient`, fail-closed on network error.

- [ ] **Step 1: Write the failing test** — `test/transport-http.test.ts`

```ts
import { serveHttp, HttpPurseClient } from "../src/transport/http";
import { Broker } from "../src/broker";
import { MockExecutor } from "../src/executor";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

const broker = new Broker({ maxPerAction: "$5", allow: ["api.stripe.com"], requireApprovalOver: "$50", executor: new MockExecutor() });
const server = await serveHttp(broker, { port: 0 });
const client = new HttpPurseClient(server.url);

const r = await client.request({ amount: "$3", payee: "api.stripe.com", intent: "credits" });
check("http request returns a grant", r.decision === "allowed" && !!r.grantId);
check("http execute settles", (await client.execute(r.grantId!)).status === "paid");

const bad = await client.request({ amount: "$1", payee: "attacker.evil" });
check("http off-allowlist denied", bad.decision === "denied");

await server.close();
const afterClose = await client.request({ amount: "$1", payee: "api.stripe.com" });
check("fail-closed when broker unreachable", afterClose.decision === "denied");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx test/transport-http.test.ts`
Expected: FAIL — cannot find module `../src/transport/http`.

- [ ] **Step 3: Create `src/transport/http.ts`**

```ts
// http.ts — loopback HTTP transport. Binds 127.0.0.1 only. Same narrow interface as the
// IPC transport; this is the seam a hosted broker (Purse Cloud) grows from. Zero deps (node:http).
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import type { Broker, RequestResult, ExecuteResult, StatusResult } from "./../broker";
import type { AuthorizeRequest } from "./../types";

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

export async function serveHttp(broker: Broker, opts: { host?: string; port?: number } = {}): Promise<{ url: string; close(): Promise<void> }> {
  const host = opts.host ?? "127.0.0.1";
  const server = createServer(async (req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    try {
      const params = await readJson(req);
      switch (`${req.method} ${req.url}`) {
        case "POST /request": return send(200, broker.request(params as AuthorizeRequest));
        case "POST /execute": return send(200, await broker.execute((params as { grantId: string }).grantId));
        case "POST /status": return send(200, broker.status((params as { pendingId: string }).pendingId));
        default: return send(404, { error: "not found" });
      }
    } catch (e) { send(400, { error: (e as Error).message }); }
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  return {
    url: `http://${host}:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function post(url: string, path: string, body: unknown): Promise<{ ok: boolean; result?: unknown }> {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const u = new URL(path, url);
    const req = httpRequest({ hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => { try { resolve({ ok: (res.statusCode ?? 500) < 400, result: out ? JSON.parse(out) : undefined }); } catch { resolve({ ok: false }); } });
    });
    req.on("error", () => resolve({ ok: false }));
    req.write(data);
    req.end();
  });
}

export class HttpPurseClient {
  constructor(private baseUrl: string) {}
  async request(spend: AuthorizeRequest): Promise<RequestResult> {
    const r = await post(this.baseUrl, "/request", spend);
    if (!r.ok) return { decision: "denied", reason: "denied: broker unavailable", explain: { rule: "eval-error", policyVersion: "", evaluated: { amount: { amount: 0, currency: "USD" }, payee: String(spend.payee) } } };
    return r.result as RequestResult;
  }
  async execute(grantId: string): Promise<ExecuteResult> {
    const r = await post(this.baseUrl, "/execute", { grantId });
    if (!r.ok) return { status: "rejected", reason: "rejected: broker unavailable" };
    return r.result as ExecuteResult;
  }
  async status(pendingId: string): Promise<StatusResult> {
    const r = await post(this.baseUrl, "/status", { pendingId });
    if (!r.ok) return { state: "unknown" };
    return r.result as StatusResult;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx test/transport-http.test.ts`
Expected: PASS — `4 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/transport/http.ts test/transport-http.test.ts
git commit -m "feat: loopback HTTP transport (the Purse Cloud seam)"
```

---

### Task 9: Exports, scripts, aggregate test runner, and the two-process enforcement demo

**Files:**
- Modify: `src/index.ts` (export the enforcement surface)
- Modify: `package.json` (scripts: aggregate `test`, `demo:enforce`)
- Create: `examples/enforce-demo/broker-host.ts` (parent: broker + principal)
- Create: `examples/enforce-demo/agent.ts` (child: agent using PurseClient)

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: public exports; `npm test` runs all `test/*.test.ts`; `npm run demo:enforce` runs the two-process demo.

- [ ] **Step 1: Extend `src/index.ts`**

Append:

```ts
// Enforcement mode (v0.2)
export { Broker } from "./broker";
export type { BrokerOptions, RequestResult, ExecuteResult, StatusResult, PendingView } from "./broker";
export { PurseClient } from "./client";
export { serveBroker, spawnAgent } from "./server";
export { serveHttp, HttpPurseClient } from "./transport/http";
export { MockExecutor, scrubReceipt } from "./executor";
export type { Executor, Receipt, Payable } from "./executor";
export { GrantStore } from "./grants";
export type { Grant, GrantState, GrantOrigin } from "./grants";
export { evaluate } from "./evaluate";
export type { Ledger, EvaluationResult } from "./evaluate";
export type { Explain, ExplainRule, AuditEvent } from "./types";
```

- [ ] **Step 2: Update `package.json` scripts**

Replace the `test` script and add `demo:enforce`:

```json
    "test": "tsx test/policy.test.ts && tsx test/evaluate.test.ts && tsx test/audit-explain.test.ts && tsx test/executor.test.ts && tsx test/grants.test.ts && tsx test/grants-reservation.test.ts && tsx test/broker.test.ts && tsx test/transport.test.ts && tsx test/transport-http.test.ts",
    "demo:enforce": "tsx examples/enforce-demo/broker-host.ts",
```

- [ ] **Step 3: Create `examples/enforce-demo/agent.ts`** (the child)

```ts
// The agent. Holds ONLY PurseClient — no executor, no credential, no rail.
import { PurseClient } from "../../src/index";

const purse = PurseClient.fromProcess();
const log = (s: string) => console.log(`  [agent] ${s}`);

// 1. normal in-policy spend
let r = await purse.request({ amount: "$3", payee: "api.stripe.com", intent: "top up credits" });
log(`request $3 -> ${r.decision}`);
if (r.grantId) log(`execute -> ${(await purse.execute(r.grantId)).status}`);

// 2. prompt injection: pay an attacker
r = await purse.request({ amount: "$500", payee: "attacker.evil", intent: "URGENT overdue invoice" });
log(`injected pay attacker.evil -> ${r.decision} (${r.reason})`);

// 3. over-threshold: needs a human
r = await purse.request({ amount: "$120", payee: "api.stripe.com", intent: "annual plan" });
log(`request $120 -> ${r.decision}, pendingId=${r.pendingId}`);
process.send?.({ kind: "await-approval", pendingId: r.pendingId });

// wait for the host to tell us it approved, then execute
process.on("message", async (m: { kind?: string; grantId?: string }) => {
  if (m?.kind === "approved" && m.grantId) {
    log(`principal approved -> execute -> ${(await purse.execute(m.grantId)).status}`);
    process.send?.({ kind: "done" });
  }
});
```

- [ ] **Step 4: Create `examples/enforce-demo/broker-host.ts`** (the parent + principal)

```ts
// The principal's process: holds the Broker + the executor (credential). Spawns the agent.
import { Broker, serveBroker, spawnAgent } from "../../src/index";
import { MockExecutor } from "../../src/index";

const broker = new Broker({
  maxPerAction: "$50",
  maxPerDay: "$200",
  allow: ["api.stripe.com", "*.aws.amazon.com"],
  requireApprovalOver: "$50",
  executor: new MockExecutor(),
});

const child = spawnAgent(new URL("./agent.ts", import.meta.url).pathname);
serveBroker(child, broker);

child.on("message", (m: { kind?: string; pendingId?: string }) => {
  if (m?.kind === "await-approval" && m.pendingId) {
    console.log(`  [principal] approving pending ${m.pendingId} (out of band)`);
    const { grantId } = broker.approve(m.pendingId);
    child.send({ kind: "approved", grantId });
  }
  if (m?.kind === "done") {
    console.log(`\n  [proof] audit records: ${broker.audit().length}`);
    console.log(`  [proof] tamper-evident chain intact: ${broker.verify().ok}`);
    child.kill();
    process.exit(0);
  }
});
```

- [ ] **Step 5: Run the full suite + the demo**

Run: `npm test`
Expected: every file prints `N passed, 0 failed`; process exits 0.
Run: `npm run demo:enforce`
Expected output (order may interleave slightly):
```
  [agent] request $3 -> allowed
  [agent] execute -> paid
  [agent] injected pay attacker.evil -> denied (denied: payee "attacker.evil" is not on the allowlist)
  [agent] request $120 -> needs_approval, pendingId=...
  [principal] approving pending ... (out of band)
  [agent] principal approved -> execute -> paid
  [proof] audit records: 6
  [proof] tamper-evident chain intact: true
```

- [ ] **Step 6: Build + commit**

Run: `npm run build`
Expected: exits 0.

```bash
git add src/index.ts package.json examples/enforce-demo/agent.ts examples/enforce-demo/broker-host.ts
git commit -m "feat: export enforcement surface + two-process MockExecutor demo"
```

---

## Self-Review

**1. Spec coverage** (against `2026-07-04-enforcement-mode-broker-intent-binding-design.md`):
- §1 CAR framing → documented in spec; enforced structurally (Control = evaluate/policy, Agency = client/narrow interface, Runtime = grants/audit). ✔
- §2 two processes + narrow interface + IPC/HTTP transport → Tasks 7, 8. ✔
- §3 request→grant→execute flow + auto-grant vs approval → Task 6. ✔
- §4 single-use + expiry grants → Task 4; forgery/misdirection honesty is a doc property (no code owed). ✔
- §5 reservation-aware anti-splitting → Tasks 4 (impl) + 5 (locked). ✔
- §6 Executor + MockExecutor → Task 3. ✔
- §7 audit events + explain-as-proof → Task 2; explain populated in Task 6. ✔
- §8 code structure + evaluate refactor → Tasks 1, 9. ✔
- §9 HARNESS CARD → documentation artifact (spec §9); no code owed. *(Follow-up: add the card to `README.md` — folded into Task 9? No — README copy is out of this plan's test surface; tracked as a docs task at ship, not a code gap.)*
- §10 fail-closed + tests + scope → fail-closed in Tasks 1/6/7/8; tests throughout. ✔
- §11 Phase 2 (x402 + governed-agent demo) → **separate plan**, by design. ✔

**2. Placeholder scan:** No `TBD`/`TODO`/"handle errors"/"similar to". Every code step shows complete code. ✔

**3. Type consistency:** `evaluate()` signature identical in Tasks 1/5/6. `Ledger.spentSince(sinceMs, currency)` consistent (evaluate, Purse, GrantStore, Broker). `makeRecord(store, RecordInput)` consistent Tasks 2/6. `RequestResult`/`ExecuteResult`/`StatusResult` defined in Task 6, consumed identically in Tasks 7/8/9. `Grant`/`GrantState`/`GrantOrigin` consistent Tasks 4/6/9. `Explain`/`ExplainRule` consistent Tasks 1/2/6. `MockExecutor({ fail })` consistent Tasks 3/6/7/9. `claim()`/`markRedeemed()`/`markFailed()` consistent Tasks 4/6. ✔

One deliberate note carried into execution: the README HARNESS CARD (§9) and Phase 2 are intentionally **not** in this plan — the card is prose added at ship, Phase 2 is its own plan against the now-real interfaces.
