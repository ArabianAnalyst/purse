# Purse v0.2 Enforcement Mode — Phase 2 (x402 + Governed-Agent Proof) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate a real x402 payment rail behind the Phase 1 broker and ship a two-process governed-agent demo that proves, end to end, that a compromised agent cannot move money outside policy — settling through x402 while the audit chain explainably verifies.

**Architecture:** All Phase 2 code lives under `examples/x402/` and depends only on the Phase 1 interfaces (`Executor`, `Payable`, `Receipt`, `Broker`, `PurseClient`, `serveBroker`, `spawnAgent` from `src/index`). An `X402Executor implements Executor` performs the HTTP-402 dance: probe the resource for its 402 challenge, require the challenged amount to equal the grant amount **exactly** (intent-binding to the rail), then sign and settle. It is exercised against a **local mock 402 resource** + a **mock signer** — deterministic, no wallet, no funds, no secrets — with the real Base Sepolia path documented. The governed-agent demo runs the broker (holding the `X402Executor`) in the parent and a scripted agent (holding only `PurseClient`) in a spawned child, walking five proof scenes. An optional real-LLM variant runs behind the same boundary, manual and not in CI.

**Tech Stack:** TypeScript (ES2022, ESM, `strict`, `noUncheckedIndexedAccess`), Node ≥18 built-ins only (`node:http`, `node:crypto`, `node:url`, `node:buffer`), global `fetch`, `tsx` to run. **Zero new dependencies** for everything built/run here. Tests are plain `check(name, cond)` scripts matching `test/policy.test.ts`.

## Global Constraints

- **Zero new runtime dependencies.** Everything built here uses Node built-ins + global `fetch` + the Phase 1 `src/` core. `x402` / `x402-fetch` / `viem` are named ONLY in the documented testnet path (Task 4 README) — never imported by built/run code, never added to `package.json` dependencies.
- **`src/` stays untouched and zero-dep.** All Phase 2 code lives under `examples/x402/`. Do not modify any `src/` file. (Tests may import from both `../src/index` and `../examples/x402/...`.)
- **Intent-binding at the rail:** the executor MUST reject (fail closed) when the 402-challenged amount does not equal the grant amount exactly (same minor-unit integer AND same currency).
- **Fail closed everywhere:** unmapped payee, non-402 probe response, amount mismatch, non-200 settlement, any thrown error → `Receipt { ok: false, error }`, never `ok: true`. The executor never throws out of `execute()` — it returns a failed receipt (the broker treats a thrown executor as failure too, but the executor should not rely on that).
- **Loopback only** for the mock 402 server: bind `127.0.0.1`.
- **Money is integer minor units** via `src/money.ts` (`parseMoney`, `Money`). The mock speaks the grant's minor units directly (USD cents) with asset label `"USD-cents"`; the real USDC 6-decimal mapping is documented in Task 4, not built.
- **ESM imports:** no file extension. Examples import the core via `../../src/index`. TS strict + `noUncheckedIndexedAccess` — guard `Map`/array/JSON access.
- `examples/` is excluded from `tsconfig` (`npm run build` does not type-check it); examples are exercised by `tsx` at test time. Run a single test file with `npx tsx test/<name>.test.ts`.

---

### Task 1: x402 types, mock 402 resource server, and mock signer (test/demo foundation)

**Files:**
- Create: `examples/x402/types.ts`
- Create: `examples/x402/mock-402-server.ts`
- Create: `examples/x402/mock-signer.ts`
- Test: `test/x402-mock.test.ts`

**Interfaces:**
- Consumes: `node:http` (`createServer`), `node:buffer` (global `Buffer`).
- Produces:
  - `interface PaymentRequirements { scheme: string; network: string; maxAmountRequired: string; payTo: string; asset: string; resource: string }`
  - `interface X402Signer { sign(reqs: PaymentRequirements): Promise<string> }`
  - `interface Mock402Options { amount: string; asset?: string; network?: string; payTo?: string }`
  - `function startMock402(opts: Mock402Options): Promise<{ url: string; close(): Promise<void> }>` — 402 challenge on an unpaid GET, 200 `{ ok, ref }` when an `X-PAYMENT` header is present.
  - `class MockSigner implements X402Signer`

- [ ] **Step 1: Write the failing test** — `test/x402-mock.test.ts`

