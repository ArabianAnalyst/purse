# Monitor process (purse-broker 0.3.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the monitor, a third process group in the `purse-broker` image that reads new receipts every minute, judges each one once against a sliding window with four built-in Purse expectations plus a team's own, stores every flag beside the receipts, and pushes only the flags to a Deadlatch project, or to a local file when no key is set.

**Architecture:** Six new files in `deploy/broker/src/`. `monitor-config.ts` (env parsing in the broker's style), `purse-records.ts` (a Purse decision receipt as a Tripwire action record), `purse-expectations.ts` (the built-ins and the custom-module loader), `monitor-app.ts` (the Postgres source, cursor store, recording sink, events, readiness, telemetry, all composed around `createMonitor` from `@olurabian/tripwire/monitor`), `monitor-server.ts` (the read-only port), `monitor.ts` (the entry). One helper added to `http.ts`. Tests run on PGlite with a fake hosted side. The engine's own guarantees (never re-judge, cursor after confirmed push, held flags, heartbeat once per tick) come from tripwire 0.2.0 and are not re-implemented here.

**Tech Stack:** TypeScript strict, ESM, Node 22, `node:test` via `tsx`, `pg`, PGlite (dev), `@olurabian/tripwire` 0.2.0, `@olurabian/receipt` 0.3.0, `@olurabian/purse` 0.4.0, `@opentelemetry/api`.

**Spec:** `../../../tripwire/docs/superpowers/specs/2026-09-09-live-monitor-design.md` (the tripwire repository), Part 2 "the monitor process in the broker image", plus Part 1 for the engine API. Plan 2 of three.

## Global Constraints

- The app is `deploy/broker`. Version becomes `0.3.0`. `@olurabian/tripwire` `^0.2.0` joins `dependencies` through `npm install`, so `package-lock.json` changes with it (CI runs `npm ci`).
- ESM, TypeScript `strict`, `moduleResolution: NodeNext`, relative imports end in `.js`. `npm run typecheck` also type-checks `test/` through `tsconfig.test.json`, so test code must pass strict too.
- Tests are `test/*.test.ts` via `tsx --test`; helpers in `test/helpers/`. Database tests use PGlite through the `SqlClient` interface, seeded through the real `PostgresStore` so the receipts table is the broker's own.
- The monitor is read-only against `receipts`. It writes only `monitor_cursor`, `monitor_flags`, `monitor_events`, and the flags file. Nothing on its port can change anything, and non-GET is 404.
- The project key is never logged and never served. Only its first eight characters after `dl_live_` appear, on `GET /` and in the boot line.
- Every flag is inserted into `monitor_flags` (unique on the flag id) before the push, so the local record exists when the hosted side is down.
- The source reads at most 500 receipts per tick, which bounds the engine's pending list during an outage.
- Built-in expectations are defined only over fields the chain carries. Ids `executed-without-grant`, `executed-once`, `paid-matches-decision`, `payee-velocity`. Reasons exactly as in the spec's table.
- README and spec prose contain no colons and no em dashes outside code, inline code, table rows and URLs. No counterparty or partner names anywhere.
- Nothing is pushed to `main`, tagged, or deployed before the release task, which runs only after ARABA's go. `main` is protected. Push to a branch, wait for the `test`, `broker` and `gitleaks (secrets)` checks, then fast-forward `main`. The image builds on the `broker-v0.3.0` tag.
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never stage `docs/launch-x402.md`.
- Fake project keys in tests are low-entropy strings such as `dl_live_aaaaaaaabbbb`, because the gitleaks pre-commit hook and the CI check flag a high-entropy value next to a name containing `key`.

## Deviations from the spec, ruled here and written back in Task 6

1. Flags are stored in their own table `monitor_flags (n, id unique, stream, at, flag)` rather than as `monitor_events` rows of kind `flag`, so the id makes the local record idempotent and `GET /flags?since=<n>` pages by a real sequence. `monitor_events` keeps the non-flag events.
2. `monitor_events` uses `n BIGSERIAL` like `witness_events`, not `id`.
3. The engine calls the sink's heartbeat, so the process wires nothing (already in the spec after Plan 1).
4. A receipts row whose `record` does not parse as JSON is a `skipped` event with reason `record does not parse`, not a tick failure.
5. The app's sink wrapper passes the hosted sink's `heartbeat` through to the engine but hides its `queued`, so the engine's `queued` counts exactly the flags the monitor holds. The hosted sink's own queue holds the same ids and is an implementation detail; reporting both would show two for one flag.

---

### Task 1: Dependency, version, and the monitor config

**Files:**
- Modify: `deploy/broker/package.json` (version, dependency), `deploy/broker/package-lock.json` (via npm install)
- Create: `deploy/broker/src/monitor-config.ts`
- Test: `deploy/broker/test/monitor-config.test.ts`

**Interfaces:**
- Produces: `MonitorConfigError`, `Span { count, ms }`, `MonitorConfig`, `parseSpan(name, value): Span`, `loadMonitorConfig(env?): MonitorConfig`.

- [ ] **Step 1: Dependency and version**

From `deploy/broker`:

```bash
npm install @olurabian/tripwire@^0.2.0 --no-audit --no-fund
```

Confirm `package.json` now lists `"@olurabian/tripwire": "^0.2.0"` under `dependencies` and that `package-lock.json` changed. Then change `"version": "0.2.0"` to `"version": "0.3.0"` in `package.json`.

- [ ] **Step 2: Failing tests**

`test/monitor-config.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadMonitorConfig, parseSpan, MonitorConfigError } from "../src/monitor-config.js";

const base = () => ({ DATABASE_URL: "postgres://x" });

test("defaults", () => {
  const c = loadMonitorConfig(base());
  assert.equal(c.stream, "purse");
  assert.equal(c.table, "receipts");
  assert.equal(c.intervalMs, 60000);
  assert.deepEqual(c.window, { count: 500, ms: 24 * 60 * 60 * 1000 });
  assert.deepEqual(c.velocity, { count: 5, ms: 10 * 60 * 1000 });
  assert.deepEqual(c.disable, []);
  assert.equal(c.expectationsModule, undefined);
  assert.deepEqual(c.deadlatch, { url: "https://www.deadlatch.dev", projectKey: undefined });
  assert.equal(c.flagsFile, "/data/flags.jsonl");
  assert.equal(c.port, 8083);
  assert.equal(c.bind, "0.0.0.0");
  assert.equal(c.otel, false);
});

test("PURSE_STREAM is the fallback for MONITOR_STREAM, and MONITOR_STREAM wins", () => {
  assert.equal(loadMonitorConfig({ ...base(), PURSE_STREAM: "s1" }).stream, "s1");
  assert.equal(loadMonitorConfig({ ...base(), PURSE_STREAM: "s1", MONITOR_STREAM: "s2" }).stream, "s2");
});

test("DATABASE_URL is required", () => {
  assert.throws(() => loadMonitorConfig({}), (e: unknown) => e instanceof MonitorConfigError && /DATABASE_URL is required/.test((e as Error).message));
});

test("parseSpan reads count and duration in m, h or d", () => {
  assert.deepEqual(parseSpan("X", "500/24h"), { count: 500, ms: 86_400_000 });
  assert.deepEqual(parseSpan("X", "5/10m"), { count: 5, ms: 600_000 });
  assert.deepEqual(parseSpan("X", "1/2d"), { count: 1, ms: 172_800_000 });
  assert.deepEqual(parseSpan("X", " 7/1h "), { count: 7, ms: 3_600_000 });
});

test("parseSpan rejects the wrong shape, an unknown unit, and zero", () => {
  for (const bad of ["500", "500/24", "500/24s", "abc/1h", "/1h", "500/", "0/1h", "5/0m"]) {
    assert.throws(() => parseSpan("MONITOR_WINDOW", bad), (e: unknown) => e instanceof MonitorConfigError && /MONITOR_WINDOW/.test((e as Error).message), bad);
  }
});

test("MONITOR_WINDOW and MONITOR_VELOCITY are parsed and validated at load", () => {
  const c = loadMonitorConfig({ ...base(), MONITOR_WINDOW: "100/2h", MONITOR_VELOCITY: "3/1m" });
  assert.deepEqual(c.window, { count: 100, ms: 7_200_000 });
  assert.deepEqual(c.velocity, { count: 3, ms: 60_000 });
  assert.throws(() => loadMonitorConfig({ ...base(), MONITOR_VELOCITY: "3 per minute" }), /MONITOR_VELOCITY/);
});

test("DEADLATCH_URL is trimmed of trailing slashes and must be http or https", () => {
  assert.equal(loadMonitorConfig({ ...base(), DEADLATCH_URL: "https://deadlatch.test///" }).deadlatch.url, "https://deadlatch.test");
  assert.throws(() => loadMonitorConfig({ ...base(), DEADLATCH_URL: "deadlatch.test" }), /DEADLATCH_URL must start with/);
});

test("an empty DEADLATCH_PROJECT_KEY is no key", () => {
  assert.equal(loadMonitorConfig({ ...base(), DEADLATCH_PROJECT_KEY: "" }).deadlatch.projectKey, undefined);
  assert.equal(loadMonitorConfig({ ...base(), DEADLATCH_PROJECT_KEY: "dl_live_abc" }).deadlatch.projectKey, "dl_live_abc");
});

test("MONITOR_DISABLE splits on commas and drops blanks, MONITOR_EXPECTATIONS is a path", () => {
  const c = loadMonitorConfig({ ...base(), MONITOR_DISABLE: " executed-once, ,payee-velocity ", MONITOR_EXPECTATIONS: "/etc/purse/expectations.mjs" });
  assert.deepEqual(c.disable, ["executed-once", "payee-velocity"]);
  assert.equal(c.expectationsModule, "/etc/purse/expectations.mjs");
});

test("integers are validated with their floor", () => {
  assert.throws(() => loadMonitorConfig({ ...base(), MONITOR_INTERVAL_MS: "500" }), /MONITOR_INTERVAL_MS must be an integer of at least 1000/);
  assert.throws(() => loadMonitorConfig({ ...base(), MONITOR_PORT: "-1" }), /MONITOR_PORT must be an integer of at least 0/);
  assert.equal(loadMonitorConfig({ ...base(), MONITOR_PORT: "0" }).port, 0);
});

test("otel is on only when the OTLP endpoint is set", () => {
  assert.equal(loadMonitorConfig({ ...base(), OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }).otel, true);
});
```

- [ ] **Step 3: Run to see them fail**

Run: `npx tsx --test test/monitor-config.test.ts`
Expected: FAIL, cannot find `../src/monitor-config.js`.

- [ ] **Step 4: monitor-config.ts**

`src/monitor-config.ts`:

```ts
export class MonitorConfigError extends Error {
  constructor(message: string) { super(`purse-monitor config: ${message}`); this.name = "MonitorConfigError"; }
}

/** A count and a duration, the shape of both the window and the velocity threshold. */
export interface Span { count: number; ms: number }

export interface MonitorConfig {
  databaseUrl: string;
  stream: string;
  /** The receipts table the broker writes. */
  table: string;
  intervalMs: number;
  window: Span;
  velocity: Span;
  /** Built-in expectation ids switched off. */
  disable: string[];
  /** Path to an ES module whose default export is an Expectation[]. */
  expectationsModule: string | undefined;
  deadlatch: { url: string; projectKey: string | undefined };
  /** Where flags go when there is no project key. */
  flagsFile: string;
  port: number;
  bind: string;
  otel: boolean;
}

type Env = Record<string, string | undefined>;

const UNIT: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `<count>/<duration>`, the duration a positive integer followed by m, h or d, for example `500/24h`. */
export function parseSpan(name: string, value: string): Span {
  const m = /^(\d+)\/(\d+)([mhd])$/.exec(value.trim());
  if (!m) throw new MonitorConfigError(`${name} must be <count>/<duration> with the duration in m, h or d, for example 500/24h, got "${value}"`);
  const count = Number(m[1]);
  const n = Number(m[2]);
  if (count < 1 || n < 1) throw new MonitorConfigError(`${name} count and duration must be at least 1, got "${value}"`);
  return { count, ms: n * UNIT[m[3]!]! };
}

const int = (name: string, v: string | undefined, dflt: number, min: number): number => {
  if (v == null || v === "") return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new MonitorConfigError(`${name} must be an integer of at least ${min}, got "${v}"`);
  return n;
};

export function loadMonitorConfig(env: Env = process.env): MonitorConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new MonitorConfigError("DATABASE_URL is required");
  const stream = env.MONITOR_STREAM ?? env.PURSE_STREAM ?? "purse";
  const url = (env.DEADLATCH_URL ?? "https://www.deadlatch.dev").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) throw new MonitorConfigError(`DEADLATCH_URL must start with http:// or https://, got "${url}"`);
  const projectKey = env.DEADLATCH_PROJECT_KEY || undefined;
  const disable = (env.MONITOR_DISABLE ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return {
    databaseUrl, stream, table: "receipts",
    intervalMs: int("MONITOR_INTERVAL_MS", env.MONITOR_INTERVAL_MS, 60000, 1000),
    window: parseSpan("MONITOR_WINDOW", env.MONITOR_WINDOW ?? "500/24h"),
    velocity: parseSpan("MONITOR_VELOCITY", env.MONITOR_VELOCITY ?? "5/10m"),
    disable,
    expectationsModule: env.MONITOR_EXPECTATIONS || undefined,
    deadlatch: { url, projectKey },
    flagsFile: env.MONITOR_FLAGS_FILE ?? "/data/flags.jsonl",
    port: int("MONITOR_PORT", env.MONITOR_PORT, 8083, 0),
    bind: env.MONITOR_BIND ?? "0.0.0.0",
    otel: Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT),
  };
}
```

- [ ] **Step 5: Run the tests, then everything**

Run: `npx tsx --test test/monitor-config.test.ts`
Expected: PASS, 11 tests.

Run: `npm run build && npm run typecheck && npm test`
Expected: all green (the 48 existing plus 11).

- [ ] **Step 6: Commit**

```bash
git add deploy/broker/package.json deploy/broker/package-lock.json deploy/broker/src/monitor-config.ts deploy/broker/test/monitor-config.test.ts
git commit -m "monitor: config, tripwire 0.2.0 dependency, broker 0.3.0

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: A Purse decision receipt as a Tripwire record

