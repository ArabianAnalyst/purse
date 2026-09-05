# Broker Image Implementation Plan (plan 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Purse broker as a container a partner can run against Postgres in under an hour from the docs: both transports on an agent port, a token-protected admin port, a real EVM signer for x402, telemetry on by default, a Grafana dashboard, CI to GHCR, and a Fly configuration for the reference deployment.

**Architecture:** A small ESM app at `deploy/broker/` in the purse repo, built on the published `@olurabian/purse` 0.4, `@olurabian/receipt` 0.2, and `@olurabian/deadlatch-otel` 0.2. One Node process, two `node:http` servers. Config comes from env and fails loudly. Tests run the real app against embedded Postgres over real HTTP and a real MCP client.

**Tech Stack:** TypeScript strict, NodeNext ESM, Node 22, `node:test` via `tsx --test`, `pg`, `@modelcontextprotocol/sdk`, `zod` 3, `viem`, OpenTelemetry Node SDK with OTLP HTTP exporters, PGlite for tests, the `x402` v1 package as a dev-only conformance oracle.

**Spec:** `docs/superpowers/specs/2026-09-04-broker-image-design.md` (sections C to G)

## Global Constraints

- `deploy/broker` is private (never published to npm). Runtime dependencies are exactly those in Task 1; `x402` and PGlite are dev only. No `file:` links.
- Every env variable in spec section C is honoured; misconfiguration is a fatal, specific error at boot.
- The agent port carries no secret and no principal method. Every admin route except `/healthz` requires the bearer token, compared in constant time.
- Readiness is 200 only when the store opened, the chain verified at boot, `degraded()` is null, and `pending() < PURSE_MAX_PENDING`.
- The signer key is never logged, never returned by any route, and never written to disk by the app.
- Signer output matches the official x402 v1 client structurally, proven by the conformance test.
- All import specifiers end in `.js`. Every task ends with `npm run build && npm test` green in `deploy/broker` (and the purse root suite still green where touched).
- Public copy (deploy README, purse README) has no colons or em dashes inside prose sentences and names no counterparty. Never stage `docs/launch-x402.md`.
- No push, no tag, no image push before the release task, which runs only after ARABA confirms. Every commit ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## File structure (all under `deploy/broker/` unless noted)

- `package.json`, `package-lock.json`, `tsconfig.json`, `.npmrc`, `.gitignore`, `.dockerignore`
- `src/config.ts` (env → Config, validation), `src/store.ts` (Postgres or JSONL), `src/evm-signer.ts`, `src/executor.ts` (mock or x402), `src/otel.ts`, `src/mcp.ts`, `src/http.ts` (shared helpers), `src/agent-server.ts`, `src/admin-server.ts`, `src/app.ts`, `src/main.ts`
- `test/config.test.ts`, `test/evm-signer.test.ts`, `test/executor.test.ts`, `test/app.test.ts`
- `Dockerfile`, `compose.yaml`, `fly.toml`, `grafana/purse-broker.json`, `README.md`
- Repo root: `.github/workflows/image.yml` (new), `.github/workflows/ci.yml` (job added), `README.md` (pointer)

---

### Task 1: Scaffold and config

**Working directory:** `/c/Users/ARABA/Workspace/SaaS/purse`, branch `broker-image`.

- [ ] **Step 1: Scaffold**

Create `deploy/broker/package.json`:

```json
{
  "name": "purse-broker",
  "version": "0.1.0",
  "private": true,
  "description": "Purse enforcement mode as a container. Agent port with HTTP and MCP, token-protected admin port, Postgres receipts, telemetry on by default.",
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit && tsc -p tsconfig.test.json",
    "test": "tsx --test test/*.test.ts",
    "start": "node dist/main.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "@olurabian/deadlatch-otel": "^0.2.0",
    "@olurabian/purse": "^0.4.0",
    "@olurabian/receipt": "^0.2.0",
    "@opentelemetry/api": "^1.9.0",
    "@opentelemetry/exporter-metrics-otlp-http": "^0.200.0",
    "@opentelemetry/exporter-trace-otlp-http": "^0.200.0",
    "@opentelemetry/sdk-metrics": "^2.0.0",
    "@opentelemetry/sdk-node": "^0.200.0",
    "pg": "^8.13.0",
    "viem": "^2.21.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@electric-sql/pglite": "^0.5.8",
    "@lavamoat/allow-scripts": "^5.1.0",
    "@types/node": "^22.10.0",
    "@types/pg": "^8.11.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "x402": "^1.2.0"
  },
  "lavamoat": { "allowScripts": {} }
}
```

Create `deploy/broker/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": false,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

Create `deploy/broker/tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true, "rootDir": "." },
  "include": ["src", "test"]
}
```

Create `deploy/broker/.npmrc` with `ignore-scripts=true`, `deploy/broker/.gitignore` with `node_modules` and `dist`, and `deploy/broker/.dockerignore` with `node_modules`, `dist`, `test`, `*.log`, `.env*`.

Install from `deploy/broker`:

```bash
npm install --no-audit --no-fund
npx allow-scripts auto
npx allow-scripts
```

`allow-scripts auto` writes the allowlist of packages that have install scripts (expect `tsx>esbuild#<version>`, and possibly none from the runtime set); commit whatever it writes. If the OTel exporter versions in the block above do not resolve together, install the latest `@opentelemetry/sdk-node` and take the exporter versions it pins (`npm view @opentelemetry/sdk-node dependencies`), and record the versions in the report.

- [ ] **Step 2: Failing config tests**

Create `test/config.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, ConfigError } from "../src/config.js";

const TOKEN = "a".repeat(32);
const base = { PURSE_ADMIN_TOKEN: TOKEN, DATABASE_URL: "postgres://u:p@h/db" };
const KEY = "0x" + "1".repeat(64);

test("minimal valid env", () => {
  const c = loadConfig(base);
  assert.equal(c.store.kind, "postgres");
  assert.equal(c.store.kind === "postgres" && c.store.stream, "purse");
  assert.equal(c.executor.kind, "mock");
  assert.deepEqual(c.ports, { agent: 8080, admin: 8081, bind: "0.0.0.0" });
  assert.equal(c.maxPending, 100);
  assert.equal(c.policy.currency, "USD");
  assert.equal(c.otel, false);
});

test("policy and ports parse", () => {
  const c = loadConfig({ ...base, PURSE_MAX_PER_ACTION: "$5", PURSE_MAX_PER_DAY: "$200", PURSE_REQUIRE_APPROVAL_OVER: "$50", PURSE_ALLOW: "a.com, b.com", PURSE_DENY: "c.com", PURSE_GRANT_TTL_MS: "5000", PURSE_AGENT_PORT: "9000", PURSE_ADMIN_PORT: "9001", PURSE_BIND: "127.0.0.1", PURSE_MAX_PENDING: "7", OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel:4318" });
  assert.deepEqual(c.policy, { currency: "USD", maxPerAction: "$5", maxPerDay: "$200", requireApprovalOver: "$50", allow: ["a.com", "b.com"], deny: ["c.com"], grantTtlMs: 5000 });
  assert.deepEqual(c.ports, { agent: 9000, admin: 9001, bind: "127.0.0.1" });
  assert.equal(c.maxPending, 7);
  assert.equal(c.otel, true);
});

test("admin token is required and at least 24 characters", () => {
  assert.throws(() => loadConfig({ DATABASE_URL: "postgres://x" }), (e: unknown) => e instanceof ConfigError && /PURSE_ADMIN_TOKEN/.test(e.message));
  assert.throws(() => loadConfig({ ...base, PURSE_ADMIN_TOKEN: "short" }), /at least 24/);
});

test("database is required unless jsonl is requested explicitly", () => {
  assert.throws(() => loadConfig({ PURSE_ADMIN_TOKEN: TOKEN }), /DATABASE_URL/);
  const c = loadConfig({ PURSE_ADMIN_TOKEN: TOKEN, PURSE_STORE: "jsonl", PURSE_AUDIT_FILE: "./x.jsonl" });
  assert.deepEqual(c.store, { kind: "jsonl", file: "./x.jsonl" });
});

test("x402 config: resources, signer, key file wins, mainnet gate", () => {
  const resources = JSON.stringify({ vendor: "https://pay.example/resource" });
  assert.throws(() => loadConfig({ ...base, PURSE_EXECUTOR: "x402" }), /PURSE_X402_RESOURCES/);
  assert.throws(() => loadConfig({ ...base, PURSE_EXECUTOR: "x402", PURSE_X402_RESOURCES: "{bad" }), /PURSE_X402_RESOURCES/);
  assert.throws(() => loadConfig({ ...base, PURSE_EXECUTOR: "x402", PURSE_X402_RESOURCES: resources, PURSE_X402_SIGNER: "evm", PURSE_X402_NETWORK: "base-sepolia" }), /PURSE_X402_PRIVATE_KEY or PURSE_X402_KEY_FILE/);
  const env = { ...base, PURSE_EXECUTOR: "x402", PURSE_X402_RESOURCES: resources, PURSE_X402_SIGNER: "evm", PURSE_X402_NETWORK: "base-sepolia", PURSE_X402_PRIVATE_KEY: "0x" + "2".repeat(64), PURSE_X402_KEY_FILE: "/run/secrets/key" };
  const c = loadConfig(env, () => `${KEY}\n`);
  assert.equal(c.executor.kind, "x402");
  if (c.executor.kind === "x402") {
    assert.equal(c.executor.privateKey, KEY);
    assert.equal(c.executor.network, "base-sepolia");
    assert.deepEqual(c.executor.resources, { vendor: "https://pay.example/resource" });
  }
  assert.throws(() => loadConfig({ ...env, PURSE_X402_NETWORK: "base" }, () => KEY), /PURSE_X402_ALLOW_MAINNET/);
  assert.throws(() => loadConfig({ ...env, PURSE_X402_PRIVATE_KEY: "nothex", PURSE_X402_KEY_FILE: undefined }), /64 hex/);
  assert.throws(() => loadConfig({ ...env, PURSE_CURRENCY: "EUR" }, () => KEY), /USD/);
  const m = loadConfig({ ...base, PURSE_EXECUTOR: "x402", PURSE_X402_RESOURCES: resources, PURSE_X402_NETWORK: "mock" });
  assert.equal(m.executor.kind === "x402" && m.executor.signer, "mock");
  assert.throws(() => loadConfig({ ...base, PURSE_EXECUTOR: "x402", PURSE_X402_RESOURCES: resources, PURSE_X402_SIGNER: "evm", PURSE_X402_NETWORK: "mock", PURSE_X402_PRIVATE_KEY: KEY }), /mock network/);
});
```