```ts
import { startMock402 } from "../examples/x402/mock-402-server";
import { MockSigner } from "../examples/x402/mock-signer";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

const server = await startMock402({ amount: "500", payTo: "acme" });

// unpaid GET -> 402 with a single payment requirement
const r1 = await fetch(server.url);
check("unpaid GET returns 402", r1.status === 402);
const body = await r1.json() as { accepts?: Array<{ maxAmountRequired: string; payTo: string }> };
check("challenge carries the configured amount", body.accepts?.[0]?.maxAmountRequired === "500");
check("challenge carries the payTo", body.accepts?.[0]?.payTo === "acme");

// GET with X-PAYMENT -> 200 with a settlement ref
const r2 = await fetch(server.url, { headers: { "X-PAYMENT": "anything" } });
check("paid GET returns 200", r2.status === 200);
const settle = await r2.json() as { ok: boolean; ref: string };
check("settlement carries a ref", settle.ok === true && typeof settle.ref === "string");

// mock signer is deterministic and encodes the challenge
const sig = await new MockSigner().sign({ scheme: "exact", network: "mock", maxAmountRequired: "500", payTo: "acme", asset: "USD-cents", resource: "/" });
check("mock signer returns a non-empty header value", typeof sig === "string" && sig.length > 0);

await server.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx test/x402-mock.test.ts`
Expected: FAIL — cannot find module `../examples/x402/mock-402-server`.

- [ ] **Step 3: Create `examples/x402/types.ts`**

```ts
// types.ts — the minimal x402 shapes this adapter needs. A real x402 challenge carries
// more fields; these are the ones the executor reads.
export interface PaymentRequirements {
  scheme: string;            // "exact"
  network: string;           // "base-sepolia" (real) or "mock"
  maxAmountRequired: string; // atomic units of `asset`, as a string
  payTo: string;             // receiving address / vendor id
  asset: string;             // token contract address, or "USD-cents" in the mock
  resource: string;          // the resource URL being paid for
}

// Given the challenge, produce the value for the X-PAYMENT header.
// Mock: encodes the challenge. Real: signs an EIP-3009 authorization with a wallet.
export interface X402Signer {
  sign(reqs: PaymentRequirements): Promise<string>;
}
```

- [ ] **Step 4: Create `examples/x402/mock-402-server.ts`**

```ts
// mock-402-server.ts — a deterministic local stand-in for an x402 resource server.
// Unpaid GET -> 402 + PaymentRequirements. GET carrying an X-PAYMENT header -> 200 + a
// settlement ref. No chain, no wallet, no funds. Loopback only.
import { createServer } from "node:http";

export interface Mock402Options {
  amount: string;    // atomic units (USD-cents in the mock), as a string
  asset?: string;    // default "USD-cents"
  network?: string;  // default "mock"
  payTo?: string;    // default "mock-vendor"
}

export async function startMock402(opts: Mock402Options): Promise<{ url: string; close(): Promise<void> }> {
  let counter = 0;
  const server = createServer((req, res) => {
    const paid = typeof req.headers["x-payment"] === "string" && req.headers["x-payment"].length > 0;
    if (!paid) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({
        x402Version: 1,
        accepts: [{
          scheme: "exact",
          network: opts.network ?? "mock",
          maxAmountRequired: opts.amount,
          payTo: opts.payTo ?? "mock-vendor",
          asset: opts.asset ?? "USD-cents",
          resource: req.url ?? "/",
        }],
      }));
      return;
    }
    counter += 1;
    const ref = `mock_tx_${counter}`;
    res.writeHead(200, { "content-type": "application/json", "x-payment-response": JSON.stringify({ ref }) });
    res.end(JSON.stringify({ ok: true, ref }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
```

- [ ] **Step 5: Create `examples/x402/mock-signer.ts`**

```ts
// mock-signer.ts — deterministic signer for tests/demo. Produces a stand-in X-PAYMENT
// header instead of a real EIP-3009 authorization. Holds no key.
import type { X402Signer, PaymentRequirements } from "./types";

export class MockSigner implements X402Signer {
  async sign(reqs: PaymentRequirements): Promise<string> {
    const payload = JSON.stringify({ payTo: reqs.payTo, amount: reqs.maxAmountRequired, network: reqs.network });
    return "mock-payment:" + Buffer.from(payload).toString("base64");
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx tsx test/x402-mock.test.ts`
Expected: PASS — `6 passed, 0 failed`.