**Files:**
- Create: `deploy/broker/src/purse-records.ts`
- Test: `deploy/broker/test/purse-records.test.ts`

**Interfaces:**
- Consumes: `ActionRecord`, `Outcome` from `@olurabian/tripwire`; `ReceiptLike` from `@olurabian/tripwire/monitor`; `DecisionPayload` from `@olurabian/purse`.
- Produces: `purseRecord(receipt: ReceiptLike<unknown>): ActionRecord | null`.

- [ ] **Step 1: Failing tests**

`test/purse-records.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReceiptLike } from "@olurabian/tripwire/monitor";
import { purseRecord } from "../src/purse-records.js";

const env = (kind: string, payload: unknown): ReceiptLike<unknown> => ({ id: "r1", ts: "2026-09-09T00:00:00.000Z", kind, payload, prevHash: "0".repeat(64), hash: "f".repeat(64) });
const request = { amount: { amount: 1250, currency: "USD" }, payee: "api.stripe.com", intent: "credits" };

test("grant_minted maps to an ok record with the grant in meta and no cost", () => {
  const r = purseRecord(env("decision", { request, status: "allowed", reason: "within policy", policyVersion: "p1", event: "grant_minted", grantId: "g1" }));
  assert.deepEqual(r, {
    action: "grant_minted",
    input: request,
    outcome: "ok",
    meta: { grantId: "g1", policyVersion: "p1", reason: "within policy", status: "allowed", paidAmount: undefined, currency: "USD" },
  });
});

test("executed with a settled amount carries it as cost and in meta", () => {
  const r = purseRecord(env("decision", { request, status: "allowed", reason: "executed", policyVersion: "p1", event: "executed", grantId: "g1", receipt: { ok: true, ref: "pi_1", paidAmount: { amount: 1200, currency: "USD" } } }));
  assert.equal(r?.action, "executed");
  assert.equal(r?.outcome, "ok");
  assert.equal(r?.cost, 1200);
  assert.deepEqual((r?.meta as { paidAmount: unknown }).paidAmount, { amount: 1200, currency: "USD" });
});

test("executed without a settled amount costs the requested amount", () => {
  const r = purseRecord(env("decision", { request, status: "allowed", reason: "executed", policyVersion: "p1", event: "executed", grantId: "g1", receipt: { ok: true } }));
  assert.equal(r?.cost, 1250);
});

test("execution_failed is an error record whatever the status, with the reason as error", () => {
  const r = purseRecord(env("decision", { request, status: "denied", reason: "rejected: grant not found", policyVersion: "p1", event: "execution_failed", grantId: "g1" }));
  assert.equal(r?.action, "execution_failed");
  assert.equal(r?.outcome, "error");
  assert.equal(r?.error, "rejected: grant not found");
  assert.equal(r?.cost, undefined);
});

test("denied is blocked, needs_approval is ok with pending in meta, a decision with no event is action decision", () => {
  const denied = purseRecord(env("decision", { request, status: "denied", reason: "not allowed", policyVersion: "p1", event: "decision" }));
  assert.equal(denied?.outcome, "blocked");
  const pending = purseRecord(env("decision", { request, status: "needs_approval", reason: "needs approval", policyVersion: "p1", event: "decision" }));
  assert.equal(pending?.outcome, "ok");
  assert.equal((pending?.meta as { pending?: boolean }).pending, true);
  const bare = purseRecord(env("decision", { request, status: "allowed", reason: "ok", policyVersion: "p1" }));
  assert.equal(bare?.action, "decision");
  assert.equal((bare?.meta as { pending?: boolean }).pending, undefined);
});

test("a receipt of another kind maps to null", () => {
  assert.equal(purseRecord(env("note", { anything: 1 })), null);
});

test("a decision without a request, or with an unknown status, throws so the source can skip it", () => {
  assert.throws(() => purseRecord(env("decision", { status: "allowed" })), /decision payload without a request/);
  assert.throws(() => purseRecord(env("decision", null)), /decision payload without a request/);
  assert.throws(() => purseRecord(env("decision", { request, status: "maybe", reason: "", policyVersion: "p1" })), /unknown decision status maybe/);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx tsx --test test/purse-records.test.ts`
Expected: FAIL, cannot find `../src/purse-records.js`.

- [ ] **Step 3: purse-records.ts**

`src/purse-records.ts`:

```ts
import type { ActionRecord, Outcome } from "@olurabian/tripwire";
import type { ReceiptLike } from "@olurabian/tripwire/monitor";
import type { DecisionPayload } from "@olurabian/purse";

interface Money { amount: number; currency: string }

const STATUS: Record<string, Outcome> = { allowed: "ok", denied: "blocked", needs_approval: "ok" };

/**
 * A Purse decision receipt as a Tripwire action record. Null for any other kind, which the source
 * reports as skipped. Throws for a decision without a request or with an unknown status, which the
 * source also reports as skipped, with the message.
 */
export function purseRecord(r: ReceiptLike<unknown>): ActionRecord | null {
  if (r.kind !== "decision") return null;
  const p = r.payload as Partial<DecisionPayload> | null;
  if (!p || typeof p !== "object" || !p.request || typeof p.request !== "object") throw new Error("decision payload without a request");
  const status = String(p.status);
  const byStatus = STATUS[status];
  if (!byStatus) throw new Error(`unknown decision status ${status}`);
  const action = p.event ?? "decision";
  const outcome: Outcome = action === "execution_failed" ? "error" : byStatus;
  const paid = p.receipt?.paidAmount as Money | undefined;
  const requested = p.request.amount as Money | undefined;
  const cost = paid ? paid.amount : action === "executed" ? requested?.amount : undefined;
  const meta: Record<string, unknown> = {
    grantId: p.grantId,
    policyVersion: p.policyVersion,
    reason: p.reason,
    status,
    paidAmount: paid,
    currency: requested?.currency,
  };
  if (status === "needs_approval") meta.pending = true;
  const record: ActionRecord = { action, input: p.request, outcome, meta };
  if (outcome === "error") record.error = p.reason;
  if (cost !== undefined) record.cost = cost;
  return record;
}
```

- [ ] **Step 4: Run the tests, then everything, commit**

Run: `npx tsx --test test/purse-records.test.ts`
Expected: PASS, 7 tests.

Run: `npm run build && npm run typecheck && npm test`
Expected: all green.

```bash
git add deploy/broker/src/purse-records.ts deploy/broker/test/purse-records.test.ts
git commit -m "monitor: a Purse decision receipt as a Tripwire action record

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The built-in expectations and the custom-module loader

**Files:**
- Create: `deploy/broker/src/purse-expectations.ts`
- Test: `deploy/broker/test/purse-expectations.test.ts`

**Interfaces:**
- Consumes: `defineExpectations`, `Expectation`, `ActionRecord`, `Trace` from `@olurabian/tripwire`; `evaluate` and `LiveRecord` from `@olurabian/tripwire/monitor` (tests); `Span`, `MonitorConfig` from Task 1.
- Produces: `BUILTIN_IDS`, `builtinExpectations(velocity: Span): Expectation[]`, `loadExpectations(cfg: Pick<MonitorConfig, "velocity" | "disable" | "expectationsModule">): Promise<Expectation[]>`.

- [ ] **Step 1: Failing tests**

`test/purse-expectations.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Trace } from "@olurabian/tripwire";
import { evaluate, type LiveRecord } from "@olurabian/tripwire/monitor";
import { BUILTIN_IDS, builtinExpectations, loadExpectations } from "../src/purse-expectations.js";