Run: `npx tsx --test test/config.test.ts` → fails at import.

- [ ] **Step 3: Implement `src/config.ts`**

```ts
import { readFileSync } from "node:fs";

export class ConfigError extends Error {
  constructor(message: string) { super(`purse-broker config: ${message}`); this.name = "ConfigError"; }
}

export interface PolicyEnv {
  currency: string; maxPerAction?: string; maxPerDay?: string; requireApprovalOver?: string; allow?: string[]; deny?: string[]; grantTtlMs?: number;
}
export type StoreConfig = { kind: "postgres"; url: string; stream: string } | { kind: "jsonl"; file: string };
export type ExecutorConfig =
  | { kind: "mock" }
  | { kind: "x402"; resources: Record<string, string>; signer: "mock" | "evm"; network: string; privateKey?: `0x${string}`; allowMainnet: boolean };
export interface Config {
  policy: PolicyEnv; store: StoreConfig; ports: { agent: number; admin: number; bind: string };
  adminToken: string; executor: ExecutorConfig; maxPending: number; otel: boolean;
}

type Env = Record<string, string | undefined>;
const list = (v?: string) => v?.split(",").map((s) => s.trim()).filter(Boolean);
const int = (name: string, v: string | undefined, dflt: number): number => {
  if (v == null || v === "") return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`${name} must be a non-negative integer, got "${v}"`);
  return n;
};
const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;
export const REAL_NETWORKS = new Set(["base-sepolia", "base"]);

export function loadConfig(env: Env = process.env, readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): Config {
  const adminToken = env.PURSE_ADMIN_TOKEN;
  if (!adminToken) throw new ConfigError("PURSE_ADMIN_TOKEN is required (a random string of at least 24 characters)");
  if (adminToken.length < 24) throw new ConfigError("PURSE_ADMIN_TOKEN must be at least 24 characters");

  const currency = env.PURSE_CURRENCY ?? "USD";
  const policy: PolicyEnv = { currency };
  if (env.PURSE_MAX_PER_ACTION) policy.maxPerAction = env.PURSE_MAX_PER_ACTION;
  if (env.PURSE_MAX_PER_DAY) policy.maxPerDay = env.PURSE_MAX_PER_DAY;
  if (env.PURSE_REQUIRE_APPROVAL_OVER) policy.requireApprovalOver = env.PURSE_REQUIRE_APPROVAL_OVER;
  const allow = list(env.PURSE_ALLOW); if (allow?.length) policy.allow = allow;
  const deny = list(env.PURSE_DENY); if (deny?.length) policy.deny = deny;
  if (env.PURSE_GRANT_TTL_MS) policy.grantTtlMs = int("PURSE_GRANT_TTL_MS", env.PURSE_GRANT_TTL_MS, 0);

  let store: StoreConfig;
  if (env.PURSE_STORE === "jsonl") {
    store = { kind: "jsonl", file: env.PURSE_AUDIT_FILE ?? "./purse-audit.jsonl" };
  } else {
    if (!env.DATABASE_URL) throw new ConfigError("DATABASE_URL is required (set PURSE_STORE=jsonl only for development)");
    store = { kind: "postgres", url: env.DATABASE_URL, stream: env.PURSE_STREAM ?? "purse" };
  }

  const ports = { agent: int("PURSE_AGENT_PORT", env.PURSE_AGENT_PORT, 8080), admin: int("PURSE_ADMIN_PORT", env.PURSE_ADMIN_PORT, 8081), bind: env.PURSE_BIND ?? "0.0.0.0" };
  if (ports.agent === ports.admin) throw new ConfigError("PURSE_AGENT_PORT and PURSE_ADMIN_PORT must differ");

  let executor: ExecutorConfig = { kind: "mock" };
  const kind = env.PURSE_EXECUTOR ?? "mock";
  if (kind === "x402") {
    if (!env.PURSE_X402_RESOURCES) throw new ConfigError("PURSE_X402_RESOURCES is required for the x402 executor (JSON object of payee to resource URL)");
    let resources: Record<string, string>;
    try {
      const parsed = JSON.parse(env.PURSE_X402_RESOURCES) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      resources = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([k, v]) => {
        if (typeof v !== "string" || !/^https?:\/\//.test(v)) throw new Error(`resource for "${k}" must be an http(s) URL`);
        return [k, v];
      }));
    } catch (e) { throw new ConfigError(`PURSE_X402_RESOURCES is not a JSON object of payee to URL (${(e as Error).message})`); }
    const network = env.PURSE_X402_NETWORK ?? "base-sepolia";
    const signer = (env.PURSE_X402_SIGNER ?? (network === "mock" ? "mock" : "evm")) as "mock" | "evm";
    if (signer !== "mock" && signer !== "evm") throw new ConfigError(`PURSE_X402_SIGNER must be mock or evm, got "${signer}"`);
    if (network === "mock" && signer === "evm") throw new ConfigError("PURSE_X402_SIGNER=evm cannot be used with the mock network");
    if (signer === "evm" && !REAL_NETWORKS.has(network)) throw new ConfigError(`PURSE_X402_NETWORK must be base-sepolia or base for the evm signer, got "${network}"`);
    const allowMainnet = env.PURSE_X402_ALLOW_MAINNET === "1";
    if (network === "base" && !allowMainnet) throw new ConfigError("PURSE_X402_NETWORK=base moves real money; set PURSE_X402_ALLOW_MAINNET=1 to confirm");
    if (REAL_NETWORKS.has(network) && currency !== "USD") throw new ConfigError("PURSE_CURRENCY must be USD when settling USDC over x402");
    let privateKey: `0x${string}` | undefined;
    if (signer === "evm") {
      let raw = env.PURSE_X402_KEY_FILE ? readFile(env.PURSE_X402_KEY_FILE).trim() : env.PURSE_X402_PRIVATE_KEY?.trim();
      if (!raw) throw new ConfigError("the evm signer needs PURSE_X402_PRIVATE_KEY or PURSE_X402_KEY_FILE");
      if (!raw.startsWith("0x")) raw = `0x${raw}`;
      if (!HEX_KEY.test(raw)) throw new ConfigError("the signer key must be 64 hex characters, optionally 0x-prefixed");
      privateKey = raw as `0x${string}`;
    }
    executor = { kind: "x402", resources, signer, network, privateKey, allowMainnet };
  } else if (kind !== "mock") {
    throw new ConfigError(`PURSE_EXECUTOR must be mock or x402, got "${kind}"`);
  }

  return { policy, store, ports, adminToken, executor, maxPending: int("PURSE_MAX_PENDING", env.PURSE_MAX_PENDING, 100), otel: Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT) };
}
```