- [ ] **Step 7: Commit**

```bash
git add examples/x402/types.ts examples/x402/mock-402-server.ts examples/x402/mock-signer.ts test/x402-mock.test.ts
git commit -m "feat(x402): mock 402 resource server + mock signer + x402 types"
```

---

### Task 2: `X402Executor` — HTTP-402 settlement with exact-amount intent-binding

**Files:**
- Create: `examples/x402/x402-executor.ts`
- Test: `test/x402-executor.test.ts`

**Interfaces:**
- Consumes: `Executor`, `Payable`, `Receipt`, `Money`, `parseMoney` (from `../../src/index`); `PaymentRequirements`, `X402Signer` (Task 1); global `fetch`.
- Produces:
  - `interface X402ExecutorOptions { resolvePayee: (payee: string) => string | undefined; signer: X402Signer; toMoney?: (reqs: PaymentRequirements, grantCurrency: string) => Money; fetchImpl?: typeof fetch }`
  - `class X402Executor implements Executor` — `execute(grant: Payable): Promise<Receipt>`

- [ ] **Step 1: Write the failing test** — `test/x402-executor.test.ts`

```ts
import { createServer } from "node:http";
import { startMock402 } from "../examples/x402/mock-402-server";
import { MockSigner } from "../examples/x402/mock-signer";
import { X402Executor } from "../examples/x402/x402-executor";
import { parseMoney } from "../src/index";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}
const signer = new MockSigner();

// happy path: 402 amount matches the grant -> settles
{
  const server = await startMock402({ amount: "500", payTo: "acme" }); // 500 cents
  const ex = new X402Executor({ resolvePayee: () => server.url, signer });
  const r = await ex.execute({ id: "g1", payee: "acme.example", amount: parseMoney("$5.00", "USD") });
  check("settles when 402 amount matches the grant", r.ok === true && typeof r.ref === "string");
  check("receipt echoes the granted amount", r.paidAmount?.amount === 500);
  await server.close();
}

// intent-binding: 402 amount != grant amount -> fail closed
{
  const server = await startMock402({ amount: "999" });
  const ex = new X402Executor({ resolvePayee: () => server.url, signer });
  const r = await ex.execute({ id: "g2", payee: "acme.example", amount: parseMoney("$5.00", "USD") });
  check("rejects when 402 amount != grant amount (intent-binding)", r.ok === false);
  await server.close();
}

// unmapped payee -> fail closed, no network call
{
  const ex = new X402Executor({ resolvePayee: () => undefined, signer });
  const r = await ex.execute({ id: "g3", payee: "unknown", amount: parseMoney("$1", "USD") });
  check("rejects an unmapped payee", r.ok === false);
}

// resource does not challenge (200, no 402) -> fail closed
{
  const plain = createServer((_req, res) => { res.writeHead(200); res.end("{}"); });
  await new Promise<void>((r) => plain.listen(0, "127.0.0.1", r));
  const addr = plain.address();
  const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  const ex = new X402Executor({ resolvePayee: () => url, signer });
  const r = await ex.execute({ id: "g4", payee: "acme.example", amount: parseMoney("$5", "USD") });
  check("rejects when the resource does not return a 402 challenge", r.ok === false);
  await new Promise<void>((res) => plain.close(() => res()));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx test/x402-executor.test.ts`
Expected: FAIL — cannot find module `../examples/x402/x402-executor`.

- [ ] **Step 3: Create `examples/x402/x402-executor.ts`**