const T0 = Date.UTC(2026, 8, 9, 0, 0, 0);
const at = (minute: number) => new Date(T0 + minute * 60_000);

interface Opts { grant?: string; payee?: string; amount?: number; currency?: string; paid?: number; paidCurrency?: string; minute?: number }

/** A live record at `seq`, timestamped `seq` minutes in unless `minute` is given. */
function rec(seq: number, action: "grant_minted" | "executed" | "execution_failed" | "decision", o: Opts = {}): LiveRecord {
  const currency = o.currency ?? "USD";
  const paid = o.paid === undefined ? undefined : { amount: o.paid, currency: o.paidCurrency ?? currency };
  return {
    action,
    input: { amount: { amount: o.amount ?? 1250, currency }, payee: o.payee ?? "api.stripe.com" },
    outcome: action === "execution_failed" ? "error" : "ok",
    meta: { grantId: o.grant, paidAmount: paid, currency },
    ref: { stream: "t", seq, id: `id-${seq}`, hash: "a".repeat(64), ts: at(o.minute ?? seq).toISOString() },
  };
}

const exps = builtinExpectations({ count: 5, ms: 10 * 60_000 });
const ids = (records: LiveRecord[]) => {
  const last = records[records.length - 1]!;
  return evaluate(exps, last, new Trace(records), at(99)).map((f) => f.expectation.id);
};

test("the four built-ins carry the spec's ids and reasons", () => {
  assert.deepEqual(exps.map((e) => e.id), [...BUILTIN_IDS]);
  assert.deepEqual(exps.map((e) => e.reason), [
    "An execution happened for a grant this window never saw minted.",
    "A single-use grant executed twice.",
    "The rail settled a different amount than the decision allowed.",
    "The same payee was paid too many times too quickly.",
  ]);
});

test("executed-without-grant holds when the grant was minted earlier in the window", () => {
  assert.deepEqual(ids([rec(1, "grant_minted", { grant: "g1" }), rec(2, "executed", { grant: "g1" })]), []);
});

test("executed-without-grant fires with no minted record, a minted record for another grant, a minted record later than the execution, or no grant at all", () => {
  assert.deepEqual(ids([rec(1, "executed", { grant: "g1" })]), ["executed-without-grant"]);
  assert.deepEqual(ids([rec(1, "grant_minted", { grant: "g2" }), rec(2, "executed", { grant: "g1" })]), ["executed-without-grant"]);
  assert.deepEqual(ids([rec(2, "grant_minted", { grant: "g1" }), rec(1, "executed", { grant: "g1" })]), ["executed-without-grant"]);
  assert.deepEqual(ids([rec(1, "grant_minted", { grant: "g1" }), rec(2, "executed", {})]), ["executed-without-grant"]);
});

test("executed-once fires on a second execution of the same grant and not on a different grant", () => {
  const minted = [rec(1, "grant_minted", { grant: "g1" }), rec(2, "grant_minted", { grant: "g2" })];
  assert.deepEqual(ids([...minted, rec(3, "executed", { grant: "g1" }), rec(4, "executed", { grant: "g1" })]), ["executed-once"]);
  assert.deepEqual(ids([...minted, rec(3, "executed", { grant: "g1" }), rec(4, "executed", { grant: "g2" })]), []);
  assert.deepEqual(ids([...minted, rec(3, "execution_failed", { grant: "g1" }), rec(4, "executed", { grant: "g1" })]), []);
});

test("paid-matches-decision holds on the minted amount and currency, fires on a different amount or currency, and holds with no settled amount or no minted record", () => {
  const minted = rec(1, "grant_minted", { grant: "g1", amount: 1250 });
  assert.deepEqual(ids([minted, rec(2, "executed", { grant: "g1", paid: 1250 })]), []);
  assert.deepEqual(ids([minted, rec(2, "executed", { grant: "g1", paid: 1200 })]), ["paid-matches-decision"]);
  assert.deepEqual(ids([minted, rec(2, "executed", { grant: "g1", paid: 1250, paidCurrency: "EUR" })]), ["paid-matches-decision"]);
  assert.deepEqual(ids([minted, rec(2, "executed", { grant: "g1" })]), []);
  assert.deepEqual(ids([rec(2, "executed", { grant: "g1", paid: 99 })]), ["executed-without-grant"]);
});

test("payee-velocity fires on the fifth execution to one payee inside ten minutes, and not when spread out, to different payees, or four", () => {
  // mints sit at low seqs and minute 0, executions at seqs 11 and up, one per minute, so only velocity can fire
  const mint = (n: number) => rec(n, "grant_minted", { grant: `g${n}`, minute: 0 });
  const burst = (n: number, o: Opts = {}) => Array.from({ length: n }, (_, i) => rec(11 + i, "executed", { grant: `g${i + 1}`, minute: i + 1, ...o }));
  const mints = Array.from({ length: 5 }, (_, i) => mint(i + 1));
  assert.deepEqual(ids([...mints, ...burst(4)]), []);
  assert.deepEqual(ids([...mints, ...burst(5)]), ["payee-velocity"]);
  const spread = burst(5).map((r, i) => ({ ...r, ref: { ...r.ref, ts: at(i * 3).toISOString() } }));
  assert.deepEqual(ids([...mints, ...spread]), []);
  const mixed = burst(5).map((r, i) => (i === 0 ? { ...r, input: { ...(r.input as object), payee: "other.example" } } : r));
  assert.deepEqual(ids([...mints, ...mixed]), []);
});

test("loadExpectations applies MONITOR_DISABLE and rejects an unknown id", async () => {
  const some = await loadExpectations({ velocity: { count: 5, ms: 600_000 }, disable: ["executed-once", "payee-velocity"], expectationsModule: undefined });
  assert.deepEqual(some.map((e) => e.id), ["executed-without-grant", "paid-matches-decision"]);
  await assert.rejects(loadExpectations({ velocity: { count: 5, ms: 600_000 }, disable: ["nope"], expectationsModule: undefined }), /unknown built-in "nope"/);
});

