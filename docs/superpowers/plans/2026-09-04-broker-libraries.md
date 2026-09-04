# Broker Libraries Implementation Plan (plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the two library changes the broker image depends on: the x402 module promoted into `@olurabian/purse` as a dependency-free subpath (0.4.0), and `instrumentBroker` with spans and metrics in `@olurabian/deadlatch-otel` (0.2.0).

**Architecture:** Move `examples/x402/{types,x402-executor,mock-signer,mock-402-server}.ts` into `src/x402/`, widen the requirement and signer types to the official v1 fields, export the module as `@olurabian/purse/x402`. In deadlatch-otel, wrap a `Broker` the way `instrumentPurse` wraps a `Purse`, and register OTel metrics through the API package so any SDK collects them.

**Tech Stack:** TypeScript strict, NodeNext ESM. Purse tests use their own `check()` harness; deadlatch-otel uses `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-04-broker-image-design.md` (sections A and B)

## Global Constraints

- `@olurabian/purse` keeps its single runtime dependency (`@olurabian/receipt`). The x402 module imports only `node:*` modules and purse's own files.
- `@olurabian/deadlatch-otel` keeps `@opentelemetry/api` as its only runtime dependency.
- `PaymentRequirements` gains `maxTimeoutSeconds?: number` and `extra?: { name?: string; version?: string }`; `X402Signer.sign(reqs, ctx: { x402Version: number })`.
- Subpath export `@olurabian/purse/x402` with `types` before `import`.
- Metric names: `deadlatch.purse.decisions`, `deadlatch.purse.executions`, `deadlatch.purse.approvals.pending`, `deadlatch.purse.store.pending`, `deadlatch.purse.store.degraded`. Span names: `deadlatch.enforce.request`, `deadlatch.enforce.execute`, `deadlatch.enforce.approve`, `deadlatch.enforce.deny`.
- Versions: purse `0.3.1 → 0.4.0`, deadlatch-otel `0.1.1 → 0.2.0`.
- All import specifiers end in `.js`. Every task ends with `npm run build && npm test` green. Every commit ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Before every `npm publish`: `npm run build && npm test && npm pack --dry-run` with `dist/index.js` and `dist/index.d.ts` present (and `dist/x402/index.js` for purse).
- No push, no publish before the release task, which runs only after ARABA confirms.
- Public copy has no colons and no em dashes inside prose sentences; no counterparty names. Never stage `purse/docs/launch-x402.md`.

## File structure

**purse** (branch `broker-libs`): create `src/x402/index.ts`, `src/x402/types.ts`, `src/x402/executor.ts`, `src/x402/mock-signer.ts`, `src/x402/mock-402-server.ts`; delete `examples/x402/{types,x402-executor,mock-signer,mock-402-server}.ts`; modify `examples/x402/*.ts` and `test/x402-*.test.ts` imports, `package.json` (exports, version), `README.md`, `CHANGELOG.md`, `examples/x402/README.md`.

**deadlatch-otel** (branch `broker-libs`): create `src/broker.ts`, `test/broker.test.ts`; modify `src/types.ts`, `src/index.ts`, `package.json`, `README.md`, `CHANGELOG.md` (create if absent).

---

### Task 1: Promote the x402 module into Purse

**Working directory:** `/c/Users/ARABA/Workspace/SaaS/purse`, branch `broker-libs`.

- [ ] **Step 1: Move the files**

```bash
mkdir -p src/x402
git mv examples/x402/types.ts src/x402/types.ts
git mv examples/x402/x402-executor.ts src/x402/executor.ts
git mv examples/x402/mock-signer.ts src/x402/mock-signer.ts
git mv examples/x402/mock-402-server.ts src/x402/mock-402-server.ts
```

- [ ] **Step 2: Widen the types**

Replace the two interfaces in `src/x402/types.ts` with:

```ts
export interface PaymentRequirements {
  scheme: string;            // "exact"
  network: string;           // "base-sepolia" | "base" (real) or "mock"
  maxAmountRequired: string; // atomic units of `asset`, as a string
  payTo: string;             // receiving address / vendor id
  asset: string;             // token contract address, or "USD-cents" in the mock
  resource: string;          // the resource URL being paid for
  maxTimeoutSeconds?: number; // validity window for the authorization; the official client defaults to 60
  extra?: { name?: string; version?: string }; // EIP-712 domain name and version of `asset`
}

// Given the challenge, produce the value for the X-PAYMENT header.
// Mock: encodes the challenge. Real: signs an EIP-3009 authorization with a wallet.
export interface X402Signer {
  sign(reqs: PaymentRequirements, ctx: { x402Version: number }): Promise<string>;
}
```

- [ ] **Step 3: Fix imports and pass the protocol version**

In `src/x402/executor.ts`: change `import type { PaymentRequirements, X402Signer } from "./types";` to `from "./types.js"`, and change the import of `Executor` (and any other purse types) from the old `../../src/...` paths to `../executor.js` / `../types.js` / `../money.js` as appropriate (`grep -n "from \"" src/x402/executor.ts` shows every import; each must resolve and end in `.js`). Where the executor reads the 402 body, capture the version and pass it to the signer:

```ts
      const body = (await res.json()) as { x402Version?: number; accepts?: PaymentRequirements[] };
```

and at the sign call:

```ts
      const header = await this.opts.signer.sign(accept, { x402Version: body.x402Version ?? 1 });
```

In `src/x402/mock-signer.ts` change the import to `./types.js` and the signature to `async sign(reqs: PaymentRequirements, _ctx: { x402Version: number }): Promise<string>` (body unchanged). In `src/x402/mock-402-server.ts` fix any relative import to `.js`.

Create `src/x402/index.ts`:

```ts
export { X402Executor } from "./executor.js";
export type { X402ExecutorOptions } from "./executor.js";
export type { PaymentRequirements, X402Signer } from "./types.js";
export { MockSigner } from "./mock-signer.js";
export { startMock402 } from "./mock-402-server.js";
export type { Mock402Options } from "./mock-402-server.js";
```

If `X402ExecutorOptions` or `Mock402Options` is not exported by its file, export it.

- [ ] **Step 4: Repoint examples and tests**

```bash
grep -rln "x402-executor\|mock-signer\|mock-402-server\|from \"./types\"" examples/x402 test | sort
```

In every listed file replace imports of the moved modules with `from "../src/x402/index.js"` (tests) or `from "../../src/x402/index.js"` (examples), keeping the imported names. Re-run the grep; it must print nothing. Update `examples/x402/README.md`: the sentence that says `npm i x402 x402-fetch viem` belongs to the broker deployment now reads "The real signer lives in the broker image (see `deploy/README.md` once published); the executor and the mock are importable from `@olurabian/purse/x402`."

- [ ] **Step 5: Subpath export and version**

In `package.json` set `"version": "0.4.0"` and add to `exports`:

```json
    "./x402": {
      "types": "./dist/x402/index.d.ts",
      "import": "./dist/x402/index.js"
    }
```

(keep the existing `"."` entry first). Update `package-lock.json`'s two root `version` fields to `0.4.0`.

- [ ] **Step 6: Verify**

Run: `npm run build && npm test`
Expected: build clean, `dist/x402/index.js` exists, every suite `0 failed` (the x402 suites now import from `src/x402`). Then:

```bash
node --input-type=module -e "import('./dist/x402/index.js').then(m => console.log(Object.keys(m).sort().join(' ')))"
```

Expected: `MockSigner X402Executor startMock402`.

- [ ] **Step 7: README and changelog**

In `README.md`, in the `## The x402 governed-agent proof` section, append the paragraph:

```markdown
The executor and the mock are part of the package. `import { X402Executor, MockSigner, startMock402 } from "@olurabian/purse/x402"` brings in the protocol adapter with no extra dependencies. A wallet signer is not included here, it belongs in the broker deployment that holds the key.
```

Prepend to `CHANGELOG.md`:

```markdown
## 0.4.0 (2026-09-04)

The x402 executor, its types, the mock signer, and the mock 402 server move from the examples into the package as the subpath `@olurabian/purse/x402`. `PaymentRequirements` gains `maxTimeoutSeconds` and `extra` (the EIP-712 domain name and version). `X402Signer.sign` receives the protocol version. No runtime dependencies added.

```