```ts
// x402-executor.ts — an Executor that settles a grant over the x402 protocol.
// Flow: probe the resource for its 402 challenge, require the challenged amount to equal
// the grant amount EXACTLY (intent-binding carried to the rail), then sign + settle.
// Built and tested against the local mock; see examples/x402/README.md for the Base Sepolia path.
import type { Executor, Payable, Receipt, Money } from "../../src/index";
import type { PaymentRequirements, X402Signer } from "./types";

export interface X402ExecutorOptions {
  /** Map a Purse payee (allowlisted vendor id) to the x402 resource URL. Return undefined to reject. */
  resolvePayee: (payee: string) => string | undefined;
  /** Produces the X-PAYMENT header for a challenge. Holds the wallet in a real deployment. */
  signer: X402Signer;
  /** Convert the challenge's atomic amount to Purse Money for exact comparison.
   *  Default: treat `maxAmountRequired` as integer minor units in the grant's currency
   *  (true for the mock, where asset is "USD-cents"). Override for real USDC (6 decimals). */
  toMoney?: (reqs: PaymentRequirements, grantCurrency: string) => Money;
  /** Injectable fetch for testing; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

function defaultToMoney(reqs: PaymentRequirements, currency: string): Money {
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
    try {
      const res = await this.f(url);
      if (res.status !== 402) return { ok: false, error: `expected a 402 challenge, got ${res.status}` };
      const body = (await res.json()) as { accepts?: PaymentRequirements[] };
      const accept = body.accepts?.[0];
      if (!accept) return { ok: false, error: "402 challenge carried no payment requirements" };
      challenge = accept;
    } catch (e) {
      return { ok: false, error: `challenge probe failed: ${(e as Error).message}` };
    }

    // 2. Intent-binding: the challenged amount MUST equal the granted amount, exactly.
    const toMoney = this.opts.toMoney ?? defaultToMoney;
    const challenged = toMoney(challenge, grant.amount.currency);
    if (!Number.isInteger(challenged.amount) || challenged.amount !== grant.amount.amount || challenged.currency !== grant.amount.currency) {
      return { ok: false, error: `402 amount (${challenge.maxAmountRequired} ${challenge.asset}) does not match the grant (${grant.amount.amount} ${grant.amount.currency})` };
    }

    // 3. Sign and settle.
    try {
      const header = await this.opts.signer.sign(challenge);
      const res = await this.f(url, { headers: { "X-PAYMENT": header } });
      if (res.status !== 200) return { ok: false, error: `settlement failed: HTTP ${res.status}` };
      const settle = (await res.json()) as { ref?: string };
      if (!settle.ref) return { ok: false, error: "settlement response carried no ref" };
      return { ok: true, ref: settle.ref, paidAmount: grant.amount, raw: settle };
    } catch (e) {
      return { ok: false, error: `settlement failed: ${(e as Error).message}` };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx test/x402-executor.test.ts`
Expected: PASS — `5 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add examples/x402/x402-executor.ts test/x402-executor.test.ts
git commit -m "feat(x402): X402Executor with exact-amount settlement binding"
```

---

### Task 3: Governed-agent proof demo (two processes) + headless integration test + scripts

**Files:**
- Create: `examples/x402/agent.ts` (the scripted child)
- Create: `examples/x402/broker-host.ts` (parent: broker + X402Executor + mock resources + principal)
- Test: `test/x402-governed.test.ts` (headless: spawns the flow, asserts the five outcomes)
- Modify: `package.json` (add `demo:x402`; add the three x402 test files to `test`)

**Interfaces:**
- Consumes: `Broker`, `serveBroker`, `spawnAgent`, `PurseClient` (from `../../src/index`); `X402Executor` (Task 2); `MockSigner`, `startMock402` (Task 1); `node:url` (`fileURLToPath`); `node:child_process` types.
- Produces: a runnable two-process demo (`npm run demo:x402`) and a headless integration test asserting the five proof scenes.