test("loadExpectations loads a custom module after the built-ins, and a colliding id is a boot error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "purse-monitor-exp-"));
  const ok = join(dir, "ok.mjs");
  writeFileSync(ok, `export default [{ id: "no-big-tips", reason: "A tip over 100.", where: { action: "executed" }, must: (r) => r.input.amount.amount <= 100 }];\n`);
  const all = await loadExpectations({ velocity: { count: 5, ms: 600_000 }, disable: [], expectationsModule: ok });
  assert.deepEqual(all.map((e) => e.id), [...BUILTIN_IDS, "no-big-tips"]);
  const clash = join(dir, "clash.mjs");
  writeFileSync(clash, `export default [{ id: "executed-once", reason: "x", must: () => true }];\n`);
  await assert.rejects(loadExpectations({ velocity: { count: 5, ms: 600_000 }, disable: [], expectationsModule: clash }), /Duplicate expectation id: executed-once/);
  const notArray = join(dir, "notarray.mjs");
  writeFileSync(notArray, `export default { id: "x" };\n`);
  await assert.rejects(loadExpectations({ velocity: { count: 5, ms: 600_000 }, disable: [], expectationsModule: notArray }), /must default-export an array/);
  await assert.rejects(loadExpectations({ velocity: { count: 5, ms: 600_000 }, disable: [], expectationsModule: join(dir, "missing.mjs") }), /cannot load MONITOR_EXPECTATIONS/);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx tsx --test test/purse-expectations.test.ts`
Expected: FAIL, cannot find `../src/purse-expectations.js`.

- [ ] **Step 3: purse-expectations.ts**

`src/purse-expectations.ts`:

```ts
import { pathToFileURL } from "node:url";
import { defineExpectations, type ActionRecord, type Expectation, type Trace } from "@olurabian/tripwire";
import type { MonitorConfig, Span } from "./monitor-config.js";

interface Money { amount: number; currency: string }
interface Ref { seq: number; ts: string }

const metaOf = (r: ActionRecord) => (r.meta ?? {}) as { grantId?: string; paidAmount?: Money };
const grantOf = (r: ActionRecord) => metaOf(r).grantId;
const refOf = (r: ActionRecord) => (r as { ref?: Ref }).ref;
const seqOf = (r: ActionRecord) => refOf(r)?.seq ?? -1;
const tsOf = (r: ActionRecord) => Date.parse(refOf(r)?.ts ?? "");
const payeeOf = (r: ActionRecord) => (r.input as { payee?: string } | undefined)?.payee;
const amountOf = (r: ActionRecord) => (r.input as { amount?: Money } | undefined)?.amount;
const mintedFor = (trace: Trace, grantId: string) => trace.records.find((x) => x.action === "grant_minted" && grantOf(x) === grantId);

export const BUILTIN_IDS = ["executed-without-grant", "executed-once", "paid-matches-decision", "payee-velocity"] as const;

/** The four built-ins, each defined only over fields the chain carries. */
export function builtinExpectations(velocity: Span): Expectation[] {
  return defineExpectations([
    {
      id: "executed-without-grant",
      reason: "An execution happened for a grant this window never saw minted.",
      where: { action: "executed" },
      must: (r, trace) => {
        const g = grantOf(r);
        if (!g) return false;
        const minted = mintedFor(trace, g);
        return !!minted && seqOf(minted) < seqOf(r);
      },
    },
    {
      id: "executed-once",
      reason: "A single-use grant executed twice.",
      where: { action: "executed" },
      must: (r, trace) => {
        const g = grantOf(r);
        if (!g) return true;
        return !trace.records.some((x) => x !== r && x.action === "executed" && grantOf(x) === g);
      },
    },
    {
      id: "paid-matches-decision",
      reason: "The rail settled a different amount than the decision allowed.",
      where: { action: "executed" },
      must: (r, trace) => {
        const paid = metaOf(r).paidAmount;
        const g = grantOf(r);
        if (!paid || !g) return true;
        const minted = mintedFor(trace, g);
        const want = minted ? amountOf(minted) : undefined;
        if (!want) return true;
        return paid.amount === want.amount && paid.currency === want.currency;
      },
    },
    {
      id: "payee-velocity",
      reason: "The same payee was paid too many times too quickly.",
      where: { action: "executed" },
      must: (r, trace) => {
        const payee = payeeOf(r);
        const t = tsOf(r);
        if (!payee || Number.isNaN(t)) return true;
        const n = trace.records.filter((x) => {
          if (x.action !== "executed" || payeeOf(x) !== payee) return false;
          const xt = tsOf(x);
          return !Number.isNaN(xt) && xt <= t && xt >= t - velocity.ms;
        }).length;
        return n < velocity.count;
      },
    },
  ]);
}

/** Built-ins minus MONITOR_DISABLE, then the custom module's default export. Ids must not collide. */
export async function loadExpectations(cfg: Pick<MonitorConfig, "velocity" | "disable" | "expectationsModule">): Promise<Expectation[]> {
  const known = new Set<string>(BUILTIN_IDS);
  for (const id of cfg.disable) {
    if (!known.has(id)) throw new Error(`purse-monitor: MONITOR_DISABLE names an unknown built-in "${id}", known ids are ${BUILTIN_IDS.join(", ")}`);
  }
  const builtins = builtinExpectations(cfg.velocity).filter((e) => !cfg.disable.includes(e.id));
  let custom: Expectation[] = [];
  if (cfg.expectationsModule) {
    let mod: { default?: unknown };
    try {
      mod = (await import(pathToFileURL(cfg.expectationsModule).href)) as { default?: unknown };
    } catch (e) {
      throw new Error(`purse-monitor: cannot load MONITOR_EXPECTATIONS ${cfg.expectationsModule}, ${(e as Error).message}`);
    }
    if (!Array.isArray(mod.default)) throw new Error(`purse-monitor: MONITOR_EXPECTATIONS ${cfg.expectationsModule} must default-export an array of expectations`);
    custom = mod.default as Expectation[];
  }
  try {
    return defineExpectations([...builtins, ...custom]);
  } catch (e) {
    throw new Error(`purse-monitor: ${(e as Error).message}`);
  }
}
```

- [ ] **Step 4: Run the tests, then everything, commit**

Run: `npx tsx --test test/purse-expectations.test.ts`
Expected: PASS, 8 tests. If the velocity test's "spread" case fails, check that `tsOf` reads `ref.ts`, not the record's arrival, and that the burst records in the test are one minute apart (minute `i + 1`) so five of them span four minutes.

Run: `npm run build && npm run typecheck && npm test`
Expected: all green.

```bash
git add deploy/broker/src/purse-expectations.ts deploy/broker/test/purse-expectations.test.ts
git commit -m "monitor: the four built-in Purse expectations and the custom-module loader

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The monitor app on Postgres

**Files:**
- Create: `deploy/broker/src/monitor-app.ts`
- Test: `deploy/broker/test/helpers/monitor-fixture.ts`, `deploy/broker/test/monitor-app.test.ts`

**Interfaces:**
- Consumes: `createMonitor`, `deadlatchSink`, `fileSink`, `fromReceipts`, types from `@olurabian/tripwire/monitor`; `purseRecord` (Task 2); `loadExpectations` (Task 3); `MonitorConfig` (Task 1); `SqlClient` from `@olurabian/receipt`; `VERSION` from `./version.js`.
- Produces: `MonitorAppState`, `MonitorAppEvent`, `StoredFlag`, `MonitorAppOverrides`, `MonitorApp` (`state()`, `tick()`, `flags(sinceN?)`, `events(sinceN?)`, `ready()`, `close()`), `createMonitorApp(cfg, overrides?)`, `READ_LIMIT`; test helpers `minted`, `executed`, `failed`, `seedDecisions`, `seedRaw`, `monitorCfg`, `fakeDeadlatch`.

- [ ] **Step 1: The fixture**

`test/helpers/monitor-fixture.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PostgresStore, makeReceipt, type SqlClient } from "@olurabian/receipt";
import type { DecisionPayload } from "@olurabian/purse";
import type { MonitorConfig } from "../../src/monitor-config.js";

export { clock } from "./witness-fixture.js";

const T0 = Date.UTC(2026, 8, 9, 0, 0, 0);
export const minute = (m: number) => new Date(T0 + m * 60_000).toISOString();

interface Opts { amount?: number; payee?: string; currency?: string }

export function minted(grantId: string, o: Opts = {}): DecisionPayload {
  return { request: { amount: { amount: o.amount ?? 1250, currency: o.currency ?? "USD" }, payee: o.payee ?? "api.stripe.com", intent: "credits" }, status: "allowed", reason: "within policy", policyVersion: "p1", event: "grant_minted", grantId };
}

export function executed(grantId: string, o: Opts & { paid?: number; paidCurrency?: string } = {}): DecisionPayload {
  const currency = o.currency ?? "USD";
  const paidAmount = o.paid === undefined ? undefined : { amount: o.paid, currency: o.paidCurrency ?? currency };
  return { request: { amount: { amount: o.amount ?? 1250, currency }, payee: o.payee ?? "api.stripe.com", intent: "credits" }, status: "allowed", reason: "executed", policyVersion: "p1", event: "executed", grantId, receipt: { ok: true, ref: "pi_1", paidAmount } };
}

export function failed(grantId: string, reason = "rejected: grant not found"): DecisionPayload {
  return { request: { amount: { amount: 0, currency: "USD" }, payee: "?" }, status: "denied", reason, policyVersion: "p1", event: "execution_failed", grantId };
}

/** Writes decisions through the broker's own store, one per minute from `startMinute`, seq assigned by the table. */
export async function seedDecisions(db: PGlite, stream: string, payloads: DecisionPayload[], startMinute = 0): Promise<void> {
  await seedRaw(db, stream, payloads.map((p) => ({ kind: "decision", payload: p })), startMinute);
}

/** Opens the broker's store once so the receipts table exists, for tests that start from an empty stream. */
export const ensureReceipts = (db: PGlite, stream: string): Promise<void> => seedRaw(db, stream, []);

export async function seedRaw(db: PGlite, stream: string, items: Array<{ kind: string; payload: unknown }>, startMinute = 0): Promise<void> {
  const store = await PostgresStore.open<unknown>(db as unknown as SqlClient, { stream });
  let i = 0;
  for (const it of items) {
    const n = startMinute + i++;
    makeReceipt(store, { kind: it.kind, payload: it.payload }, { now: () => minute(n), newId: () => `id-${stream}-${n}` });
  }
  await store.flush();
}

export function monitorCfg(over: Partial<MonitorConfig> = {}): MonitorConfig {
  const dir = mkdtempSync(join(tmpdir(), "purse-monitor-"));
  return {
    databaseUrl: "postgres://unused", stream: "t", table: "receipts",
    intervalMs: 60_000,
    window: { count: 500, ms: 24 * 60 * 60_000 },
    velocity: { count: 5, ms: 10 * 60_000 },
    disable: [], expectationsModule: undefined,
    deadlatch: { url: "https://deadlatch.test", projectKey: "dl_live_aaaaaaaabbbb" },
    flagsFile: join(dir, "flags.jsonl"),
    port: 0, bind: "127.0.0.1", otel: false,
    ...over,
  };
}

/** A scripted hosted side. Each path has its own queue of steps; an exhausted queue answers 202 for flags and 204 for heartbeats. */
export type Step = number | "network";
export function fakeDeadlatch(script: { flags?: Step[]; heartbeat?: Step[] } = {}) {
  const queues = { flags: [...(script.flags ?? [])], heartbeat: [...(script.heartbeat ?? [])] };
  const calls: { path: "flags" | "heartbeat"; headers: Record<string, string>; body: unknown }[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).endsWith("/api/v1/heartbeat") ? "heartbeat" : "flags";
    calls.push({ path, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: init?.body ? JSON.parse(String(init.body)) : null });
    const step = queues[path].shift() ?? (path === "flags" ? 202 : 204);
    if (step === "network") throw new TypeError("fetch failed");
    if (step === 204) return new Response(null, { status: 204 });
    const body = step === 202 ? JSON.stringify({ accepted: 1, duplicates: 0 }) : JSON.stringify({ error: `status ${step}` });
    return new Response(body, { status: step, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls, flagsCalls: () => calls.filter((c) => c.path === "flags"), heartbeats: () => calls.filter((c) => c.path === "heartbeat") };
}
```

- [ ] **Step 2: Failing tests**

`test/monitor-app.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { SqlClient } from "@olurabian/receipt";
import { createMonitorApp, READ_LIMIT } from "../src/monitor-app.js";
import { VERSION } from "../src/version.js";
import { clock, ensureReceipts, executed, fakeDeadlatch, minted, monitorCfg, seedDecisions, seedRaw, type Step } from "./helpers/monitor-fixture.js";

async function setup(script: { flags?: Step[]; heartbeat?: Step[] } = {}, over: Parameters<typeof monitorCfg>[0] = {}) {
  const db = new PGlite();
  await ensureReceipts(db, "t");
  const hosted = fakeDeadlatch(script);
  const c = clock("2026-09-09T01:00:00.000Z");
  const cfg = monitorCfg(over);
  const app = await createMonitorApp(cfg, { sqlClient: db as unknown as SqlClient, fetch: hosted.fetch, now: c.now });
  return { db, hosted, c, cfg, app };
}
const cursorRow = async (db: PGlite) => (await db.query<{ seq: string }>("SELECT seq FROM monitor_cursor WHERE stream = 't'")).rows[0]?.seq ?? null;

test("boot creates the tables, and an empty stream ticks green with no cursor row and one heartbeat", async () => {
  const { db, app, hosted } = await setup();
  await app.tick();
  const s = app.state();
  assert.equal(s.lastTickOk, true);
  assert.equal(s.cursor, null);
  assert.equal(await cursorRow(db), null);
  assert.deepEqual(app.ready(), { ok: true });
  assert.equal(hosted.heartbeats().length, 1);
  assert.deepEqual(hosted.heartbeats()[0]?.body, { version: VERSION, stream: "t", intervalMs: 60_000, cursor: null, lastFlagAt: null });
  for (const t of ["monitor_cursor", "monitor_flags", "monitor_events"]) {
    const { rows } = await db.query(`SELECT to_regclass('${t}') AS r`);
    assert.ok((rows[0] as { r: string | null }).r, t);
  }
  await app.close();
});

test("a clean stream advances the cursor, stores no flags, and pushes nothing", async () => {
  const { db, app, hosted } = await setup();
  await seedDecisions(db, "t", [minted("g1"), executed("g1", { paid: 1250 })]);
  await app.tick();
  assert.deepEqual(app.state().cursor, { seq: 2 });
  assert.equal(await cursorRow(db), "2");
  assert.deepEqual(await app.flags(), []);
  assert.equal(hosted.flagsCalls().length, 0);
  assert.deepEqual(hosted.heartbeats()[0]?.body, { version: VERSION, stream: "t", intervalMs: 60_000, cursor: { seq: 2 }, lastFlagAt: null });
  assert.equal(app.state().windowCount, 2);
  await app.close();
});

test("an execution with no minted grant is flagged, stored locally before the push, and pushed with the monitor block and the bearer key", async () => {
  const { db, app, hosted, c } = await setup();
  await seedDecisions(db, "t", [executed("g9")]);
  await app.tick();
  const stored = await app.flags();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.n, 1);
  assert.equal(stored[0]?.flag.expectation.id, "executed-without-grant");
  assert.equal(stored[0]?.flag.offender.ref.seq, 1);
  assert.deepEqual(stored[0]?.flag.cause, { amount: { amount: 1250, currency: "USD" }, payee: "api.stripe.com", intent: "credits" });
  const call = hosted.flagsCalls()[0];
  assert.equal(call?.headers["authorization"], "Bearer dl_live_aaaaaaaabbbb");
  const body = call?.body as { monitor: unknown; flags: Array<{ id: string }> };
  assert.deepEqual(body.monitor, { version: VERSION, stream: "t", intervalMs: 60_000 });
  assert.equal(body.flags[0]?.id, stored[0]?.flag.id);
  assert.equal(app.state().flags, 1);
  assert.equal(app.state().lastPushAt, c.now());
  assert.deepEqual(hosted.heartbeats()[0]?.body, { version: VERSION, stream: "t", intervalMs: 60_000, cursor: { seq: 1 }, lastFlagAt: c.now() });
  assert.deepEqual(app.ready(), { ok: true });
  await app.close();
});

test("a push failure keeps the cursor, records push-failed, turns readiness red, and the next tick delivers the same flag id once", async () => {
  const { db, app, hosted, c } = await setup({ flags: ["network"] });
  await seedDecisions(db, "t", [executed("g9")]);
  await app.tick();
  assert.equal(await cursorRow(db), null);
  assert.equal(app.state().lastPushOk, false);
  assert.equal(app.state().queued, 1);
  assert.deepEqual(app.ready(), { ok: false, reason: "last push failed, 1 flags queued, fetch failed" });
  const ev = await app.events();
  assert.equal(ev.length, 1);
  assert.equal(ev[0]?.kind, "push-failed");
  assert.match(ev[0]!.detail, /1 flags, fetch failed, 1 queued/);
  assert.equal((await app.flags()).length, 1);
  c.advance(60_000);
  await app.tick();
  assert.equal(await cursorRow(db), "1");
  assert.equal((await app.flags()).length, 1, "the local row is not duplicated");
  const calls = hosted.flagsCalls();
  assert.equal(calls.length, 2);
  assert.equal((calls[1]?.body as { flags: Array<{ id: string }> }).flags[0]?.id, (calls[0]?.body as { flags: Array<{ id: string }> }).flags[0]?.id);
  assert.deepEqual(app.ready(), { ok: true });
  assert.equal(app.state().lastError, null);
  await app.close();
});

test("no project key means the file sink, no HTTP at all, and a null key prefix", async () => {
  const { db, app, hosted, cfg } = await setup({}, { deadlatch: { url: "https://deadlatch.test", projectKey: undefined } });
  await seedDecisions(db, "t", [executed("g9")]);
  await app.tick();
  assert.equal(hosted.calls.length, 0);
  assert.equal(app.state().sink, "file");
  assert.equal(app.state().keyPrefix, null);
  assert.ok(existsSync(cfg.flagsFile));
  const lines = readFileSync(cfg.flagsFile, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal((JSON.parse(lines[0]!) as { expectation: { id: string } }).expectation.id, "executed-without-grant");
  assert.equal((await app.flags()).length, 1);
  assert.deepEqual(app.ready(), { ok: true });
  await app.close();
});

test("the key prefix is the first eight characters after dl_live_", async () => {
  const { app } = await setup({}, { deadlatch: { url: "https://deadlatch.test", projectKey: "dl_live_aaaabbbbccccdddd" } });
  assert.equal(app.state().keyPrefix, "aaaabbbb");
  assert.equal(app.state().sink, "deadlatch");
  await app.close();
});

test("a receipt of another kind and a record that does not parse are skipped with events, and the cursor still advances", async () => {
  const { db, app } = await setup();
  await seedRaw(db, "t", [{ kind: "note", payload: { x: 1 } }, { kind: "decision", payload: minted("g1") }]);
  await db.query("UPDATE receipts SET record = '{not json' WHERE seq = 2");
  await app.tick();
  assert.deepEqual(app.state().cursor, { seq: 2 });
  const ev = await app.events();
  assert.deepEqual(ev.map((e) => [e.kind, e.detail]), [["skipped", "seq 1 unsupported kind note"], ["skipped", "seq 2 record does not parse"]]);
  await app.close();
});

test("a decision the mapper rejects is skipped with the mapper's message", async () => {
  const { db, app } = await setup();
  await seedRaw(db, "t", [{ kind: "decision", payload: { status: "allowed" } }]);
  await app.tick();
  const ev = await app.events();
  assert.deepEqual(ev.map((e) => e.detail), ["seq 1 decision payload without a request"]);
  assert.deepEqual(app.state().cursor, { seq: 1 });
  await app.close();
});

test("the source reads at most READ_LIMIT receipts per tick", async () => {
  const { db, app } = await setup();
  const payloads = Array.from({ length: READ_LIMIT + 1 }, (_, i) => minted(`g${i}`));
  await seedDecisions(db, "t", payloads);
  await app.tick();
  assert.deepEqual(app.state().cursor, { seq: READ_LIMIT });
  await app.tick();
  assert.deepEqual(app.state().cursor, { seq: READ_LIMIT + 1 });
  await app.close();
});

test("a source failure marks the tick failed with the error, readiness red, and the next tick recovers", async () => {
  const db = new PGlite();
  await ensureReceipts(db, "t");
  let failNext = true;
  const sql: SqlClient = {
    query: async (text: string, params?: unknown[]) => {
      if (failNext && /FROM receipts/.test(text)) { failNext = false; throw new Error("db unreachable"); }
      return db.query(text, params as never) as never;
    },
  } as unknown as SqlClient;
  const hosted = fakeDeadlatch();
  const c = clock("2026-09-09T01:00:00.000Z");
  const app = await createMonitorApp(monitorCfg(), { sqlClient: sql, fetch: hosted.fetch, now: c.now });
  await app.tick();
  assert.equal(app.state().lastTickOk, false);
  assert.equal(app.state().lastError, "db unreachable");
  assert.deepEqual(app.ready(), { ok: false, reason: "db unreachable" });
  assert.deepEqual((await app.events()).map((e) => [e.kind, e.detail]), [["error", "db unreachable"]]);
  await app.tick();
  assert.equal(app.state().lastTickOk, true);
  assert.equal(app.state().lastError, null);
  assert.deepEqual(app.ready(), { ok: true });
  await app.close();
});

test("readiness is red before the first tick and after three intervals without one", async () => {
  const { app, c } = await setup();
  assert.deepEqual(app.ready(), { ok: false, reason: "no tick yet" });
  await app.tick();
  assert.deepEqual(app.ready(), { ok: true });
  c.advance(3 * 60_000 + 1);
  assert.deepEqual(app.ready(), { ok: false, reason: "last tick is stale" });
  await app.close();
});

test("an unknown or revoked key stops the monitor with an error event, and later ticks push nothing", async () => {
  const { db, app, hosted } = await setup({ flags: [403] });
  await seedDecisions(db, "t", [executed("g9")]);
  await app.tick();
  const ev = await app.events();
  assert.equal(ev[0]?.kind, "error");
  assert.match(ev[0]!.detail, /revoked.*403.*stopping/);
  assert.equal(app.ready().ok, false);
  await seedDecisions(db, "t", [executed("g10")], 10);
  await app.tick();
  assert.equal(hosted.flagsCalls().length, 1);
  await app.close();
});

test("a custom expectation from a module flags alongside the built-ins", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "purse-monitor-custom-")), "exp.mjs");
  writeFileSync(file, `export default [{ id: "small-only", reason: "Over 1000.", where: { action: "executed" }, must: (r) => r.input.amount.amount <= 1000 }];\n`);
  const { db, app } = await setup({}, { expectationsModule: file });
  await seedDecisions(db, "t", [minted("g1"), executed("g1", { paid: 1250 })]);
  await app.tick();
  assert.deepEqual((await app.flags()).map((f) => f.flag.expectation.id), ["small-only"]);
  await app.close();
});
```

- [ ] **Step 3: Run to see them fail**

Run: `npx tsx --test test/monitor-app.test.ts`
Expected: FAIL, cannot find `../src/monitor-app.js`.

- [ ] **Step 4: monitor-app.ts**

`src/monitor-app.ts`:

```ts
import pg from "pg";
import type { SqlClient } from "@olurabian/receipt";
import type { Expectation } from "@olurabian/tripwire";
import {
  createMonitor, deadlatchSink, fileSink, fromReceipts,
  type Cursor, type CursorStore, type Flag, type Monitor, type MonitorEvent, type ReceiptLike, type Sink, type Skipped, type Source,
} from "@olurabian/tripwire/monitor";
import { metrics, trace } from "@opentelemetry/api";
import type { MonitorConfig } from "./monitor-config.js";
import { purseRecord } from "./purse-records.js";
import { loadExpectations } from "./purse-expectations.js";
import { VERSION } from "./version.js";

export interface MonitorAppEvent { n: number; stream: string; at: string; kind: string; detail: string }
export interface StoredFlag { n: number; flag: Flag }
export interface MonitorAppState {
  stream: string;
  version: string;
  intervalMs: number;
  window: { count: number; ms: number };
  sink: "deadlatch" | "file";
  /** The first eight characters of the project key after dl_live_, or null without a key. */
  keyPrefix: string | null;
  cursor: Cursor | null;
  ticks: number;
  lastTickAt: string | null;
  lastTickOk: boolean;
  lastPushOk: boolean;
  lastPushAt: string | null;
  lastError: string | null;
  queued: number;
  flags: number;
  windowCount: number;
}
export interface MonitorAppOverrides { sqlClient?: SqlClient; fetch?: typeof fetch; now?: () => string; expectations?: Expectation[] }
export interface MonitorApp {
  state(): MonitorAppState;
  tick(): Promise<void>;
  flags(sinceN?: number): Promise<StoredFlag[]>;
  events(sinceN?: number): Promise<MonitorAppEvent[]>;
  ready(): { ok: boolean; reason?: string };
  close(): Promise<void>;
}

/** Receipts read per tick. Bounds the engine's pending list while the hosted side is down. */
export const READ_LIMIT = 500;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS monitor_cursor (stream TEXT PRIMARY KEY, seq BIGINT NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS monitor_flags (n BIGSERIAL PRIMARY KEY, id TEXT NOT NULL UNIQUE, stream TEXT NOT NULL, at TIMESTAMPTZ NOT NULL, flag TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS monitor_events (n BIGSERIAL PRIMARY KEY, stream TEXT NOT NULL, at TIMESTAMPTZ NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL)`,
];