- [ ] **Step 8: Commit**

```bash
git add src/x402 examples/x402 test package.json package-lock.json README.md CHANGELOG.md
git commit -q -m "feat(x402): executor, types, and mocks move into the package as @olurabian/purse/x402

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: instrumentBroker in deadlatch-otel

**Working directory:** `/c/Users/ARABA/Workspace/SaaS/deadlatch-otel`, branch `broker-libs`.

- [ ] **Step 1: Add the metrics SDK for tests**

```bash
npm install --save-dev @opentelemetry/sdk-metrics --no-audit --no-fund && npx allow-scripts
```

- [ ] **Step 2: Types**

Append to `src/types.ts`:

```ts
export interface BrokerRequestLike {
  decision: string; // "allowed" | "needs_approval" | "denied"
  reason?: string;
  grantId?: string;
  pendingId?: string;
}

export interface BrokerExecuteLike {
  status: string; // "paid" | "rejected"
  reason?: string;
}

export interface BrokerLike {
  request(req: unknown): BrokerRequestLike;
  execute(grantId: string): Promise<BrokerExecuteLike>;
  approve?(pendingId: string): unknown;
  deny?(pendingId: string): unknown;
  pending?(): unknown[];
  verify(): VerifyResultLike;
}

export interface StoreHealthLike {
  pending?(): number;
  degraded?(): Error | null;
}

export interface InstrumentBrokerOptions {
  tracerName?: string;
  meterName?: string;
  store?: StoreHealthLike;
}
```

- [ ] **Step 3: Write the failing test**

Create `test/broker.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { trace, metrics } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { MeterProvider, InMemoryMetricExporter, PeriodicExportingMetricReader, AggregationTemporality } from "@opentelemetry/sdk-metrics";
import { Broker, MockExecutor } from "@olurabian/purse";
import { instrumentBroker } from "../src/index.js";

const spans = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
trace.setGlobalTracerProvider(tracerProvider);
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const reader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 3_600_000 });
const meterProvider = new MeterProvider({ readers: [reader] });
metrics.setGlobalMeterProvider(meterProvider);

function metricPoints(name: string) {
  const out: { value: number; attrs: Record<string, unknown> }[] = [];
  for (const rm of metricExporter.getMetrics()) for (const sm of rm.scopeMetrics) for (const m of sm.metrics) {
    if (m.descriptor.name !== name) continue;
    for (const dp of m.dataPoints) out.push({ value: Number(dp.value), attrs: dp.attributes as Record<string, unknown> });
  }
  return out;
}

test("request, execute, approve and deny emit enforce spans with attributes", async () => {
  spans.reset();
  const b = instrumentBroker(new Broker({ maxPerAction: "$5", requireApprovalOver: "$3", allow: ["api.stripe.com"], executor: new MockExecutor() }));
  const r = b.request({ amount: "$1", payee: "api.stripe.com", intent: "credits" });
  const x = await b.execute(r.grantId!);
  const p = b.request({ amount: "$4", payee: "api.stripe.com", intent: "big" });
  b.approve(p.pendingId!);
  const d = b.request({ amount: "$4", payee: "api.stripe.com", intent: "big2" });
  b.deny(d.pendingId!);
  const denied = b.request({ amount: "$9", payee: "api.stripe.com", intent: "too big" });
  assert.equal(x.status, "paid");
  assert.equal(denied.decision, "denied");
  const names = spans.getFinishedSpans().map((s) => s.name);
  assert.deepEqual(names, [
    "deadlatch.enforce.request", "deadlatch.enforce.execute",
    "deadlatch.enforce.request", "deadlatch.enforce.approve",
    "deadlatch.enforce.request", "deadlatch.enforce.deny",
    "deadlatch.enforce.request",
  ]);
  const first = spans.getFinishedSpans()[0]!;
  assert.equal(first.attributes["purse.decision"], "allowed");
  assert.equal(first.attributes["purse.payee"], "api.stripe.com");
  assert.equal(first.attributes["deadlatch.leg"], "enforce");
  assert.equal(typeof first.attributes["purse.grant_id"], "string");
  const last = spans.getFinishedSpans().at(-1)!;
  assert.equal(last.attributes["purse.decision"], "denied");
  assert.equal(last.status.code, 2); // SpanStatusCode.ERROR
  const exec = spans.getFinishedSpans()[1]!;
  assert.equal(exec.attributes["purse.status"], "paid");
});