Run: `npx tsx --test test/config.test.ts` → 5 pass. Then `npm run build && npm run typecheck && npm test`.

- [ ] **Step 4: Commit**

```bash
cd /c/Users/ARABA/Workspace/SaaS/purse
git add deploy/broker/package.json deploy/broker/package-lock.json deploy/broker/tsconfig.json deploy/broker/tsconfig.test.json deploy/broker/.npmrc deploy/broker/.gitignore deploy/broker/.dockerignore deploy/broker/src/config.ts deploy/broker/test/config.test.ts
git commit -q -m "feat(broker): scaffold the broker image app and its config

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: EVM signer with a conformance test

- [ ] **Step 1: Failing test**

Create `test/evm-signer.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData, getAddress } from "viem";
import { createPaymentHeader } from "x402/client";
import { EvmSigner, AUTH_TYPES, CHAIN_IDS } from "../src/evm-signer.js";

const KEY = ("0x" + "7".repeat(64)) as `0x${string}`;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const reqs = {
  scheme: "exact", network: "base-sepolia", maxAmountRequired: "5000000", payTo: PAY_TO, asset: USDC,
  resource: "https://pay.example/resource", description: "test", mimeType: "application/json",
  maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" },
};

function decode(header: string) {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    x402Version: number; scheme: string; network: string;
    payload: { signature: `0x${string}`; authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: `0x${string}` } };
  };
}