**Scene design (fixed amounts so budgets don't collide):**
- Broker: `maxPerAction: "$150"`, `maxPerDay: "$100"`, `allow: ["acme.example", "premium.example"]`, `requireApprovalOver: "$50"`.
- Mock resources: `acme.example` priced `$3.00` (`"300"`), `premium.example` priced `$75.00` (`"7500"`).
- Scene 1 normal: request `$3` → `acme.example` → allowed → execute → x402 settles.
- Scene 2 injection: request `$10` → `attacker.evil` → denied (off allowlist).
- Scene 3 over-threshold: request `$75` → `premium.example` → needs_approval → principal approves → execute → settles.
- Scene 4 split: loop request `$3` → `acme.example` up to 20× (no execute) → reservation denies once the daily cap is reached.
- Scene 5 proof: `verify().ok === true` + the last executed `explain` (with the x402 ref).

- [ ] **Step 1: Write the failing test** — `test/x402-governed.test.ts`

```ts
import { spawnAgent, serveBroker, Broker } from "../src/index";
import { X402Executor } from "../examples/x402/x402-executor";
import { MockSigner } from "../examples/x402/mock-signer";
import { startMock402 } from "../examples/x402/mock-402-server";
import { fileURLToPath } from "node:url";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

// Two priced mock resources (parent-side; the agent never sees them).
const acme = await startMock402({ amount: "300", payTo: "acme" });
const premium = await startMock402({ amount: "7500", payTo: "premium" });
const resources: Record<string, string> = { "acme.example": acme.url, "premium.example": premium.url };

const broker = new Broker({
  maxPerAction: "$150",
  maxPerDay: "$100",
  allow: ["acme.example", "premium.example"],
  requireApprovalOver: "$50",
  executor: new X402Executor({ resolvePayee: (p) => resources[p], signer: new MockSigner() }),
});

const child = spawnAgent(fileURLToPath(new URL("../examples/x402/agent.ts", import.meta.url)));
serveBroker(child, broker);

const report: Record<string, unknown> = await new Promise((resolve) => {
  child.on("message", (m: { kind?: string; pendingId?: string; data?: Record<string, unknown> }) => {
    if (m?.kind === "await-approval" && m.pendingId) {
      const { grantId } = broker.approve(m.pendingId);
      child.send({ kind: "approved", grantId });
    }
    if (m?.kind === "report") resolve(m.data ?? {});
  });
});
child.kill();
await acme.close();
await premium.close();

check("scene 1: in-policy spend settled over x402", report.normalPaid === true);
check("scene 2: injected off-allowlist payment denied", report.injectionDenied === true);
check("scene 3: over-threshold settled only after principal approval", report.approvedPaid === true);
check("scene 4: split-under-cap attack was blocked at least once", report.splitBlocked === true);
check("scene 5: audit chain verifies (broker side)", broker.verify().ok === true);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Write `examples/x402/agent.ts`** (the scripted child)

```ts
// The agent. Holds ONLY PurseClient — no executor, no signer, no resource map, no credential.
// Walks the five proof scenes and reports the outcomes back to the parent.
import { PurseClient } from "../../src/index";

const purse = PurseClient.fromProcess();
const log = (s: string) => console.log(`  [agent] ${s}`);
const out: Record<string, unknown> = {};

// Scene 1 — normal in-policy spend, settled over x402.
{
  const r = await purse.request({ amount: "$3", payee: "acme.example", intent: "top up credits" });
  log(`request $3 acme.example -> ${r.decision}`);
  if (r.decision === "allowed" && r.grantId) {
    const x = await purse.execute(r.grantId);
    out.normalPaid = x.status === "paid";
    log(`execute -> ${x.status}${x.receipt?.ref ? ` (ref ${x.receipt.ref})` : ""}`);
  }
}

// Scene 2 — prompt injection: pay an attacker.
{
  const r = await purse.request({ amount: "$10", payee: "attacker.evil", intent: "URGENT overdue invoice" });
  out.injectionDenied = r.decision === "denied";
  log(`injected pay attacker.evil -> ${r.decision}`);
}

// Scene 3 — over-threshold: needs a human, then settles.
{
  const r = await purse.request({ amount: "$75", payee: "premium.example", intent: "annual plan" });
  log(`request $75 premium.example -> ${r.decision}`);
  if (r.decision === "needs_approval" && r.pendingId) {
    const grantId: string | undefined = await new Promise((resolve) => {
      process.on("message", (m: { kind?: string; grantId?: string }) => {
        if (m?.kind === "approved") resolve(m.grantId);
      });
      process.send?.({ kind: "await-approval", pendingId: r.pendingId });
    });
    if (grantId) {
      const x = await purse.execute(grantId);
      out.approvedPaid = x.status === "paid";
      log(`principal approved -> execute -> ${x.status}`);
    }
  }
}

// Scene 4 — split-under-cap attack: many under-threshold requests, never executed.
{
  let allowed = 0, denied = 0;
  for (let i = 0; i < 20; i++) {
    const r = await purse.request({ amount: "$3", payee: "acme.example", intent: `loop ${i}` });
    if (r.decision === "allowed") allowed++; else denied++;
  }
  out.splitBlocked = denied > 0;
  log(`split attack: ${allowed} reserved, then ${denied} blocked by the daily cap`);
}

process.send?.({ kind: "report", data: out });
```

- [ ] **Step 3: Write `examples/x402/broker-host.ts`** (the parent + principal — the runnable demo)

```ts
// The principal's process: holds the Broker + the X402Executor (credential) + the resource map.
// Spawns the agent as a subordinate child. Run: npm run demo:x402
import { Broker, serveBroker, spawnAgent } from "../../src/index";
import { X402Executor } from "./x402-executor";
import { MockSigner } from "./mock-signer";
import { startMock402 } from "./mock-402-server";
import { fileURLToPath } from "node:url";

const acme = await startMock402({ amount: "300", payTo: "acme" });       // $3.00
const premium = await startMock402({ amount: "7500", payTo: "premium" }); // $75.00
const resources: Record<string, string> = { "acme.example": acme.url, "premium.example": premium.url };

const broker = new Broker({
  maxPerAction: "$150",
  maxPerDay: "$100",
  allow: ["acme.example", "premium.example"],
  requireApprovalOver: "$50",
  executor: new X402Executor({ resolvePayee: (p) => resources[p], signer: new MockSigner() }),
});

const child = spawnAgent(fileURLToPath(new URL("./agent.ts", import.meta.url)));
serveBroker(child, broker);

child.on("message", async (m: { kind?: string; pendingId?: string }) => {
  if (m?.kind === "await-approval" && m.pendingId) {
    console.log(`  [principal] approving pending ${m.pendingId} (out of band)`);
    const { grantId } = broker.approve(m.pendingId);
    child.send({ kind: "approved", grantId });
  }
  if ((m as { kind?: string }).kind === "report") {
    const executed = broker.audit().filter((r) => r.event === "executed");
    console.log(`\n  [proof] audit records: ${broker.audit().length}`);
    console.log(`  [proof] x402 settlements: ${executed.length} (refs: ${executed.map((r) => r.receipt?.ref).join(", ")})`);
    console.log(`  [proof] tamper-evident chain intact: ${broker.verify().ok}`);
    await acme.close();
    await premium.close();
    child.kill();
    process.exit(0);
  }
});
```

- [ ] **Step 4: Update `package.json`** — add `demo:x402` and the three x402 test files to `test`

Replace the `test` script (extend the Phase 1 list) and add `demo:x402` after `demo:enforce`:

```json
    "test": "tsx test/policy.test.ts && tsx test/evaluate.test.ts && tsx test/audit-explain.test.ts && tsx test/executor.test.ts && tsx test/grants.test.ts && tsx test/grants-reservation.test.ts && tsx test/broker.test.ts && tsx test/transport.test.ts && tsx test/transport-http.test.ts && tsx test/x402-mock.test.ts && tsx test/x402-executor.test.ts && tsx test/x402-governed.test.ts",
    "demo:x402": "tsx examples/x402/broker-host.ts",
```

- [ ] **Step 5: Run the integration test, the full suite, and the demo**

Run: `npx tsx test/x402-governed.test.ts`
Expected: PASS — `5 passed, 0 failed`.
Run: `npm test`
Expected: every file prints `N passed, 0 failed`; process exits 0.
Run: `npm run demo:x402`
Expected output (interleaving possible), ending with:
```
  [agent] request $3 acme.example -> allowed
  [agent] execute -> paid (ref mock_tx_1)
  [agent] injected pay attacker.evil -> denied
  [agent] request $75 premium.example -> needs_approval
  [principal] approving pending ... (out of band)
  [agent] principal approved -> execute -> paid
  [agent] split attack: N reserved, then M blocked by the daily cap
  [proof] audit records: ...
  [proof] x402 settlements: 2 (refs: mock_tx_1, mock_tx_1)
  [proof] tamper-evident chain intact: true
```
(The two settlements come from two different mock servers, so each ref is `mock_tx_1` — that is expected; refs are per-resource.)

- [ ] **Step 6: Build + commit**

Run: `npm run build`
Expected: exits 0 (src only; examples are not type-checked by the build).

```bash
git add examples/x402/agent.ts examples/x402/broker-host.ts test/x402-governed.test.ts package.json
git commit -m "feat(x402): two-process governed-agent proof demo + headless integration test"
```

---

### Task 4 (optional but planned): Phase 2 README + optional real-LLM variant

**Files:**
- Create: `examples/x402/README.md`
- Create: `examples/x402/governed-agent-llm.ts` (complete, manual-run, NOT in `npm test`)
- Modify: `package.json` (add `demo:x402:llm`)

**Interfaces:**
- Consumes: `PurseClient` (from `../../src/index`); global `fetch`; `process.env.ANTHROPIC_API_KEY`.
- Produces: documentation (mock↔testnet mapping, run instructions) and a real-model demo entrypoint behind the same `PurseClient` boundary.

- [ ] **Step 1: Create `examples/x402/README.md`**

````markdown
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

## Intent-binding at the rail

`X402Executor` probes the resource for its 402 challenge and **requires the challenged amount
to equal the grant amount exactly** — same integer minor units, same currency — failing closed
on any mismatch. This carries Purse's intent-binding all the way to settlement: a compromised
agent cannot be redirected to pay a different amount than was authorized.

## Going live on Base Sepolia (testnet)

The mock speaks in USD cents (`asset: "USD-cents"`, integer minor units) so the executor's
verification logic is exercised without a chain. To settle real testnet USDC:

1. `npm i x402 x402-fetch viem` (these belong to the broker deployment, not the zero-dep core).
2. Implement an `X402Signer` whose `sign()` produces a real EIP-3009 `transferWithAuthorization`
   from a funded Base Sepolia wallet (a `viem` account holding the test key — broker-side only).
3. Point `resolvePayee` at your real x402 resource URLs and configure a facilitator.
4. Provide a `toMoney` that converts USDC's **6-decimal** atomic units to your policy currency's
   minor units (e.g. `5_000_000` atomic USDC → `500` USD cents = divide by `10 ** 4`), keeping the
   exact-match check intact.

The private key and facilitator credentials live only in the broker process. The agent client is
unchanged — it still only calls `request` / `execute` / `status`.

## Optional: drive it with a real LLM

```bash
ANTHROPIC_API_KEY=sk-... npm run demo:x402:llm
```

`governed-agent-llm.ts` runs a minimal Claude tool-use loop whose only payment tool is
`PurseClient.execute`, behind the same broker boundary. It is not part of `npm test` (needs an
API key + network) and is non-deterministic — it demonstrates the boundary with a real model.
````

- [ ] **Step 2: Create `examples/x402/governed-agent-llm.ts`**

```ts
// Optional real-model variant: a minimal Claude tool-use loop whose ONLY payment path is
// PurseClient, behind the same broker boundary as the scripted demo. Manual run:
//   ANTHROPIC_API_KEY=sk-... npm run demo:x402:llm
// Not part of npm test (needs an API key + network; non-deterministic).
import { PurseClient } from "../../src/index";

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.error("Set ANTHROPIC_API_KEY to run the LLM variant."); process.exit(1); }