test("a rejected execute and a thrown execute mark the span as error", async () => {
  spans.reset();
  const b = instrumentBroker(new Broker({ maxPerAction: "$5", allow: ["api.stripe.com"], executor: new MockExecutor() }));
  const x = await b.execute("no-such-grant");
  assert.equal(x.status, "rejected");
  assert.equal(spans.getFinishedSpans()[0]!.status.code, 2);
  const boom = { ...b, execute: async () => { throw new Error("db down"); } } as unknown as Broker;
  const wrapped = instrumentBroker(boom);
  await assert.rejects(wrapped.execute("x"), /db down/);
  assert.equal(spans.getFinishedSpans()[1]!.status.code, 2);
});

test("counters and gauges are recorded", async () => {
  let pending = 3; let degraded: Error | null = null;
  const b = instrumentBroker(new Broker({ maxPerAction: "$5", requireApprovalOver: "$3", allow: ["api.stripe.com"], executor: new MockExecutor() }), {
    store: { pending: () => pending, degraded: () => degraded },
  });
  const r = b.request({ amount: "$1", payee: "api.stripe.com", intent: "c" });
  await b.execute(r.grantId!);
  b.request({ amount: "$4", payee: "api.stripe.com", intent: "needs approval" });
  b.request({ amount: "$9", payee: "api.stripe.com", intent: "denied" });
  degraded = new Error("latched");
  await reader.forceFlush();
  const decisions = metricPoints("deadlatch.purse.decisions");
  const byDecision = Object.fromEntries(decisions.map((p) => [p.attrs.decision, p.value]));
  assert.ok(byDecision.allowed >= 1 && byDecision.needs_approval >= 1 && byDecision.denied >= 1, JSON.stringify(byDecision));
  const executions = metricPoints("deadlatch.purse.executions");
  assert.ok(executions.some((p) => p.attrs.status === "paid" && p.value >= 1));
  assert.equal(metricPoints("deadlatch.purse.store.pending").at(-1)?.value, 3);
  assert.equal(metricPoints("deadlatch.purse.store.degraded").at(-1)?.value, 1);
  assert.equal(metricPoints("deadlatch.purse.approvals.pending").at(-1)?.value, 1);
});
```

- [ ] **Step 4: Run to see it fail**

Run: `npx tsx --test test/broker.test.ts`
Expected: fails at import, `instrumentBroker` is not exported.

- [ ] **Step 5: Implement**

Create `src/broker.ts`:

```ts
import { SpanStatusCode, metrics, type Attributes, type Span } from "@opentelemetry/api";
import { getTracer, DEADLATCH_TRACER } from "./otel.js";
import type { BrokerLike, BrokerRequestLike, BrokerExecuteLike, InstrumentBrokerOptions } from "./types.js";

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function base(span: Span): void {
  span.setAttribute("deadlatch.leg", "enforce");
  span.setAttribute("deadlatch.package", "purse");
}

/**
 * Wrap a Purse Broker (enforcement mode) so request(), execute(), approve() and deny()
 * each emit one `deadlatch.enforce.*` span, and decisions, executions, pending approvals
 * and store health flow as metrics. Instrumented in place; the broker is returned.
 */