async function verifies(address: `0x${string}`, d: ReturnType<typeof decode>) {
  const a = d.payload.authorization;
  return verifyTypedData({
    address,
    domain: { name: "USDC", version: "2", chainId: CHAIN_IDS["base-sepolia"]!, verifyingContract: USDC },
    types: AUTH_TYPES, primaryType: "TransferWithAuthorization",
    message: { from: getAddress(a.from), to: getAddress(a.to), value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
    signature: d.payload.signature,
  });
}

test("matches the official x402 v1 client structurally and both signatures verify", async () => {
  const signer = new EvmSigner(KEY);
  const account = privateKeyToAccount(KEY);
  assert.equal(signer.address, account.address);
  const ours = decode(await signer.sign(reqs, { x402Version: 1 }));
  const theirs = decode(await createPaymentHeader(account, 1, reqs as never));
  for (const k of ["x402Version", "scheme", "network"] as const) assert.equal(ours[k], theirs[k]);
  assert.equal(ours.payload.authorization.from.toLowerCase(), theirs.payload.authorization.from.toLowerCase());
  assert.equal(ours.payload.authorization.to.toLowerCase(), theirs.payload.authorization.to.toLowerCase());
  assert.equal(ours.payload.authorization.value, theirs.payload.authorization.value);
  assert.match(ours.payload.authorization.nonce, /^0x[0-9a-f]{64}$/);
  assert.match(theirs.payload.authorization.nonce, /^0x[0-9a-f]{64}$/);
  assert.ok(Math.abs(Number(ours.payload.authorization.validAfter) - Number(theirs.payload.authorization.validAfter)) <= 5);
  assert.ok(Math.abs(Number(ours.payload.authorization.validBefore) - Number(theirs.payload.authorization.validBefore)) <= 5);
  assert.deepEqual(Object.keys(ours.payload.authorization).sort(), Object.keys(theirs.payload.authorization).sort());
  assert.equal(await verifies(account.address, ours), true);
  assert.equal(await verifies(account.address, theirs), true);
});

test("validity window and nonce come from the injected clock and nonce", async () => {
  const signer = new EvmSigner(KEY, () => 1_700_000_000, () => ("0x" + "ab".repeat(32)) as `0x${string}`);
  const d = decode(await signer.sign(reqs, { x402Version: 1 }));
  assert.equal(d.payload.authorization.validAfter, String(1_700_000_000 - 600));
  assert.equal(d.payload.authorization.validBefore, String(1_700_000_000 + 300));
  assert.equal(d.payload.authorization.nonce, "0x" + "ab".repeat(32));
  const d2 = decode(await signer.sign({ ...reqs, maxTimeoutSeconds: undefined }, { x402Version: 1 }));
  assert.equal(d2.payload.authorization.validBefore, String(1_700_000_000 + 60));
});

test("refuses a challenge without the EIP-712 domain or on an unknown network", async () => {
  const signer = new EvmSigner(KEY);
  await assert.rejects(signer.sign({ ...reqs, extra: undefined }, { x402Version: 1 }), /extra\.name and extra\.version/);
  await assert.rejects(signer.sign({ ...reqs, network: "mock" }, { x402Version: 1 }), /unsupported network "mock"/);
});
```

Run: `npx tsx --test test/evm-signer.test.ts` → fails at import of `../src/evm-signer.js`. If `x402/client` fails to import under NodeNext, import from `x402` and read `createPaymentHeader` off the default export, and note it.

- [ ] **Step 2: Implement `src/evm-signer.ts`**

```ts
import { randomBytes } from "node:crypto";
import { getAddress, toHex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { PaymentRequirements, X402Signer } from "@olurabian/purse/x402";

export const CHAIN_IDS: Record<string, number> = { "base-sepolia": 84532, base: 8453 };

export const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * Signs x402 v1 "exact" payments on EVM networks: an EIP-3009 TransferWithAuthorization
 * over the USDC contract named in the challenge, encoded as the X-PAYMENT header the way
 * the official client does it. The key lives only in this object.
 */
export class EvmSigner implements X402Signer {
  readonly address: `0x${string}`;
  private readonly account: PrivateKeyAccount;

  constructor(
    privateKey: `0x${string}`,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
    private readonly newNonce: () => `0x${string}` = () => toHex(randomBytes(32)),
  ) {
    this.account = privateKeyToAccount(privateKey);
    this.address = this.account.address;
  }

  async sign(reqs: PaymentRequirements, ctx: { x402Version: number }): Promise<string> {
    const chainId = CHAIN_IDS[reqs.network];
    if (!chainId) throw new Error(`EvmSigner: unsupported network "${reqs.network}"`);
    const name = reqs.extra?.name;
    const version = reqs.extra?.version;
    if (!name || !version) throw new Error("EvmSigner: the 402 requirements lack extra.name and extra.version (the EIP-712 domain)");
    const now = this.nowSeconds();
    const authorization = {
      from: this.address,
      to: getAddress(reqs.payTo),
      value: reqs.maxAmountRequired,
      validAfter: String(now - 600),
      validBefore: String(now + (reqs.maxTimeoutSeconds ?? 60)),
      nonce: this.newNonce(),
    };
    const signature = await this.account.signTypedData({
      domain: { name, version, chainId, verifyingContract: getAddress(reqs.asset) },
      types: AUTH_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
    });
    const payment = { x402Version: ctx.x402Version, scheme: reqs.scheme, network: reqs.network, payload: { signature, authorization } };
    return Buffer.from(JSON.stringify(payment), "utf8").toString("base64");
  }
}
```

Run: `npx tsx --test test/evm-signer.test.ts` → 3 pass. `npm run build && npm run typecheck && npm test`.

- [ ] **Step 3: Commit**

```bash
git add deploy/broker/src/evm-signer.ts deploy/broker/test/evm-signer.test.ts
git commit -q -m "feat(broker): EVM signer for x402 exact payments, conformance-tested against the official client

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Store, executor, telemetry

- [ ] **Step 1: Failing executor tests**

Create `test/executor.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Broker } from "@olurabian/purse";
import { startMock402 } from "@olurabian/purse/x402";
import { buildExecutor, usdcToMoney } from "../src/executor.js";

test("mock executor pays", async () => {
  const { executor, signerAddress } = buildExecutor({ kind: "mock" }, "USD");
  assert.equal(signerAddress, undefined);
  const b = new Broker({ maxPerAction: "$5", allow: ["v"], executor });
  const r = b.request({ amount: "$1", payee: "v", intent: "t" });
  assert.equal((await b.execute(r.grantId!)).status, "paid");
});

test("x402 executor with the mock signer settles against the packaged mock server", async () => {
  const mock = await startMock402({ amount: "300" });
  try {
    const { executor } = buildExecutor({ kind: "x402", resources: { vendor: mock.url }, signer: "mock", network: "mock", allowMainnet: false }, "USD");
    const b = new Broker({ maxPerAction: "$5", allow: ["vendor"], executor });
    const r = b.request({ amount: "$3", payee: "vendor", intent: "t" });
    const x = await b.execute(r.grantId!);
    assert.equal(x.status, "paid");
    assert.equal(x.receipt?.ref, "mock_tx_1");
    const r2 = b.request({ amount: "$3", payee: "unknown", intent: "t" });
    assert.equal(r2.decision, "denied");
  } finally { await mock.close(); }
});

test("usdc atomic units convert to cents only when exact", () => {
  assert.deepEqual(usdcToMoney({ maxAmountRequired: "5000000" }, "USD"), { amount: 500, currency: "USD" });
  assert.deepEqual(usdcToMoney({ maxAmountRequired: "10000" }, "USD"), { amount: 1, currency: "USD" });
  assert.ok(Number.isNaN(usdcToMoney({ maxAmountRequired: "123" }, "USD").amount));
  assert.ok(Number.isNaN(usdcToMoney({ maxAmountRequired: "5000000" }, "EUR").amount));
});

test("evm signer is built from config and exposes its address", () => {
  const { signerAddress } = buildExecutor({ kind: "x402", resources: { v: "https://x" }, signer: "evm", network: "base-sepolia", privateKey: ("0x" + "7".repeat(64)) as `0x${string}`, allowMainnet: false }, "USD");
  assert.match(signerAddress ?? "", /^0x[0-9a-fA-F]{40}$/);
});
```

- [ ] **Step 2: Implement**

`src/executor.ts`:

```ts
import { MockExecutor, type Executor } from "@olurabian/purse";
import { X402Executor, MockSigner, type PaymentRequirements, type X402Signer } from "@olurabian/purse/x402";
import { EvmSigner } from "./evm-signer.js";
import type { ExecutorConfig } from "./config.js";

export interface Money { amount: number; currency: string }

/** 6-decimal USDC atomic units to policy cents. Anything that does not divide exactly, or a non-USD policy, is NaN so the ceiling guard rejects it. */
export function usdcToMoney(reqs: Pick<PaymentRequirements, "maxAmountRequired">, currency: string): Money {
  if (currency !== "USD") return { amount: Number.NaN, currency };
  let atomic: bigint;
  try { atomic = BigInt(reqs.maxAmountRequired); } catch { return { amount: Number.NaN, currency }; }
  if (atomic < 0n || atomic % 10_000n !== 0n) return { amount: Number.NaN, currency };
  return { amount: Number(atomic / 10_000n), currency };
}

export function buildExecutor(cfg: ExecutorConfig, currency: string, overrides: { signer?: X402Signer } = {}): { executor: Executor; signerAddress?: string } {
  if (cfg.kind === "mock") return { executor: new MockExecutor() };
  let signer: X402Signer;
  let signerAddress: string | undefined;
  if (overrides.signer) signer = overrides.signer;
  else if (cfg.signer === "mock") signer = new MockSigner();
  else {
    const evm = new EvmSigner(cfg.privateKey!);
    signer = evm;
    signerAddress = evm.address;
  }
  const real = cfg.network !== "mock";
  const executor = new X402Executor({
    resolvePayee: (payee: string) => cfg.resources[payee],
    signer,
    ...(real ? { toMoney: (reqs: PaymentRequirements, cur: string) => usdcToMoney(reqs, cur) } : {}),
  });
  return { executor, signerAddress };
}
```

If `X402ExecutorOptions.toMoney`'s exact name or parameter order differs in the installed purse 0.4.0 (`node -p "require('@olurabian/purse/package.json').version"` then read `node_modules/@olurabian/purse/dist/x402/executor.d.ts`), match it and say so in the report.

`src/store.ts`:

```ts
import pg from "pg";
import { PostgresStore, verifyChain, type SqlClient, type Store } from "@olurabian/receipt";
import { JsonlAuditStore, type DecisionPayload } from "@olurabian/purse";
import type { StoreConfig } from "./config.js";

export interface OpenedStore {
  store: Store<DecisionPayload>;
  kind: "postgres" | "jsonl";
  pending: () => number;
  degraded: () => Error | null;
  flush: () => Promise<void>;
  close: () => Promise<void>;
}

export async function openStore(cfg: StoreConfig, client?: SqlClient): Promise<OpenedStore> {
  if (cfg.kind === "jsonl") {
    const store = new JsonlAuditStore(cfg.file);
    const v = verifyChain(store.all());
    if (!v.ok) throw new Error(`audit file ${cfg.file} fails verification at index ${v.brokenAt} (${v.reason})`);
    return { store, kind: "jsonl", pending: () => 0, degraded: () => null, flush: async () => undefined, close: async () => undefined };
  }
  const pool = client ? null : new pg.Pool({ connectionString: cfg.url });
  const sql: SqlClient = client ?? (pool as unknown as SqlClient);
  const store = await PostgresStore.open<DecisionPayload>(sql, { stream: cfg.stream });
  return {
    store, kind: "postgres",
    pending: () => store.pending(), degraded: () => store.degraded(), flush: () => store.flush(),
    close: async () => { await store.flush().catch(() => undefined); if (pool) await pool.end(); },
  };
}
```

`src/otel.ts`:

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

/** Starts the OpenTelemetry SDK from the standard OTEL_EXPORTER_OTLP_* environment. Returns a shutdown, or null when no endpoint is set. */
export function startOtel(serviceName = "purse-broker"): (() => Promise<void>) | null {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return null;
  const sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter(),
    metricReader: new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: 15_000 }),
  });
  sdk.start();
  return () => sdk.shutdown();
}
```

Run: `npx tsx --test test/executor.test.ts` → 4 pass. `npm run build && npm run typecheck && npm test`.

- [ ] **Step 3: Commit**

```bash
git add deploy/broker/src/executor.ts deploy/broker/src/store.ts deploy/broker/src/otel.ts deploy/broker/test/executor.test.ts
git commit -q -m "feat(broker): store, executor selection, and telemetry bootstrap

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Servers, MCP, app, main

- [ ] **Step 1: Failing app test**