export async function createMonitorApp(cfg: MonitorConfig, overrides: MonitorAppOverrides = {}): Promise<MonitorApp> {
  const pool = overrides.sqlClient ? null : new pg.Pool({ connectionString: cfg.databaseUrl });
  const sql: SqlClient = overrides.sqlClient ?? (pool as unknown as SqlClient);
  const now = overrides.now ?? (() => new Date().toISOString());
  for (const statement of SCHEMA) await sql.query(statement);
  const expectations = overrides.expectations ?? (await loadExpectations(cfg));

  const tracer = trace.getTracer("purse-monitor");
  const meter = metrics.getMeter("purse-monitor");
  const flagCounter = meter.createCounter("deadlatch.watch.flag");
  const pushFailedCounter = meter.createCounter("deadlatch.watch.push.failed");

  const st = { ticks: 0, lastError: null as string | null };

  // Events are remembered during a tick and written after it, so the engine's synchronous listener never touches the database.
  const remembered: Array<{ kind: string; detail: string }> = [];
  const remember = (kind: string, detail: string): void => { remembered.push({ kind, detail }); };
  async function flushEvents(): Promise<void> {
    for (const e of remembered.splice(0)) {
      await sql.query("INSERT INTO monitor_events (stream, at, kind, detail) VALUES ($1, $2, $3, $4)", [cfg.stream, now(), e.kind, e.detail]);
    }
  }
  const onEvent = (e: MonitorEvent): void => {
    switch (e.kind) {
      case "tick": st.lastError = null; return;
      case "skipped": remember(e.kind, `seq ${e.ref.seq ?? "?"} ${e.reason}`); return;
      case "push-failed":
        pushFailedCounter.add(1, { stream: cfg.stream });
        st.lastError = e.error;
        remember(e.kind, `${e.flags} flags, ${e.error}, ${e.queued} queued`);
        return;
      case "push-rejected": remember(e.kind, `${e.flags} flags rejected with ${e.status}${e.error ? `, ${e.error.slice(0, 200)}` : ""}`); return;
      case "dropped": remember(e.kind, `${e.flags} flags dropped, ${e.queued} queued`); return;
      case "heartbeat-failed": remember(e.kind, e.error); return;
      case "error": st.lastError = e.error; remember(e.kind, e.error); return;
    }
  };

  const toRecords = fromReceipts<unknown>(cfg.stream, purseRecord);
  const source: Source = {
    async next(cursor) {
      const { rows } = await sql.query(`SELECT seq, record FROM ${cfg.table} WHERE stream = $1 AND seq > $2 ORDER BY seq LIMIT ${READ_LIMIT}`, [cfg.stream, cursor?.seq ?? 0]);
      const receipts: Array<ReceiptLike<unknown> & { seq: number }> = [];
      const unparsed: Skipped[] = [];
      for (const r of rows) {
        const seq = Number(r.seq);
        try {
          receipts.push({ seq, ...(JSON.parse(String(r.record)) as ReceiptLike<unknown>) });
        } catch {
          unparsed.push({ ref: { stream: cfg.stream, seq }, reason: "record does not parse" });
        }
      }
      const { records, skipped } = toRecords(receipts);
      const all = [...unparsed, ...skipped].sort((a, b) => (a.ref.seq ?? 0) - (b.ref.seq ?? 0));
      const last = rows[rows.length - 1];
      return { records, skipped: all, cursor: last ? { seq: Number(last.seq) } : cursor };
    },
  };

  const cursorStore: CursorStore = {
    async load() {
      const { rows } = await sql.query("SELECT seq FROM monitor_cursor WHERE stream = $1", [cfg.stream]);
      const r = rows[0];
      return r ? { seq: Number(r.seq) } : null;
    },
    async save(cursor) {
      await sql.query(
        "INSERT INTO monitor_cursor (stream, seq, updated_at) VALUES ($1, $2, $3) ON CONFLICT (stream) DO UPDATE SET seq = EXCLUDED.seq, updated_at = EXCLUDED.updated_at",
        [cfg.stream, cursor.seq, now()],
      );
    },
  };

  const key = cfg.deadlatch.projectKey;
  const keyPrefix = key ? key.replace(/^dl_live_/, "").slice(0, 8) : null;
  const inner: Sink = key
    ? deadlatchSink({ url: cfg.deadlatch.url, projectKey: key, monitor: { version: VERSION, stream: cfg.stream, intervalMs: cfg.intervalMs }, fetch: overrides.fetch, now: () => new Date(now()), onEvent })
    : fileSink(cfg.flagsFile);
  /**
   * Every flag is stored beside the receipts before the push, keyed on its id, so the local record exists when
   * the hosted side is down. The wrapper passes the hosted sink's heartbeat through and hides its own queue, so the
   * engine's `queued` counts exactly the flags the monitor holds.
   */
  const heartbeat = (inner as { heartbeat?: unknown }).heartbeat;
  const sink: Sink & { heartbeat?: unknown } = {
    ...(heartbeat ? { heartbeat } : {}),
    async push(flags: Flag[]) {
      for (const f of flags) {
        const { rows } = await sql.query("INSERT INTO monitor_flags (id, stream, at, flag) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING RETURNING id", [f.id, cfg.stream, f.at, JSON.stringify(f)]);
        if (rows.length > 0) flagCounter.add(1, { stream: cfg.stream, expectation: f.expectation.id });
      }
      await inner.push(flags);
    },
  };

  const monitor: Monitor = createMonitor({ source, expectations, sink, cursorStore, window: cfg.window, intervalMs: cfg.intervalMs, now: () => new Date(now()), onEvent });
  meter.createObservableGauge("deadlatch.watch.queued").addCallback((r) => r.observe(monitor.state().queued, { stream: cfg.stream }));

  async function tick(): Promise<void> {
    st.ticks++;
    await tracer.startActiveSpan("deadlatch.watch.tick", async (span) => {
      try { await monitor.tick(); } finally { span.end(); }
    });
    try { await flushEvents(); } catch (e) { st.lastError = (e as Error).message; }
  }

  function ready(): { ok: boolean; reason?: string } {
    const s = monitor.state();
    if (!s.lastTickAt) return { ok: false, reason: "no tick yet" };
    if (Date.parse(now()) - Date.parse(s.lastTickAt) > 3 * cfg.intervalMs) return { ok: false, reason: "last tick is stale" };
    if (!s.lastTickOk) return { ok: false, reason: st.lastError ?? "last tick failed" };
    if (!s.lastPushOk) return { ok: false, reason: `last push failed, ${s.queued} flags queued${st.lastError ? `, ${st.lastError}` : ""}` };
    return { ok: true };
  }

  return {
    state: () => {
      const s = monitor.state();
      return {
        stream: cfg.stream, version: VERSION, intervalMs: cfg.intervalMs, window: { ...cfg.window },
        sink: key ? "deadlatch" : "file", keyPrefix,
        cursor: s.cursor, ticks: st.ticks,
        lastTickAt: s.lastTickAt, lastTickOk: s.lastTickOk, lastPushOk: s.lastPushOk, lastPushAt: s.lastPushAt,
        lastError: st.lastError, queued: s.queued, flags: s.flags, windowCount: s.window.count,
      };
    },
    tick,
    async flags(sinceN = 0) {
      const { rows } = await sql.query("SELECT n, flag FROM monitor_flags WHERE stream = $1 AND n > $2 ORDER BY n LIMIT 1000", [cfg.stream, sinceN]);
      return rows.map((r) => ({ n: Number(r.n), flag: JSON.parse(String(r.flag)) as Flag }));
    },
    async events(sinceN = 0) {
      const { rows } = await sql.query("SELECT n, stream, at, kind, detail FROM monitor_events WHERE stream = $1 AND n > $2 ORDER BY n LIMIT 1000", [cfg.stream, sinceN]);
      return rows.map((r) => ({ n: Number(r.n), stream: String(r.stream), at: new Date(String(r.at)).toISOString(), kind: String(r.kind), detail: String(r.detail) }));
    },
    ready,
    async close() { monitor.stop(); if (pool) await pool.end(); },
  };
}
```

Two things to know while transcribing. The engine's `push-failed` event carries the sink's message, and the app's `ready()` reason for a failed push is built from `queued` and `lastError`, which the tests pin as `last push failed, 1 flags queued, fetch failed`. The `tick` event clears `lastError`, which is what makes the recovery assertions pass.

- [ ] **Step 5: Run the tests, then everything, commit**

Run: `npx tsx --test test/monitor-app.test.ts`
Expected: PASS, 13 tests. The READ_LIMIT test seeds 501 receipts through the real store and takes a few seconds.

Run: `npm run build && npm run typecheck && npm test`
Expected: all green.

```bash
git add deploy/broker/src/monitor-app.ts deploy/broker/test/helpers/monitor-fixture.ts deploy/broker/test/monitor-app.test.ts
git commit -m "monitor: the app on Postgres, source, cursor, recording sink, events, readiness, telemetry

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The read-only port and the entry