export function instrumentBroker<T extends BrokerLike>(broker: T, opts: InstrumentBrokerOptions = {}): T {
  const tracer = getTracer(opts.tracerName ?? DEADLATCH_TRACER);
  const meter = metrics.getMeter(opts.meterName ?? DEADLATCH_TRACER);
  const decisions = meter.createCounter("deadlatch.purse.decisions", { description: "Spend decisions by outcome" });
  const executions = meter.createCounter("deadlatch.purse.executions", { description: "Grant executions by status" });

  if (typeof broker.pending === "function") {
    meter.createObservableGauge("deadlatch.purse.approvals.pending", { description: "Spends waiting for a principal" })
      .addCallback((r) => { try { r.observe(broker.pending!().length); } catch { /* keep observing */ } });
  }
  if (opts.store?.pending) {
    const s = opts.store;
    meter.createObservableGauge("deadlatch.purse.store.pending", { description: "Receipts queued but not yet durable" })
      .addCallback((r) => { try { r.observe(s.pending!()); } catch { /* keep observing */ } });
  }
  if (opts.store?.degraded) {
    const s = opts.store;
    meter.createObservableGauge("deadlatch.purse.store.degraded", { description: "1 when the audit store has latched" })
      .addCallback((r) => { try { r.observe(s.degraded!() ? 1 : 0); } catch { /* keep observing */ } });
  }

  const origRequest = broker.request.bind(broker);
  broker.request = ((req: unknown): BrokerRequestLike =>
    tracer.startActiveSpan("deadlatch.enforce.request", (span) => {
      base(span);
      const r = req as { amount?: unknown; payee?: unknown } | null;
      if (r?.amount != null) span.setAttribute("purse.amount", String(r.amount));
      if (r?.payee != null) span.setAttribute("purse.payee", String(r.payee));
      let out: BrokerRequestLike;
      try {
        out = origRequest(req);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errMessage(err) });
        span.end();
        throw err;
      }
      const attrs: Attributes = { "purse.decision": out.decision };
      if (out.reason) attrs["purse.reason"] = out.reason;
      if (out.grantId) attrs["purse.grant_id"] = out.grantId;
      if (out.pendingId) attrs["purse.pending_id"] = out.pendingId;
      span.setAttributes(attrs);
      if (out.decision === "denied") span.setStatus({ code: SpanStatusCode.ERROR, message: out.reason ?? "denied" });
      decisions.add(1, { decision: out.decision });
      span.end();
      return out;
    })) as T["request"];

  const origExecute = broker.execute.bind(broker);
  broker.execute = ((grantId: string): Promise<BrokerExecuteLike> =>
    tracer.startActiveSpan("deadlatch.enforce.execute", async (span) => {
      base(span);
      span.setAttribute("purse.grant_id", grantId);
      try {
        const out = await origExecute(grantId);
        span.setAttribute("purse.status", out.status);
        if (out.reason) span.setAttribute("purse.reason", out.reason);
        if (out.status !== "paid") span.setStatus({ code: SpanStatusCode.ERROR, message: out.reason ?? out.status });
        executions.add(1, { status: out.status });
        return out;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errMessage(err) });
        executions.add(1, { status: "error" });
        throw err;
      } finally {
        span.end();
      }
    })) as T["execute"];

  for (const name of ["approve", "deny"] as const) {
    const orig = broker[name];
    if (typeof orig !== "function") continue;
    const bound = (orig as (pendingId: string) => unknown).bind(broker);
    (broker as Record<string, unknown>)[name] = (pendingId: string): unknown =>
      tracer.startActiveSpan(`deadlatch.enforce.${name}`, (span) => {
        base(span);
        span.setAttribute("purse.pending_id", pendingId);
        try {
          return bound(pendingId);
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: errMessage(err) });
          throw err;
        } finally {
          span.end();
        }
      });
  }

  return broker;
}
```

Add to `src/index.ts`: `export { instrumentBroker } from "./broker.js";` and extend the type export line with `BrokerLike, BrokerRequestLike, BrokerExecuteLike, StoreHealthLike, InstrumentBrokerOptions`.

- [ ] **Step 6: Run to see it pass**

Run: `npx tsx --test test/broker.test.ts`
Expected: 3 pass. If the first test's span order differs because `approve`/`deny` are not present on the Broker under the installed purse version, stop and report (the installed `@olurabian/purse` must be ≥ 0.3.0, which has them).

Run: `npm run build && npm test`
Expected: green, 9 tests.

- [ ] **Step 7: README, changelog, version**

In `README.md`, after the section that documents `instrumentPurse`, add:

```markdown
## Enforcement mode