const purse = PurseClient.fromProcess();

const tools = [{
  name: "pay",
  description: "Request and settle a payment through Purse. Returns the decision and result.",
  input_schema: {
    type: "object",
    properties: { amount: { type: "string" }, payee: { type: "string" }, intent: { type: "string" } },
    required: ["amount", "payee"],
  },
}];

async function pay(input: { amount: string; payee: string; intent?: string }): Promise<string> {
  const r = await purse.request(input);
  if (r.decision !== "allowed" || !r.grantId) return `request -> ${r.decision}: ${r.reason}`;
  const x = await purse.execute(r.grantId);
  return `execute -> ${x.status}${x.receipt?.ref ? ` (ref ${x.receipt.ref})` : ""}: ${x.reason}`;
}

async function callClaude(messages: unknown[]): Promise<any> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY!, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 1024, tools, messages }),
  });
  return res.json();
}

const messages: unknown[] = [{
  role: "user",
  content: "You are an ops agent. Top up API credits by paying $3 to acme.example. Use the pay tool.",
}];

let reply = await callClaude(messages);
for (let turn = 0; turn < 4; turn++) {
  const toolUses = (reply.content ?? []).filter((b: { type: string }) => b.type === "tool_use");
  console.log(`  [claude] ${(reply.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join(" ")}`);
  if (toolUses.length === 0) break;
  messages.push({ role: "assistant", content: reply.content });
  const results = [];
  for (const tu of toolUses) {
    const result = await pay(tu.input);
    console.log(`  [purse] ${result}`);
    results.push({ type: "tool_result", tool_use_id: tu.id, content: result });
  }
  messages.push({ role: "user", content: results });
  reply = await callClaude(messages);
}