**Files:**
- Create: `deploy/broker/src/monitor-server.ts`, `deploy/broker/src/monitor.ts`
- Modify: `deploy/broker/src/http.ts` (one helper)
- Test: `deploy/broker/test/monitor-server.test.ts`

**Interfaces:**
- Consumes: `MonitorApp` (Task 4), `MonitorConfig` (Task 1), `send` and the new `sinceParam` from `./http.js`, `listen` from `./agent-server.js`, `startOtel` from `./otel.js`, `VERSION`.
- Produces: `createMonitorServer(app, cfg): Server`; `sinceParam(v: string | null): number | null`; the `node dist/monitor.js` entry.

- [ ] **Step 1: Failing tests**

`test/monitor-server.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import type { SqlClient } from "@olurabian/receipt";
import { createMonitorApp } from "../src/monitor-app.js";
import { createMonitorServer } from "../src/monitor-server.js";
import { listen } from "../src/agent-server.js";
import { sinceParam } from "../src/http.js";
import { VERSION } from "../src/version.js";
import { clock, ensureReceipts, executed, fakeDeadlatch, monitorCfg, seedDecisions } from "./helpers/monitor-fixture.js";

async function up() {
  const db = new PGlite();
  await ensureReceipts(db, "t");
  const hosted = fakeDeadlatch();
  const c = clock("2026-09-09T01:00:00.000Z");
  const cfg = monitorCfg();
  const app = await createMonitorApp(cfg, { sqlClient: db as unknown as SqlClient, fetch: hosted.fetch, now: c.now });
  const srv = await listen(createMonitorServer(app, cfg), 0, "127.0.0.1");
  const get = async (path: string) => { const r = await fetch(srv.url + path); return { status: r.status, body: (await r.json()) as Record<string, unknown> }; };
  return { db, app, srv, get, close: async () => { await srv.close(); await app.close(); } };
}

test("sinceParam", () => {
  assert.equal(sinceParam(null), -1);
  assert.equal(sinceParam(""), -1);
  assert.equal(sinceParam("0"), 0);
  assert.equal(sinceParam("42"), 42);
  assert.equal(sinceParam("-1"), -1);
  assert.equal(sinceParam("-2"), null);
  assert.equal(sinceParam("abc"), null);
  assert.equal(sinceParam("1.5"), null);
  assert.equal(sinceParam("99999999999999999999"), null);
});

test("GET / describes the monitor without the key, and readiness follows the ticks", async () => {
  const { app, get, close } = await up();
  const before = await get("/readyz");
  assert.equal(before.status, 503);
  assert.deepEqual(before.body, { ok: false, reason: "no tick yet" });
  await app.tick();
  const root = await get("/");
  assert.equal(root.status, 200);
  assert.equal(root.body.service, "purse-monitor");
  assert.equal(root.body.version, VERSION);
  assert.equal(root.body.stream, "t");
  assert.equal(root.body.sink, "deadlatch");
  assert.equal(root.body.keyPrefix, "aaaaaaaa");
  assert.equal(root.body.dashboard, "https://deadlatch.test/app");
  assert.deepEqual(root.body.window, { count: 500, ms: 86_400_000 });
  assert.equal(root.body.intervalMs, 60_000);
  assert.equal(JSON.stringify(root.body).includes("dl_live_"), false, "the key never appears");
  assert.ok(typeof root.body.routes === "object");
  assert.deepEqual(await get("/readyz"), { status: 200, body: { ok: true } });
  assert.deepEqual(await get("/healthz"), { status: 200, body: { ok: true } });
  await close();
});

test("GET /flags and /events serve what the app stored, validate since, and page from n", async () => {
  const { db, app, get, close } = await up();
  await seedDecisions(db, "t", [executed("g9")]);
  await app.tick();
  const flags = await get("/flags");
  assert.equal(flags.status, 200);
  assert.equal(flags.body.stream, "t");
  const list = flags.body.flags as Array<{ n: number; flag: { expectation: { id: string } } }>;
  assert.equal(list.length, 1);
  assert.equal(list[0]?.n, 1);
  assert.equal(list[0]?.flag.expectation.id, "executed-without-grant");
  assert.deepEqual((await get("/flags?since=1")).body.flags, []);
  assert.equal((await get("/flags?since=x")).status, 400);
  assert.equal((await get("/events?since=99999999999999999999")).status, 400);
  const events = await get("/events");
  assert.equal(events.status, 200);
  assert.deepEqual(events.body.events, []);
  await close();
});

test("anything else is 404, and so is any non-GET", async () => {
  const { srv, get, close } = await up();
  assert.equal((await get("/nope")).status, 404);
  const post = await fetch(srv.url + "/flags", { method: "POST" });
  assert.equal(post.status, 404);
  await close();
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx tsx --test test/monitor-server.test.ts`
Expected: FAIL, cannot find `../src/monitor-server.js` (and `sinceParam` is not exported).