`instrumentBroker(broker, { store })` wraps a Purse `Broker`. Every `request()`, `execute()`, `approve()` and `deny()` becomes a `deadlatch.enforce.*` span, denied decisions and rejected executions are marked as errors, and five metrics flow through the OpenTelemetry API so whatever SDK you run collects them. `deadlatch.purse.decisions` and `deadlatch.purse.executions` are counters. `deadlatch.purse.approvals.pending`, `deadlatch.purse.store.pending` and `deadlatch.purse.store.degraded` are gauges, the last two read from the store you pass in, which is how a latched Postgres store becomes a page instead of a silence.
```

Create or prepend `CHANGELOG.md`:

```markdown
# Changelog

## 0.2.0 (2026-09-04)

Adds `instrumentBroker` for Purse enforcement mode, with spans for request, execute, approve and deny, and metrics for decisions, executions, pending approvals, and audit store health. `@opentelemetry/api` remains the only runtime dependency.

## 0.1.1 (2026-09-04)

Reads blackbox 0.2 receipt envelopes as well as the flat 0.1 shape. Never emits NaN for `blackbox.broken_at`; adds `blackbox.broken_id`.
```

Set `"version": "0.2.0"` in `package.json` and both root fields in `package-lock.json`.

- [ ] **Step 8: Commit**

```bash
git add src/broker.ts src/types.ts src/index.ts test/broker.test.ts package.json package-lock.json README.md CHANGELOG.md
git commit -q -m "feat: instrumentBroker, spans and metrics for Purse enforcement mode

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Gate and final review

- [ ] **Step 1:** Clean-install gate for purse and deadlatch-otel (`rm -rf node_modules && npm ci && npx allow-scripts && npm run build && npm test`).
- [ ] **Step 2:** Confirm nothing pushed or published (`npm view @olurabian/purse version` → 0.3.1, `@olurabian/deadlatch-otel` → 0.1.1; both branches ahead of main with no upstream).
- [ ] **Step 3:** Final review over both diffs with the Global Constraints as the lens; fix Critical and Important findings.

---

### Task 4: Release (only after ARABA confirms)

- [ ] **Step 1: purse 0.4.0**

```bash
cd /c/Users/ARABA/Workspace/SaaS/purse && git checkout main && git merge --ff-only broker-libs && git push origin main
npm run build && npm test && npm pack --dry-run 2>&1 | grep -E "dist/index\.js|dist/index\.d\.ts|dist/x402/index\.js" && npm publish --access public && npm view @olurabian/purse version
```

Expected: `0.4.0`.

- [ ] **Step 2: deadlatch-otel 0.2.0 against purse 0.4.0**

```bash
cd /c/Users/ARABA/Workspace/SaaS/deadlatch-otel && git checkout main && git merge --ff-only broker-libs
npm install --save-dev @olurabian/purse@^0.4.0 --no-audit --no-fund && npx allow-scripts && npm run build && npm test
git add package.json package-lock.json && git commit -q -m "chore: test against purse 0.4

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && git push origin main
npm pack --dry-run 2>&1 | grep -E "dist/index\.js|dist/index\.d\.ts" && npm publish --access public && npm view @olurabian/deadlatch-otel version
```

Expected: `0.2.0`, CI green on both repos.

- [ ] **Step 3: Smoke from a clean scratchpad directory**

Install `@olurabian/purse@0.4.0` and `@olurabian/deadlatch-otel@0.2.0`, import `X402Executor` from `@olurabian/purse/x402` and `instrumentBroker` from deadlatch-otel, wrap a Broker with a MockExecutor, request and execute a spend, print the status. Expected: `paid`.

## Self-review

**Spec coverage.** Section A: move, widened types, protocol version to the signer, subpath export, docs, version (Task 1). Section B: types, spans with the named attributes and error marking, five metrics, tests with in-memory exporters, docs, version (Task 2). Release order deadlatch-otel after purse (Task 4).

**Placeholder scan.** None. Task 1 step 3 describes import fixes by rule because the exact old paths are in the moved files; the grep in step 4 is the check.

**Type consistency.** `BrokerLike.request` returns `decision`, matching Purse's `RequestResult.decision`; `execute` returns `status`, matching `ExecuteResult.status`; `pending()` returns an array (`PendingView[]`). `StoreHealthLike` matches `PostgresStore.pending()` and `degraded()`.