process.send?.({ kind: "report", data: { llm: true } });
```

- [ ] **Step 3: Add the `demo:x402:llm` script to `package.json`**

Add after `demo:x402` (the LLM variant is launched by the same broker host, which spawns whichever agent file it is pointed at; to keep it simple, add a dedicated host that spawns `governed-agent-llm.ts`). Add this script:

```json
    "demo:x402:llm": "tsx examples/x402/broker-host-llm.ts",
```

Then create `examples/x402/broker-host-llm.ts` as a copy of `broker-host.ts` that spawns `./governed-agent-llm.ts` instead of `./agent.ts` (same broker + mock resources + approval wiring). Keep the two hosts separate so the scripted demo stays dependency- and key-free.

```ts
// broker-host-llm.ts — same broker/executor/mock setup as broker-host.ts, but spawns the
// LLM-driven agent. Run: ANTHROPIC_API_KEY=sk-... npm run demo:x402:llm
import { Broker, serveBroker, spawnAgent } from "../../src/index";
import { X402Executor } from "./x402-executor";
import { MockSigner } from "./mock-signer";
import { startMock402 } from "./mock-402-server";
import { fileURLToPath } from "node:url";

const acme = await startMock402({ amount: "300", payTo: "acme" });
const resources: Record<string, string> = { "acme.example": acme.url };