Create `test/app.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { SqlClient } from "@olurabian/receipt";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";

const TOKEN = "t".repeat(32);
function cfg(over: Partial<Config> = {}): Config {
  return {
    policy: { currency: "USD", maxPerAction: "$5", maxPerDay: "$100", requireApprovalOver: "$3", allow: ["api.stripe.com"] },
    store: { kind: "postgres", url: "postgres://unused", stream: "t" },
    ports: { agent: 0, admin: 0, bind: "127.0.0.1" },
    adminToken: TOKEN, executor: { kind: "mock" }, maxPending: 5, otel: false, ...over,
  };
}
async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}
async function get(url: string, headers: Record<string, string> = {}) {
  const r = await fetch(url, { headers });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}
const auth = { authorization: `Bearer ${TOKEN}` };

test("agent port: request, execute, status, health; admin port: auth, pending, approve, verify, audit, readiness", async () => {
  const db = new PGlite();
  const app = await createApp(cfg(), { sqlClient: db as unknown as SqlClient });
  const { agentUrl, adminUrl } = await app.start();
  try {
    assert.deepEqual((await get(`${agentUrl}/healthz`)).json, { ok: true });
    const r = await post(`${agentUrl}/request`, { amount: "$1", payee: "api.stripe.com", intent: "credits" });
    assert.equal(r.json.decision, "allowed");
    const x = await post(`${agentUrl}/execute`, { grantId: r.json.grantId });
    assert.equal(x.json.status, "paid");
    assert.equal((await post(`${agentUrl}/nope`, {})).status, 404);
    assert.equal((await get(`${adminUrl}/pending`)).status, 401);
    assert.equal((await get(`${adminUrl}/pending`, { authorization: "Bearer wrong" })).status, 401);
    assert.deepEqual((await get(`${adminUrl}/healthz`)).json, { ok: true });
    const held = await post(`${agentUrl}/request`, { amount: "$4", payee: "api.stripe.com", intent: "big" });
    assert.equal(held.json.decision, "needs_approval");
    const pending = await get(`${adminUrl}/pending`, auth);
    assert.equal((pending.json.pending as unknown[]).length, 1);
    const ap = await post(`${adminUrl}/approve`, { pendingId: held.json.pendingId }, auth);
    assert.equal(ap.status, 200);
    const st = await post(`${agentUrl}/status`, { pendingId: held.json.pendingId });
    assert.equal(st.json.state, "approved");
    const x2 = await post(`${agentUrl}/execute`, { grantId: st.json.grantId });
    assert.equal(x2.json.status, "paid");
    const v = await get(`${adminUrl}/verify`, auth);
    assert.equal(v.json.ok, true);
    assert.ok((v.json.records as number) >= 4);
    assert.equal(v.json.degraded, null);
    const audit = await get(`${adminUrl}/audit?since=2000-01-01T00:00:00.000Z`, auth);
    assert.ok((audit.json.receipts as unknown[]).length >= 4);
    assert.equal((await get(`${adminUrl}/readyz`, auth)).status, 200);
    const again = await createApp(cfg(), { sqlClient: db as unknown as SqlClient });
    assert.equal(again.broker.verify().ok, true);
    assert.ok(again.broker.audit().length >= 4);
  } finally { await app.stop(); }
});

test("mcp tools on the agent port", async () => {
  const app = await createApp(cfg(), { sqlClient: new PGlite() as unknown as SqlClient });
  const { agentUrl } = await app.start();
  const client = new Client({ name: "test", version: "0.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${agentUrl}/mcp`)));
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((t) => t.name).sort(), ["execute_spend", "request_spend", "spend_status"]);
    const r = await client.callTool({ name: "request_spend", arguments: { amount: "$1", payee: "api.stripe.com", intent: "credits" } });
    const decision = JSON.parse((r.content as { text: string }[])[0]!.text) as { decision: string; grantId?: string };
    assert.equal(decision.decision, "allowed");
    const x = await client.callTool({ name: "execute_spend", arguments: { grantId: decision.grantId } });
    assert.equal(JSON.parse((x.content as { text: string }[])[0]!.text).status, "paid");
  } finally { await client.close().catch(() => undefined); await app.stop(); }
});

test("a degraded store takes readiness to 503 and money stops", async () => {
  const db = new PGlite();
  let fail = false;
  const flaky: SqlClient = { query: async (t, p) => { if (fail && t.startsWith("INSERT")) throw Object.assign(new Error("relation gone"), { code: "42P01" }); return db.query(t, p as unknown[]); } };
  const app = await createApp(cfg(), { sqlClient: flaky });
  const { agentUrl, adminUrl } = await app.start();
  try {
    assert.equal((await get(`${adminUrl}/readyz`, auth)).status, 200);
    fail = true;
    const r = await post(`${agentUrl}/request`, { amount: "$1", payee: "api.stripe.com", intent: "c" });
    assert.equal(r.json.decision, "allowed");
    const x = await post(`${agentUrl}/execute`, { grantId: r.json.grantId });
    assert.equal(x.status, 503);
    assert.match(String(x.json.error), /degraded/);
    const ready = await get(`${adminUrl}/readyz`, auth);
    assert.equal(ready.status, 503);
    assert.match(String(ready.json.reason), /degraded/);
    const v = await get(`${adminUrl}/verify`, auth);
    assert.match(String(v.json.degraded), /degraded|relation gone/);
  } finally { await app.stop().catch(() => undefined); }
});

test("boot refuses a broken chain", async () => {
  const db = new PGlite();
  const app = await createApp(cfg(), { sqlClient: db as unknown as SqlClient });
  const { agentUrl } = await app.start();
  await post(`${agentUrl}/request`, { amount: "$1", payee: "api.stripe.com", intent: "c" });
  await app.stop();
  await db.query(`UPDATE receipts SET record = replace(record, '"status":"allowed"', '"status":"denied"')`);
  await assert.rejects(createApp(cfg(), { sqlClient: db as unknown as SqlClient }), /fails verification/);
});
```

Run: `npx tsx --test test/app.test.ts` → fails at import of `../src/app.js`.

- [ ] **Step 2: Implement the servers**

`src/http.ts`:

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text) as unknown;
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function errorStatus(e: unknown): number {
  return /degraded/i.test((e as Error)?.message ?? "") ? 503 : 500;
}
```

`src/mcp.ts`:

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Broker } from "@olurabian/purse";

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

export function createMcpServer(broker: Broker): McpServer {
  const server = new McpServer({ name: "purse-broker", version: "0.1.0" });
  server.tool("request_spend", "Ask Purse to authorize a spend. Returns the decision and, when allowed, a single-use grantId. Call this before any payment.",
    { amount: z.string().describe('e.g. "$12.50"'), payee: z.string(), intent: z.string().optional(), category: z.string().optional() },
    async (args) => text(broker.request(args)));
  server.tool("execute_spend", "Redeem an allowed grant. The broker performs the payment and returns the outcome and a scrubbed receipt.",
    { grantId: z.string() }, async ({ grantId }) => text(await broker.execute(grantId)));
  server.tool("spend_status", "Check whether a spend that needed approval has been approved or denied by the principal.",
    { pendingId: z.string() }, async ({ pendingId }) => text(broker.status(pendingId)));
  return server;
}