- [ ] **Step 3: The helper, the server, the entry**

Append to `src/http.ts`:

```ts
/** A `since` query value. -1 when absent, the integer when it is a non-negative safe integer (or -1), null otherwise. */
export function sinceParam(v: string | null): number | null {
  if (v == null || v === "") return -1;
  const n = Number(v);
  return Number.isInteger(n) && n >= -1 && n <= Number.MAX_SAFE_INTEGER ? n : null;
}
```

`src/monitor-server.ts`:

```ts
import { createServer, type Server } from "node:http";
import { send, sinceParam } from "./http.js";
import type { MonitorApp } from "./monitor-app.js";
import type { MonitorConfig } from "./monitor-config.js";

/** Read-only, no token. The key never appears here, only its prefix. Nothing on this port can change anything. */
export function createMonitorServer(app: MonitorApp, cfg: MonitorConfig): Server {
  const index = () => {
    const s = app.state();
    return {
      service: "purse-monitor",
      version: s.version,
      what: "Reads new receipts on a schedule, judges each one once against a sliding window with deterministic expectations, stores every flag beside the receipts, and pushes only the flags to a Deadlatch project or a local file.",
      stream: s.stream,
      sink: s.sink,
      keyPrefix: s.keyPrefix,
      dashboard: s.keyPrefix ? `${cfg.deadlatch.url}/app` : null,
      flagsFile: s.sink === "file" ? cfg.flagsFile : null,
      cursor: s.cursor,
      window: s.window,
      windowCount: s.windowCount,
      intervalMs: s.intervalMs,
      ticks: s.ticks,
      lastTickAt: s.lastTickAt,
      lastTickOk: s.lastTickOk,
      lastPushAt: s.lastPushAt,
      lastPushOk: s.lastPushOk,
      queued: s.queued,
      flags: s.flags,
      routes: {
        "GET /flags?since=<n>": "flags this monitor stored, oldest first, at most one thousand",
        "GET /events?since=<n>": "skipped, push-failed, push-rejected, dropped, heartbeat-failed, error",
        "GET /healthz": "liveness",
        "GET /readyz": "200 only when the last tick succeeded within three intervals and the last push succeeded or had nothing to push",
      },
    };
  };
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://monitor");
      if (req.method !== "GET") return send(res, 404, { error: "not found" });
      switch (url.pathname) {
        case "/": return send(res, 200, index());
        case "/healthz": return send(res, 200, { ok: true });
        case "/readyz": { const r = app.ready(); return send(res, r.ok ? 200 : 503, r); }
        case "/flags": {
          const since = sinceParam(url.searchParams.get("since"));
          if (since === null) return send(res, 400, { error: "since must be a non-negative integer" });
          return send(res, 200, { stream: cfg.stream, flags: await app.flags(Math.max(0, since)) });
        }
        case "/events": {
          const since = sinceParam(url.searchParams.get("since"));
          if (since === null) return send(res, 400, { error: "since must be a non-negative integer" });
          return send(res, 200, { stream: cfg.stream, events: await app.events(Math.max(0, since)) });
        }
        default: return send(res, 404, { error: "not found" });
      }
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: (e as Error).message });
    }
  });
}
```

`src/monitor.ts`:

```ts
import { loadMonitorConfig, MonitorConfigError } from "./monitor-config.js";
import { createMonitorApp } from "./monitor-app.js";
import { createMonitorServer } from "./monitor-server.js";
import { listen } from "./agent-server.js";
import { startOtel } from "./otel.js";

try {
  const cfg = loadMonitorConfig();
  const stopOtel = cfg.otel ? startOtel("purse-monitor") : null;
  const app = await createMonitorApp(cfg);
  const server = await listen(createMonitorServer(app, cfg), cfg.port, cfg.bind);
  const s0 = app.state();
  const where = s0.sink === "deadlatch" ? `${cfg.deadlatch.url} (key ${s0.keyPrefix}…)` : cfg.flagsFile;
  console.log(`purse-monitor up. ${server.url} (flags, events, readyz) | stream ${cfg.stream} | window ${cfg.window.count} receipts or ${cfg.window.ms} ms | every ${cfg.intervalMs} ms | flags to ${where}`);
  const run = async () => {
    await app.tick();
    const s = app.state();
    if (!s.lastTickOk) console.error(`purse-monitor: tick failed, ${s.lastError}`);
    else if (!s.lastPushOk) console.error(`purse-monitor: push failed, ${s.queued} flags held, ${s.lastError}`);
  };
  await run();
  const timer = setInterval(() => { void run(); }, cfg.intervalMs);
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`purse-monitor: ${signal}, stopping`);
    clearInterval(timer);
    try {
      await server.close();
      await app.close();
      if (stopOtel) await stopOtel();
      process.exit(0);
    } catch (e) {
      console.error(`purse-monitor: shutdown error: ${(e as Error).message}`);
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
} catch (e) {
  console.error(e instanceof MonitorConfigError ? e.message : `purse-monitor failed to start: ${(e as Error).message}`);
  process.exit(1);
}
```

- [ ] **Step 4: Run the tests, then everything, then a boot smoke, commit**

Run: `npx tsx --test test/monitor-server.test.ts`
Expected: PASS, 4 tests.

Run: `npm run build && npm run typecheck && npm test`
Expected: all green.

Boot smoke, config error path only (no database):

```bash
node dist/monitor.js; echo "exit $?"
```

Expected: `purse-monitor config: DATABASE_URL is required` and `exit 1`.