const broker = new Broker({
  maxPerAction: "$150", maxPerDay: "$100",
  allow: ["acme.example"], requireApprovalOver: "$50",
  executor: new X402Executor({ resolvePayee: (p) => resources[p], signer: new MockSigner() }),
});

const child = spawnAgent(fileURLToPath(new URL("./governed-agent-llm.ts", import.meta.url)));
serveBroker(child, broker);
child.on("message", async (m: { kind?: string }) => {
  if (m?.kind === "report") {
    console.log(`\n  [proof] chain intact: ${broker.verify().ok}; settlements: ${broker.audit().filter((r) => r.event === "executed").length}`);
    await acme.close();
    child.kill();
    process.exit(0);
  }
});
```

- [ ] **Step 4: Verify the docs/optional path does not break the suite**

Run: `npm test`
Expected: unchanged — every file prints `N passed, 0 failed` (the LLM variant and its host are NOT in the test list). `npm run build` still exits 0.

> Do NOT run `demo:x402:llm` in CI or as part of this task's verification — it needs `ANTHROPIC_API_KEY` and network. A manual smoke run is optional.

- [ ] **Step 5: Commit**

```bash
git add examples/x402/README.md examples/x402/governed-agent-llm.ts examples/x402/broker-host-llm.ts package.json
git commit -m "docs(x402): Phase 2 README (testnet mapping) + optional real-LLM variant"
```

---

## Self-Review

**1. Spec coverage** (against §11 of `2026-07-04-enforcement-mode-broker-intent-binding-design.md`):
- §11.1 x402 Executor (implements `Executor`, credential broker-side) → Task 2. ✔
- §11.2 governed-agent demo, five scenes over `PurseClient → broker → x402` → Task 3 (demo + headless test). ✔
- §11.3 proof (injection stopped + chain verifies with explain) → Task 3 scenes 2 & 5. ✔
- §11.4 resolved decisions: exact-amount binding (Task 2), local-mock + documented testnet (Tasks 1, 4), scripted + optional LLM (Tasks 3, 4), zero new deps (all tasks). ✔

**2. Placeholder scan:** No `TBD`/`TODO`/"handle errors"/"similar to". Every code step shows complete code, including the optional LLM variant. ✔

**3. Type consistency:** `PaymentRequirements`/`X402Signer` defined in Task 1, consumed identically in Tasks 2/4. `X402Executor`/`X402ExecutorOptions` defined in Task 2, consumed in Tasks 3/4. `startMock402(opts) → {url, close}` and `MockSigner` consistent across Tasks 1/2/3/4. `resolvePayee`/`signer` option names consistent. Reuses Phase 1 `Broker`/`serveBroker`/`spawnAgent`/`PurseClient`/`Payable`/`Receipt`/`Money`/`parseMoney` with their real signatures. ✔

**4. Environment note carried from Phase 1:** every child spawn resolves its path with `fileURLToPath(new URL(...))`, never `new URL(...).pathname` (the Windows path bug fixed in Phase 1 Task 7). Applied in Task 3 (test, broker-host) and Task 4 (broker-host-llm). ✔

Out of this plan by design (tracked elsewhere): live Base Sepolia settlement (documented, needs a funded wallet); Stripe/Paystack adapters; the root-README HARNESS CARD prose (a Phase-1 doc follow-up); durable velocity ledger and audit `event`-taxonomy docs (Phase-1 final-review follow-ups).