/** Stateless streamable HTTP: one server and transport per request, closed with the response. */
export async function handleMcp(broker: Broker, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  const server = createMcpServer(broker);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
```

`src/agent-server.ts`:

```ts
import { createServer, type Server } from "node:http";
import type { Broker, AuthorizeRequest } from "@olurabian/purse";
import { readJson, send, errorStatus } from "./http.js";
import { handleMcp } from "./mcp.js";

export interface Listening { server: Server; url: string; close(): Promise<void> }

export function createAgentServer(broker: Broker): Server {
  return createServer(async (req, res) => {
    try {
      const path = (req.url ?? "/").split("?")[0];
      if (req.method === "GET" && path === "/healthz") return send(res, 200, { ok: true });
      if (req.method !== "POST") return send(res, 404, { error: "not found" });
      const body = await readJson(req);
      switch (path) {
        case "/request": return send(res, 200, broker.request(body as AuthorizeRequest));
        case "/execute": return send(res, 200, await broker.execute(String((body as { grantId?: unknown }).grantId ?? "")));
        case "/status": return send(res, 200, broker.status(String((body as { pendingId?: unknown }).pendingId ?? "")));
        case "/mcp": return await handleMcp(broker, req, res, body);
        default: return send(res, 404, { error: "not found" });
      }
    } catch (e) {
      if (!res.headersSent) send(res, errorStatus(e), { error: (e as Error).message });
    }
  });
}

export function listen(server: Server, port: number, host: string): Promise<Listening> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const a = server.address();
      const p = typeof a === "object" && a ? a.port : port;
      resolve({ server, url: `http://${host}:${p}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
```

If `AuthorizeRequest` is not exported from `@olurabian/purse`, use `Parameters<Broker["request"]>[0]`.

`src/admin-server.ts`:

```ts
import { createServer, type Server } from "node:http";
import type { Broker } from "@olurabian/purse";
import { readJson, send, bearerMatches, errorStatus } from "./http.js";
import type { OpenedStore } from "./store.js";

export interface Readiness { ok: boolean; reason?: string }

export function createAdminServer(broker: Broker, store: OpenedStore, token: string, ready: () => Readiness): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://admin");
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
      if (!bearerMatches(req.headers.authorization, token)) return send(res, 401, { error: "unauthorized" });
      if (req.method === "GET") {
        switch (url.pathname) {
          case "/readyz": { const r = ready(); return send(res, r.ok ? 200 : 503, r); }
          case "/pending": return send(res, 200, { pending: broker.pending() });
          case "/verify": {
            const v = broker.verify();
            return send(res, 200, { ...v, records: broker.audit().length, pending: store.pending(), degraded: store.degraded()?.message ?? null });
          }
          case "/audit": {
            const since = url.searchParams.get("since");
            const all = broker.audit();
            return send(res, 200, { receipts: since ? all.filter((r) => r.ts >= since) : all });
          }
          default: return send(res, 404, { error: "not found" });
        }
      }
      if (req.method === "POST") {
        const body = (await readJson(req)) as { pendingId?: unknown };
        const id = String(body.pendingId ?? "");
        switch (url.pathname) {
          case "/approve": return send(res, 200, broker.approve(id));
          case "/deny": return send(res, 200, broker.deny(id));
          default: return send(res, 404, { error: "not found" });
        }
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      if (!res.headersSent) send(res, errorStatus(e), { error: (e as Error).message });
    }
  });
}
```

If `broker.approve`/`deny` return void in purse 0.4, wrap as `{ ok: true }`. Read `node_modules/@olurabian/purse/dist/broker.d.ts` for their return types.

`src/app.ts`:

```ts
import { Broker, verifyChain } from "@olurabian/purse";
import { instrumentBroker } from "@olurabian/deadlatch-otel";
import type { SqlClient } from "@olurabian/receipt";
import type { X402Signer } from "@olurabian/purse/x402";
import type { Config } from "./config.js";
import { openStore, type OpenedStore } from "./store.js";
import { buildExecutor } from "./executor.js";
import { startOtel } from "./otel.js";
import { createAgentServer, listen, type Listening } from "./agent-server.js";
import { createAdminServer, type Readiness } from "./admin-server.js";

export interface AppOverrides { sqlClient?: SqlClient; signer?: X402Signer }
export interface App {
  broker: Broker; store: OpenedStore; signerAddress?: string;
  ready(): Readiness;
  start(): Promise<{ agentUrl: string; adminUrl: string }>;
  stop(): Promise<void>;
}

export async function createApp(cfg: Config, overrides: AppOverrides = {}): Promise<App> {
  const stopOtel = cfg.otel ? startOtel() : null;
  const store = await openStore(cfg.store, overrides.sqlClient);
  const boot = verifyChain(store.store.all());
  if (!boot.ok) throw new Error(`audit chain fails verification at index ${boot.brokenAt} (${boot.reason})`);
  const { executor, signerAddress } = buildExecutor(cfg.executor, cfg.policy.currency, { signer: overrides.signer });
  const { grantTtlMs, ...policy } = cfg.policy;
  const broker = instrumentBroker(new Broker({ ...policy, executor, store: store.store, ...(grantTtlMs ? { grantTtlMs } : {}) }), { store });

  const ready = (): Readiness => {
    const d = store.degraded();
    if (d) return { ok: false, reason: `store degraded: ${d.message}` };
    const p = store.pending();
    if (p >= cfg.maxPending) return { ok: false, reason: `store has ${p} receipts pending (limit ${cfg.maxPending})` };
    return { ok: true };
  };

  let agent: Listening | null = null;
  let admin: Listening | null = null;
  return {
    broker, store, signerAddress, ready,
    async start() {
      agent = await listen(createAgentServer(broker), cfg.ports.agent, cfg.ports.bind);
      admin = await listen(createAdminServer(broker, store, cfg.adminToken, ready), cfg.ports.admin, cfg.ports.bind);
      return { agentUrl: agent.url, adminUrl: admin.url };
    },
    async stop() {
      await Promise.all([agent?.close(), admin?.close()]);
      await broker.flush().catch(() => undefined);
      await store.close();
      if (stopOtel) await stopOtel();
    },
  };
}
```

`src/main.ts`:

```ts
import { loadConfig, ConfigError } from "./config.js";
import { createApp } from "./app.js";

try {
  const cfg = loadConfig();
  const app = await createApp(cfg);
  const { agentUrl, adminUrl } = await app.start();
  console.log(`purse-broker up. agent ${agentUrl} (request, execute, status, mcp) | admin ${adminUrl} (token) | store ${cfg.store.kind} | executor ${cfg.executor.kind}${app.signerAddress ? ` | signer ${app.signerAddress}` : ""}`);
  const shutdown = async (signal: string) => {
    console.log(`purse-broker: ${signal}, flushing and stopping`);
    await app.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
} catch (e) {
  console.error(e instanceof ConfigError ? e.message : `purse-broker failed to start: ${(e as Error).message}`);
  process.exit(1);
}
```

Run: `npx tsx --test test/app.test.ts` → 4 pass. Then `npm run build && npm run typecheck && npm test` (all files). If the MCP SDK's `server.tool` signature in the installed version requires `registerTool`, use that form and note it; the tool names and schemas stay.

- [ ] **Step 3: Commit**

```bash
git add deploy/broker/src/http.ts deploy/broker/src/mcp.ts deploy/broker/src/agent-server.ts deploy/broker/src/admin-server.ts deploy/broker/src/app.ts deploy/broker/src/main.ts deploy/broker/test/app.test.ts
git commit -q -m "feat(broker): agent port with HTTP and MCP, token-protected admin port, fail-closed readiness

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Dockerfile, compose, CI, Fly

- [ ] **Step 1: Files**

`deploy/broker/Dockerfile`:

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-alpine
ENV NODE_ENV=production
RUN addgroup -S purse && adduser -S purse -G purse
WORKDIR /app
COPY --from=build --chown=purse:purse /app/package.json ./package.json
COPY --from=build --chown=purse:purse /app/node_modules ./node_modules
COPY --from=build --chown=purse:purse /app/dist ./dist
USER purse
EXPOSE 8080 8081
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:8081/healthz || exit 1
CMD ["node", "dist/main.js"]
```

`deploy/broker/compose.yaml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: purse
      POSTGRES_PASSWORD: purse
      POSTGRES_DB: purse
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U purse"]
      interval: 5s
      timeout: 3s
      retries: 10
  broker:
    build: .
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://purse:purse@postgres:5432/purse
      PURSE_ADMIN_TOKEN: ${PURSE_ADMIN_TOKEN:?set PURSE_ADMIN_TOKEN to a random string of at least 24 characters}
      PURSE_MAX_PER_ACTION: ${PURSE_MAX_PER_ACTION:-$$50}
      PURSE_MAX_PER_DAY: ${PURSE_MAX_PER_DAY:-$$500}
      PURSE_REQUIRE_APPROVAL_OVER: ${PURSE_REQUIRE_APPROVAL_OVER:-$$20}
      PURSE_ALLOW: ${PURSE_ALLOW:-api.stripe.com}
      PURSE_EXECUTOR: ${PURSE_EXECUTOR:-mock}
      OTEL_EXPORTER_OTLP_ENDPOINT: ${OTEL_EXPORTER_OTLP_ENDPOINT:-}
      OTEL_EXPORTER_OTLP_HEADERS: ${OTEL_EXPORTER_OTLP_HEADERS:-}
    ports:
      - "127.0.0.1:8080:8080"
      - "127.0.0.1:8081:8081"
```

`deploy/broker/fly.toml`:

```toml
app = "purse-broker"
primary_region = "lhr"

[build]
  dockerfile = "Dockerfile"

[env]
  PURSE_AGENT_PORT = "8080"
  PURSE_ADMIN_PORT = "8081"
  PURSE_EXECUTOR = "mock"
  PURSE_MAX_PER_ACTION = "$50"
  PURSE_MAX_PER_DAY = "$500"
  PURSE_REQUIRE_APPROVAL_OVER = "$20"
  PURSE_ALLOW = "api.stripe.com"

# Agent port is public. The admin port is not exposed; reach it with `fly proxy 8081:8081 -a purse-broker`.
[[services]]
  internal_port = 8080
  protocol = "tcp"
  auto_stop_machines = false
  min_machines_running = 1
  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]
  [[services.ports]]
    port = 80
    handlers = ["http"]
  [[services.http_checks]]
    interval = "15s"
    timeout = "3s"
    path = "/healthz"

# Secrets, set once: fly secrets set DATABASE_URL=... PURSE_ADMIN_TOKEN=... OTEL_EXPORTER_OTLP_ENDPOINT=... OTEL_EXPORTER_OTLP_HEADERS=...
```

`.github/workflows/image.yml` (repo root):

```yaml
name: image
on:
  push:
    tags: ["broker-v*"]
    branches: [main]
    paths: ["deploy/broker/**", ".github/workflows/image.yml"]
  pull_request:
    paths: ["deploy/broker/**"]
  workflow_dispatch:
permissions:
  contents: read
  packages: write
jobs:
  image:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - name: Login to GHCR
        if: startsWith(github.ref, 'refs/tags/broker-v')
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Tags
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/arabiananalyst/purse-broker
          tags: |
            type=match,pattern=broker-v(.*),group=1
            type=raw,value=latest,enable=${{ startsWith(github.ref, 'refs/tags/broker-v') }}
      - name: Build (and push on a tag)
        uses: docker/build-push-action@v6
        with:
          context: deploy/broker
          push: ${{ startsWith(github.ref, 'refs/tags/broker-v') }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
```

Add to `.github/workflows/ci.yml` a job (mirroring the existing job's install and allow-scripts steps):

```yaml
  broker:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: deploy/broker
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci --no-audit --no-fund
      - run: npx allow-scripts
      - run: npm run build
      - run: npm run typecheck
      - run: npm test
```

- [ ] **Step 2: Verify what can be verified here**

There is no Docker on this machine. Validate the Dockerfile and compose statically: `docker` is absent, so run `npx --yes dockerfilelint deploy/broker/Dockerfile` if it installs cleanly, otherwise skip and say so; run `node -e "require('js-yaml')"`-free YAML checks by loading each workflow and compose file with `npx --yes yaml@2 parse < file` or Python if available, or simply `node --input-type=module -e "import('yaml')"` after `npm i -D yaml` is NOT allowed (no new dev deps). Use `python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" file` if Python and PyYAML exist; otherwise visually check indentation and report that YAML was not machine-validated. The `image` workflow builds without pushing on the next push to `main`, which is the real validation.

- [ ] **Step 3: Commit**

```bash
git add deploy/broker/Dockerfile deploy/broker/compose.yaml deploy/broker/fly.toml .github/workflows/image.yml .github/workflows/ci.yml
git commit -q -m "ci(broker): Dockerfile, compose, Fly config, image workflow to GHCR, broker test job

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Deploy guide and Grafana dashboard

- [ ] **Step 1: `deploy/broker/grafana/purse-broker.json`**

```json
{
  "__inputs": [
    { "name": "DS_PROMETHEUS", "label": "Prometheus", "type": "datasource", "pluginId": "prometheus" },
    { "name": "DS_TEMPO", "label": "Tempo", "type": "datasource", "pluginId": "tempo" }
  ],
  "title": "Purse broker",
  "uid": "purse-broker",
  "schemaVersion": 39,
  "version": 1,
  "refresh": "30s",
  "time": { "from": "now-6h", "to": "now" },
  "tags": ["deadlatch", "purse"],
  "panels": [
    { "id": 1, "type": "timeseries", "title": "Decisions per minute", "gridPos": { "x": 0, "y": 0, "w": 12, "h": 8 },
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "targets": [{ "refId": "A", "expr": "sum by (decision) (rate(deadlatch_purse_decisions_total[5m]) * 60)", "legendFormat": "{{decision}}" }] },
    { "id": 2, "type": "stat", "title": "Denial ratio (1h)", "gridPos": { "x": 12, "y": 0, "w": 6, "h": 8 },
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "fieldConfig": { "defaults": { "unit": "percentunit", "thresholds": { "mode": "absolute", "steps": [{ "color": "green", "value": null }, { "color": "orange", "value": 0.2 }, { "color": "red", "value": 0.5 }] } } },
      "targets": [{ "refId": "A", "expr": "sum(increase(deadlatch_purse_decisions_total{decision=\"denied\"}[1h])) / clamp_min(sum(increase(deadlatch_purse_decisions_total[1h])), 1)" }] },
    { "id": 3, "type": "stat", "title": "Store degraded", "gridPos": { "x": 18, "y": 0, "w": 6, "h": 8 },
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "fieldConfig": { "defaults": { "thresholds": { "mode": "absolute", "steps": [{ "color": "green", "value": null }, { "color": "red", "value": 1 }] }, "mappings": [{ "type": "value", "options": { "0": { "text": "healthy" }, "1": { "text": "DEGRADED" } } }] } },
      "targets": [{ "refId": "A", "expr": "max(deadlatch_purse_store_degraded)" }] },
    { "id": 4, "type": "timeseries", "title": "Executions (1h windows)", "gridPos": { "x": 0, "y": 8, "w": 12, "h": 8 },
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "targets": [{ "refId": "A", "expr": "sum by (status) (increase(deadlatch_purse_executions_total[1h]))", "legendFormat": "{{status}}" }] },
    { "id": 5, "type": "timeseries", "title": "Pending approvals and receipts not yet durable", "gridPos": { "x": 12, "y": 8, "w": 12, "h": 8 },
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "targets": [
        { "refId": "A", "expr": "max(deadlatch_purse_approvals_pending)", "legendFormat": "approvals pending" },
        { "refId": "B", "expr": "max(deadlatch_purse_store_pending)", "legendFormat": "receipts pending" }
      ] },
    { "id": 6, "type": "traces", "title": "Recent enforce spans", "gridPos": { "x": 0, "y": 16, "w": 24, "h": 10 },
      "datasource": { "type": "tempo", "uid": "${DS_TEMPO}" },
      "targets": [{ "refId": "A", "queryType": "traceql", "query": "{ resource.service.name = \"purse-broker\" && name =~ \"deadlatch.enforce.*\" }", "limit": 20 }] }
  ]
}
```

- [ ] **Step 2: `deploy/broker/README.md`**

Write the guide with these sections and this content, in this order. Prose sentences carry no colons and no em dashes.

```markdown
# Purse broker

Purse enforcement mode as a container. An agent asks the broker for a spend, the broker decides against policy, performs the payment itself, and writes a hash-chained receipt to Postgres that anyone can verify without trusting the broker. Two ports. The agent port speaks HTTP and MCP and holds no secret. The admin port takes a bearer token and is for the principal.

## Run it in under an hour

You need Docker and a terminal. Grafana Cloud is optional and takes five extra minutes.

1. Start it.

```bash
export PURSE_ADMIN_TOKEN=$(openssl rand -hex 24)
docker compose up --build
```

The broker is up when it prints its two URLs. Postgres holds the receipts. The executor is the mock, which "pays" and returns a receipt, so no money moves.

2. Route a spend from the agent side.

```bash
curl -s localhost:8080/request -H 'content-type: application/json' \
  -d '{"amount":"$12.50","payee":"api.stripe.com","intent":"credits"}'
```

You get a decision. When it is `allowed` it carries a single-use `grantId`. Redeem it.

```bash
curl -s localhost:8080/execute -H 'content-type: application/json' -d '{"grantId":"<grantId>"}'
```

The response is the outcome and a scrubbed receipt. The receipt is now durable in Postgres.

3. Hold and approve a bigger spend.

```bash
curl -s localhost:8080/request -H 'content-type: application/json' \
  -d '{"amount":"$35","payee":"api.stripe.com","intent":"annual plan"}'
curl -s localhost:8081/pending -H "authorization: Bearer $PURSE_ADMIN_TOKEN"
curl -s localhost:8081/approve -H "authorization: Bearer $PURSE_ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"pendingId":"<pendingId>"}'
curl -s localhost:8080/status -H 'content-type: application/json' -d '{"pendingId":"<pendingId>"}'
```

The agent asked. It could not approve itself. The principal approved on a port the agent cannot reach.

4. Verify the chain.

```bash
curl -s localhost:8081/verify -H "authorization: Bearer $PURSE_ADMIN_TOKEN"
```

`ok` true means every receipt recomputes and every link holds. `pending` is how many receipts are queued but not yet committed, and `degraded` is null while the store is healthy. Verify independently with twenty lines of plain SHA-256, the recipe is in the receipt package README.

5. See it in Grafana.

Set the two OpenTelemetry variables for your Grafana Cloud stack and restart.

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-<region>.grafana.net/otlp
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic <base64 instanceId:token>"
docker compose up --build
```

Import `grafana/purse-broker.json` and pick your Prometheus and Tempo data sources. Decisions per minute, the denial ratio, executions, pending approvals, receipts not yet durable, whether the store has degraded, and the recent enforce spans.

## Use it from an MCP agent

Point the agent's MCP client at `http://<broker>:8080/mcp` (streamable HTTP). It gets three tools. `request_spend` before any payment. `execute_spend` with the grant it was given. `spend_status` while a spend waits for approval. Tell the agent in one line to call `request_spend` before any payment and to stop if the decision is not `allowed`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | Postgres connection string. Receipts live here. |
| `PURSE_STREAM` | `purse` | Stream name inside the receipts table. One broker per stream. |
| `PURSE_STORE` | | Set to `jsonl` to use a file instead of Postgres, for development only. |
| `PURSE_AUDIT_FILE` | `./purse-audit.jsonl` | The file, when `PURSE_STORE=jsonl`. |
| `PURSE_ADMIN_TOKEN` | required | Bearer token for the admin port, at least 24 characters. |
| `PURSE_AGENT_PORT` | `8080` | Agent port. |
| `PURSE_ADMIN_PORT` | `8081` | Admin port. |
| `PURSE_BIND` | `0.0.0.0` | Bind address for both. |
| `PURSE_CURRENCY` | `USD` | Policy currency. Must be USD for x402 on a real network. |
| `PURSE_MAX_PER_ACTION` | | Cap per spend, for example `$50`. |
| `PURSE_MAX_PER_DAY` | | Rolling daily cap. Open grants reserve budget. |
| `PURSE_REQUIRE_APPROVAL_OVER` | | Spends above this wait for the principal. |
| `PURSE_ALLOW` | | Comma-separated payee allowlist. |
| `PURSE_DENY` | | Comma-separated payee denylist. |
| `PURSE_GRANT_TTL_MS` | package default | How long an unredeemed grant lives. |
| `PURSE_MAX_PENDING` | `100` | Readiness fails when more receipts than this are not yet durable. |
| `PURSE_EXECUTOR` | `mock` | `mock` or `x402`. |
| `PURSE_X402_RESOURCES` | | JSON object mapping each allowed payee to its x402 resource URL. |
| `PURSE_X402_NETWORK` | `base-sepolia` | `base-sepolia`, `base`, or `mock`. |
| `PURSE_X402_SIGNER` | `evm` for real networks | `evm` signs with a wallet key. `mock` is for the mock network. |
| `PURSE_X402_PRIVATE_KEY` | | Wallet key, 64 hex characters. Prefer the file. |
| `PURSE_X402_KEY_FILE` | | Path to a file holding the key. Wins over the variable. Never logged. |
| `PURSE_X402_ALLOW_MAINNET` | | Must be `1` to run on `base`. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | | Telemetry starts only when set. Standard OpenTelemetry variables apply. |

A wrong or missing value is a specific error at boot. The broker never falls back to a default that would hide a mistake.

## Settling real money over x402

Set `PURSE_EXECUTOR=x402`, map payees to resource URLs, and give the broker a wallet key through a mounted file. On `base-sepolia` the broker signs an EIP-3009 authorization for the USDC named in the resource's 402 challenge, in the exact form the official x402 client produces, and sends it as the payment header. The signer's address is printed at boot so you can fund it. `base` is mainnet and needs `PURSE_X402_ALLOW_MAINNET=1`.

The key exists in the broker's process and nowhere else. Not in the agent. Not in a prompt. Not on the agent port.

## Where each port may be reached from

The enforcement property only holds under the deployment contract in the Purse threat model. In network terms it comes to this.

- The agent port is reachable from the agent's network and from nowhere else. It carries no secret, but it is the only door to money, so it should not face the public internet without your own gateway in front.
- The admin port is reachable from operators only. Never from the agent's network. A leaked token here is a full compromise, so rotate it like a password.
- The wallet key reaches the broker as a mounted secret. Nothing in the agent's runtime holds a rail credential.
- The agent has no other payment tool and no direct access to the rail. If it can pay some other way, the broker is not a boundary, it is a suggestion.

## Known limits

Single replica. Open grants and spends waiting for approval live in memory and do not survive a restart. The audit chain does. The whole receipt stream is loaded into memory at boot, so memory and start-up time grow with the stream. One wallet key per broker. If the process dies before a queued receipt commits, the receipts still counted as pending are lost, which a verifier cannot distinguish from a deliberate truncation, so anchor the chain head if that matters to you. Telemetry is off until an endpoint is set.

## Reference deployment on Fly

`fly.toml` runs the agent port publicly and keeps the admin port private. Set the secrets once, then deploy.

```bash
fly launch --no-deploy --copy-config
fly secrets set DATABASE_URL=... PURSE_ADMIN_TOKEN=... OTEL_EXPORTER_OTLP_ENDPOINT=... OTEL_EXPORTER_OTLP_HEADERS=...
fly deploy
fly proxy 8081:8081 -a purse-broker
```

## Image

`ghcr.io/arabiananalyst/purse-broker:<version>` is built by GitHub Actions on every `broker-v*` tag from `deploy/broker/Dockerfile`, multi-stage, non-root, with a health check on the admin port.
```

- [ ] **Step 3: Purse README pointer**

In the repo root `README.md`, in the `## Free vs hosted` section (or directly above `## The Deadlatch stack` if that section is not present), add:

```markdown
## Run it as a container

`deploy/broker` packages enforcement mode as an image with both transports on one agent port, a token-protected admin port, receipts in Postgres, and telemetry on by default. The guide in [deploy/broker/README.md](deploy/broker/README.md) goes from `docker compose up` to a verified chain in Grafana in under an hour.
```

- [ ] **Step 4: Sweep and commit**

`grep -nE "^[^\`#|].*(:|—)" deploy/broker/README.md` and confirm every hit is inside a code block, inline code, a table, or a URL.

```bash
git add deploy/broker/README.md deploy/broker/grafana/purse-broker.json README.md
git commit -q -m "docs(broker): deploy guide, deployment checklist, known limits, Grafana dashboard

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Gate and final review

- [ ] **Step 1:** In `deploy/broker`: `rm -rf node_modules && npm ci --no-audit --no-fund && npx allow-scripts && npm run build && npm run typecheck && npm test`. In the purse root: `npm run build && npm test` (unchanged code, must stay green).
- [ ] **Step 2:** Confirm nothing pushed, no tag exists (`git tag -l 'broker-v*'` empty), no image on GHCR.
- [ ] **Step 3:** Final whole-change review on the most capable model over the branch diff with the Global Constraints as the lens, with special attention to the two ports' trust boundary, the signer's key handling, the readiness logic, and whether a stranger could follow the README. Fix Critical and Important findings.

---

### Task 8: Release (only after ARABA confirms)

- [ ] **Step 1:** Merge `broker-image` into `main` (ff-only), push. The `image` workflow builds without pushing on that push; confirm it is green (this is the Dockerfile's first real build).
- [ ] **Step 2:** Tag and push the tag: `git tag broker-v0.1.0 && git push origin broker-v0.1.0`. Confirm the `image` workflow pushed `ghcr.io/arabiananalyst/purse-broker:0.1.0` and `:latest`.
- [ ] **Step 3:** GHCR packages on a user account are private by default. ARABA makes the package public in GitHub (Packages → purse-broker → Package settings → Change visibility), or documents `docker login ghcr.io` for partners.
- [ ] **Step 4:** Definition of done, run by ARABA on a machine with Docker Desktop: `docker compose up --build` from `deploy/broker`, then the README's five steps. Time it. Under an hour from the docs alone is the bar.
- [ ] **Step 5:** Fly reference deployment when the CLI is installed and logged in: the README's four commands.

## Self-review

**Spec coverage.** C configuration and validation (T1), EVM signer with conformance (T2), store/executor/telemetry (T3), agent port with HTTP + MCP + healthz, admin port with token and every route, readiness rule, lifecycle with flush (T4), D image and compose (T5), E workflows (T5), F guide, checklist, limits, dashboard, Fly (T6), G release (T8). Non-goals untouched.

**Placeholder scan.** Every code step carries its code. Conditional notes name the exact file to read when an installed package's signature could differ (`X402ExecutorOptions.toMoney`, `AuthorizeRequest`, `approve` return type, MCP `server.tool` form). Task 5 step 2 states honestly what cannot be validated on this machine.

**Type consistency.** `Config.executor` shape is shared by `config.ts`, `executor.ts`, and the tests. `OpenedStore` exposes `pending`, `degraded`, `flush`, `close` used by `app.ts` and `admin-server.ts`; `instrumentBroker(..., { store })` receives it as `StoreHealthLike`. `App.ready()` returns `Readiness` consumed by the admin server. `EvmSigner` implements `X402Signer.sign(reqs, ctx)` from purse 0.4.0. Test helpers use `SqlClient` from receipt 0.2.0.