```bash
git add deploy/broker/src/http.ts deploy/broker/src/monitor-server.ts deploy/broker/src/monitor.ts deploy/broker/test/monitor-server.test.ts
git commit -m "monitor: the read-only port and the entry

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Compose, Dockerfile, Fly, README, and the spec write-back

**Files:**
- Modify: `deploy/broker/compose.yaml`, `deploy/broker/Dockerfile`, `deploy/broker/fly.toml`, `deploy/broker/README.md`
- Modify: `../../../tripwire/docs/superpowers/specs/2026-09-09-live-monitor-design.md` (the tripwire repository, commit there on the `master` branch's working copy is not allowed, so make the edit on a branch named `spec-monitor-process` in that repository and commit it there; it lands through that repository's protected flow in the release task)

**Interfaces:**
- Consumes: everything shipped in Tasks 1 to 5.

- [ ] **Step 1: compose.yaml**

After the `witness:` service and before `volumes:`, add:

```yaml
  monitor:
    build: .
    command: ["node", "dist/monitor.js"]
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://purse:purse@postgres:5432/purse
      MONITOR_STREAM: ${PURSE_STREAM:-purse}
      MONITOR_INTERVAL_MS: ${MONITOR_INTERVAL_MS:-60000}
      MONITOR_WINDOW: ${MONITOR_WINDOW:-500/24h}
      MONITOR_VELOCITY: ${MONITOR_VELOCITY:-5/10m}
      DEADLATCH_URL: ${DEADLATCH_URL:-https://www.deadlatch.dev}
      DEADLATCH_PROJECT_KEY: ${DEADLATCH_PROJECT_KEY:-}
      MONITOR_FLAGS_FILE: /data/flags.jsonl
      OTEL_EXPORTER_OTLP_ENDPOINT: ${OTEL_EXPORTER_OTLP_ENDPOINT:-}
      OTEL_EXPORTER_OTLP_HEADERS: ${OTEL_EXPORTER_OTLP_HEADERS:-}
    volumes:
      - monitor-data:/data
    ports:
      - "127.0.0.1:8083:8083"
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:${MONITOR_PORT:-8083}/healthz || exit 1"]
      interval: 30s
      timeout: 3s
      start_period: 10s
```

and under `volumes:` add `  monitor-data: {}`.

Validate both ways, from `deploy/broker`:

```bash
PURSE_ADMIN_TOKEN=abcdefghijklmnopqrstuvwxyz docker compose config >/dev/null && echo "compose ok without key"
PURSE_ADMIN_TOKEN=abcdefghijklmnopqrstuvwxyz DEADLATCH_PROJECT_KEY=dl_live_x docker compose config | grep -c "DEADLATCH_PROJECT_KEY: dl_live_x"
```

Expected: `compose ok without key` and `1`.

- [ ] **Step 2: Dockerfile**

Change `EXPOSE 8080 8081 8082` to `EXPOSE 8080 8081 8082 8083`.

- [ ] **Step 3: fly.toml**

Under `[processes]` add `  monitor = "node dist/monitor.js"`. Under `[env]` add:

```toml
  MONITOR_STREAM = "purse"
  MONITOR_PORT = "8083"
  DEADLATCH_URL = "https://www.deadlatch.dev"
```

Change the comment line that begins `# One witness per stream` to `# One witness per stream for the same reason, on its own process group. The monitor is the third group, and one per stream too, since its cursor is keyed on the stream.`

Change the secrets comment so it reads:

```toml
# Secrets, set once: fly secrets set DATABASE_URL=... PURSE_ADMIN_TOKEN=... WITNESS_KEY_PEM="$(node dist/witness.js keygen)" REKOR_LOG_KEY=... DEADLATCH_PROJECT_KEY=... OTEL_EXPORTER_OTLP_ENDPOINT=... OTEL_EXPORTER_OTLP_HEADERS=...
# Fly secrets are app-wide, so every machine receives WITNESS_KEY_PEM and DEADLATCH_PROJECT_KEY even though only one process reads each; run a process as its own Fly app with the same image and command to keep a secret off the others.
# Without DEADLATCH_PROJECT_KEY the monitor still runs and writes flags to its own machine and to the monitor_flags table. Set the key when the project exists and Fly restarts the machines.
```

Change the comment `# Agent port is public, on the app process only. The admin port and the witness port are not exposed; reach them with \`flyctl machine exec\`.` to end with `The admin, witness and monitor ports are not exposed; reach them with \`flyctl machine exec\`.`

- [ ] **Step 4: README**

In the Configuration table, after the `WITNESS_BIND` row, add:

```markdown
| `MONITOR_STREAM` | `PURSE_STREAM` or `purse` | The stream the monitor reads. One monitor per stream. |
| `MONITOR_INTERVAL_MS` | `60000` | How often the monitor reads new receipts. |
| `MONITOR_WINDOW` | `500/24h` | The sliding window, `<count>/<duration>` with the duration in `m`, `h` or `d`. |
| `MONITOR_VELOCITY` | `5/10m` | The `payee-velocity` threshold, `<count>/<duration>`. |
| `MONITOR_DISABLE` | | Comma-separated built-in ids to switch off. |
| `MONITOR_EXPECTATIONS` | | Path to an ES module whose default export is an array of expectations. |
| `DEADLATCH_URL` | `https://www.deadlatch.dev` | Where flags and heartbeats go. |
| `DEADLATCH_PROJECT_KEY` | | The project key from the dashboard. Unset means flags go to the file instead. |
| `MONITOR_FLAGS_FILE` | `/data/flags.jsonl` | The local sink when no key is set. |
| `MONITOR_PORT` | `8083` | The monitor port, read-only, no token. |
| `MONITOR_BIND` | `0.0.0.0` | Bind address for the monitor port. |
```

After the "The witness" section and before "Where each port may be reached from", insert:

````markdown
## The monitor

The broker enforces what an agent may spend. The monitor watches what it did. It is a third process on the same image, `node dist/monitor.js`, that reads new receipts every minute, judges each one once against a sliding window with deterministic expectations, and pushes only the flags to a Deadlatch project, or to a local file when no project key is set. It never writes to the receipts table and never blocks an action.

Four expectations are built in, each defined only over fields the chain carries.

| id | fires when |
|---|---|
| `executed-without-grant` | an `executed` receipt names a grant the window never saw minted, or no grant at all |
| `executed-once` | two `executed` receipts in the window share a grant |
| `paid-matches-decision` | the rail settled a different amount or currency than the minted decision allowed |
| `payee-velocity` | the same payee was executed `MONITOR_VELOCITY` times or more inside its duration, default `5/10m` |

The window must be at least as long as a grant lives for the first one to mean anything. `MONITOR_WINDOW` defaults to `500/24h`, five hundred receipts or one day, whichever ends first. Switch a built-in off by naming it in `MONITOR_DISABLE`. Add your own by pointing `MONITOR_EXPECTATIONS` at an ES module whose default export is an array of expectations, the same shape `@olurabian/tripwire` scans with. An id that collides with a built-in is a boot error.

Three lines connect it to a Deadlatch project. The project's settings page prints them with the key filled in.

```sh
DEADLATCH_URL=https://www.deadlatch.dev
DEADLATCH_PROJECT_KEY=dl_live_...
MONITOR_STREAM=purse
```

Without a key the monitor still runs. Flags go to `MONITOR_FLAGS_FILE`, one JSON line each. With or without a key, every flag is written to the `monitor_flags` table beside the receipts before any push, and `GET /flags` on the monitor port serves them. The cursor lives in `monitor_cursor` and moves only after every held flag was confirmed, so a hosted outage delays flags and never loses them.

```sh
curl -s http://127.0.0.1:8083/            # what it watches, the key prefix, the cursor, the last tick and push
curl -s http://127.0.0.1:8083/flags       # every flag this monitor stored, oldest first
curl -s http://127.0.0.1:8083/readyz      # 200 when the last tick succeeded within three intervals and the last push succeeded or had nothing to push
```

`GET /events` names what went wrong, a skipped row, a failed or rejected push, a revoked key. A revoked or unknown key stops the monitor; fix the key and restart it.

Limits. The monitor reads at most five hundred receipts per tick, so a stream that grows faster than that per interval falls behind and readiness says so. Judgment is per record against the window, a receipt the window has already seen is never judged again, and a rule that needs history older than the window cannot fire. The monitor is not part of proof. The witness is.
````

In "Where each port may be reached from", add a last bullet:

```markdown
- The monitor port is read-only like the witness port. It shows the first eight characters of the project key and nothing else secret. Same rule, your own boundary unless you mean to publish it.
```

In "Reference deployment on Fly", change both `ghcr.io/arabiananalyst/purse-broker:0.2.0` to `ghcr.io/arabiananalyst/purse-broker:0.3.0`, and after the paragraph that begins "Why `WITNESS_KEY_PEM` is a secret" add:

```markdown
The same deploy starts the monitor on its own machine. Until `DEADLATCH_PROJECT_KEY` is set it writes flags to its own machine and to the `monitor_flags` table, and `GET /flags` on port 8083 serves them. `flyctl secrets set DEADLATCH_PROJECT_KEY=... -a purse-broker` connects it to a project and Fly restarts the machines.
```

and after the witness machine exec example add:

```markdown
And the monitor port, on the monitor machine.

```bash
flyctl machine exec <monitor machine id> -a purse-broker "wget -qO- http://127.0.0.1:8083/"
```
```

Then run the prose sweep from `deploy/broker`. Every hit must be inside a code fence, a table row, inline code, or a URL:

```bash
grep -nE "^[^\`#|].*(:|—)" README.md | grep -v "https\?://"
```

- [ ] **Step 5: Spec write-back, in the tripwire repository**

In `/c/Users/ARABA/Workspace/SaaS/tripwire`, create a branch `spec-monitor-process` from `master` (`git checkout -b spec-monitor-process master`; never touch `master` itself) and edit `docs/superpowers/specs/2026-09-09-live-monitor-design.md`, Part 2:

1. Replace the sentence "The cursor lives in a `monitor_cursor` table (`stream text primary key, seq bigint, updated_at timestamptz`). Events live in `monitor_events` (`id bigserial, at timestamptz, kind text, detail text`), the same shape as `witness_events`." with "The cursor lives in a `monitor_cursor` table (`stream text primary key, seq bigint, updated_at timestamptz`). Flags live in `monitor_flags` (`n bigserial, id text unique, stream, at, flag text`), written before any push so a duplicate push cannot create a second row. Events live in `monitor_events` (`n bigserial, stream, at, kind, detail`), the same shape as `witness_events`."
2. Replace "`GET /flags?since=<n>` returns flags this process has produced, at most one thousand. Every flag is also written to `monitor_events` as kind `flag` with the flag JSON as `detail`, before the push, so the local record exists even when the hosted side is down." with "`GET /flags?since=<n>` returns the rows of `monitor_flags` after `n`, at most one thousand, so the local record exists and is pageable even when the hosted side is down."
3. After the sentence that begins "Any other kind maps to null" add "A row whose `record` column does not parse as JSON is skipped with reason `record does not parse`. The source reads at most 500 receipts per tick, which bounds the engine's pending list during an outage."
4. In the Configuration table, the `DEADLATCH_PROJECT_KEY` row's meaning gains ", and on Fly, where volumes are root-owned, the file lives on the machine's own disk and the `monitor_flags` table is the durable copy".

Commit on that branch with the trailer. Do not push. The release task lands it.

Run the same prose sweep on the spec:

```bash
grep -nE "^[^\`#|].*(:|—)" docs/superpowers/specs/2026-09-09-live-monitor-design.md | grep -v "https\?://"
```

- [ ] **Step 6: Build, typecheck, tests, commit (purse repository)**

Run from `deploy/broker`: `npm run build && npm run typecheck && npm test`
Expected: all green.

```bash
git add deploy/broker/compose.yaml deploy/broker/Dockerfile deploy/broker/fly.toml deploy/broker/README.md
git commit -m "monitor: compose service, image port, Fly process group, README

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Gate and release (runs only on ARABA's go)

**Files:**
- No source changes.

- [ ] **Step 1: Image gate**

From `deploy/broker`, build the image locally and run the monitor's config-error path inside it:

```bash
docker build -t purse-broker:monitor-gate . && docker run --rm purse-broker:monitor-gate node dist/monitor.js; echo "exit $?"
```

Expected: `purse-monitor config: DATABASE_URL is required`, exit 1. Then a full local run with compose in file-sink mode:

```bash
export PURSE_ADMIN_TOKEN=$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')
docker compose up -d --build postgres broker monitor
sleep 15
curl -s http://127.0.0.1:8083/ | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log(j.service,j.version,"sink",j.sink,"cursor",JSON.stringify(j.cursor))})'
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8083/readyz
docker compose down -v
```

Expected: `purse-monitor 0.3.0 sink file cursor null`, then `200`.

- [ ] **Step 2: Stop here until ARABA says go**

Report the gate result and the test count. Do not push, tag, publish, or deploy.

- [ ] **Step 3: On go, release the purse repository through the protected flow**

```bash
cd /c/Users/ARABA/Workspace/SaaS/purse
git push origin HEAD:release/monitor-0.3.0
# wait for the "test", "broker" and "gitleaks (secrets)" check runs on the pushed commit to succeed
gh api repos/ArabianAnalyst/purse/commits/$(git rev-parse HEAD)/check-runs --jq '[.check_runs[] | {name, conclusion}]'
git push origin HEAD:main
git push origin --delete release/monitor-0.3.0
git tag broker-v0.3.0 && git push origin broker-v0.3.0
# the image workflow builds and pushes ghcr.io/arabiananalyst/purse-broker:0.3.0 on the tag
gh run list --workflow image.yml --limit 1
```

Then the spec branch in the tripwire repository the same way (`release/spec-monitor-process`, checks `test` and `gitleaks (secrets)`, fast-forward `master`).

- [ ] **Step 4: Fly**

```bash
flyctl deploy --config deploy/broker/fly.toml -a purse-broker --image ghcr.io/arabiananalyst/purse-broker:0.3.0 --ha=false
flyctl machine list -a purse-broker
flyctl machine exec <monitor machine id> -a purse-broker "wget -qO- http://127.0.0.1:8083/"
flyctl machine exec <monitor machine id> -a purse-broker "wget -qO- http://127.0.0.1:8083/readyz"
```

Expected: a third machine in the `monitor` process group, version 0.3.0, sink `file`, readiness `{"ok":true}` after the first tick. `DEADLATCH_PROJECT_KEY` stays unset until Plan 3 ships the project. Record the machine id in the ledger.
