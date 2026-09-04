# Broker image design (approved 2026-09-04)

## Goal

Make Purse enforcement mode deployable by a partner in under an hour from the docs alone. Phase 0 of the Deadlatch roadmap, items "Broker deployment story" and "Observability on by default". Definition of done: `docker run` the broker against Postgres, route a spend, get a receipt, verify it, see it in Grafana, by someone who is not the author.

Decisions taken by ARABA on 2026-09-04: the image runs **both** the HTTP transport and an MCP endpoint; the executor is **mock by default and x402 by env, with a real EVM signer included**; the principal surface is a **second, token-protected port**.

## Two plans, one spec

1. **Libraries** (this spec, sections A and B): the x402 module moves from examples into `@olurabian/purse` (0.4.0) as a dependency-free subpath, and `@olurabian/deadlatch-otel` (0.2.0) gains `instrumentBroker` with spans and metrics. Both publish before the image so the image depends on registry versions from its first commit.
2. **Image** (sections C to G): the app, the EVM signer, the Dockerfile, CI to GHCR, the deploy guide, the Grafana dashboard, and the Fly configuration for the reference deployment.

## A. x402 module in Purse (0.4.0)

`src/x402/` with `index.ts` exporting `X402Executor`, `X402ExecutorOptions`, `PaymentRequirements`, `X402Signer`, `MockSigner`, `startMock402`, `Mock402Options`. Published as the subpath `@olurabian/purse/x402`. Still zero runtime dependencies (node:http only).

`PaymentRequirements` is widened to what the official v1 client reads:

```ts
export interface PaymentRequirements {
  scheme: string;                 // "exact"
  network: string;                // "base-sepolia" | "base" | "mock"
  maxAmountRequired: string;      // atomic units of `asset`
  payTo: string;
  asset: string;                  // token contract, or "USD-cents" in the mock
  resource: string;
  maxTimeoutSeconds?: number;     // validity window; official default 60 when absent
  extra?: { name?: string; version?: string }; // EIP-712 domain name/version for `asset`
}
export interface X402Signer {
  sign(reqs: PaymentRequirements, ctx: { x402Version: number }): Promise<string>;
}
```

The executor passes the 402 body's `x402Version` (default 1) to the signer. Everything else in the executor is unchanged. Examples and tests import from `../src/x402/index.js`. The examples README keeps the Base Sepolia section but points at the image for the live path.

## B. Broker instrumentation in deadlatch-otel (0.2.0)

```ts
export interface BrokerLike {
  request(req: unknown): { decision: string; reason?: string; grantId?: string; pendingId?: string };
  execute(grantId: string): Promise<{ status: string; reason?: string }>;
  approve?(pendingId: string): unknown;
  deny?(pendingId: string): unknown;
  pending?(): unknown[];
  verify(): VerifyResultLike;
}
export interface StoreHealthLike { pending?(): number; degraded?(): Error | null }
export function instrumentBroker<T extends BrokerLike>(broker: T, opts?: { tracerName?: string; meterName?: string; store?: StoreHealthLike }): T
```

Spans: `deadlatch.enforce.request` (attributes `purse.decision`, `purse.reason`, `purse.amount`, `purse.payee`, `purse.grant_id`, `purse.pending_id`; a denied decision sets span status ERROR, matching `instrumentPurse`), `deadlatch.enforce.execute` (`purse.grant_id`, `purse.status`; rejected or thrown sets ERROR), `deadlatch.enforce.approve` and `deadlatch.enforce.deny` (`purse.pending_id`). All carry `deadlatch.leg = enforce` and `deadlatch.package = purse`.

Metrics through `@opentelemetry/api` metrics, so any SDK the host installs collects them: counters `deadlatch.purse.decisions` (attribute `decision`) and `deadlatch.purse.executions` (attribute `status`); observable gauges `deadlatch.purse.approvals.pending`, `deadlatch.purse.store.pending`, `deadlatch.purse.store.degraded` (0 or 1), registered only when the source method exists. Prometheus names after OTLP export: `deadlatch_purse_decisions_total`, `deadlatch_purse_executions_total`, `deadlatch_purse_approvals_pending`, `deadlatch_purse_store_pending`, `deadlatch_purse_store_degraded`.

Tests use `InMemorySpanExporter` and `InMemoryMetricExporter` against a real `Broker` with a `MockExecutor`.

## C. The app

`deploy/broker/` inside the purse repo, its own `package.json` (private, ESM, Node 22). Runtime dependencies: `@olurabian/purse ^0.4.0`, `@olurabian/receipt ^0.2.0`, `@olurabian/deadlatch-otel ^0.2.0`, `pg`, `@modelcontextprotocol/sdk`, `zod`, `viem`, `@opentelemetry/api`, `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/exporter-metrics-otlp-http`. Dev: `@electric-sql/pglite`, `x402` (conformance oracle only), `@types/pg`, `tsx`, `typescript`. `.npmrc ignore-scripts=true` and an allow-scripts allowlist like every other repo.

**Configuration (env).** Policy: `PURSE_CURRENCY` (default USD), `PURSE_MAX_PER_ACTION`, `PURSE_MAX_PER_DAY`, `PURSE_REQUIRE_APPROVAL_OVER`, `PURSE_ALLOW`, `PURSE_DENY` (comma lists), `PURSE_GRANT_TTL_MS`. Store: `DATABASE_URL` (required) and `PURSE_STREAM` (default `purse`); `PURSE_STORE=jsonl` with `PURSE_AUDIT_FILE` is a development escape hatch that logs a warning. Ports: `PURSE_AGENT_PORT` (8080), `PURSE_ADMIN_PORT` (8081), `PURSE_BIND` (0.0.0.0). Admin: `PURSE_ADMIN_TOKEN` (required, at least 24 characters). Executor: `PURSE_EXECUTOR=mock|x402`; for x402 `PURSE_X402_RESOURCES` (JSON object payee → resource URL), `PURSE_X402_SIGNER=mock|evm`, `PURSE_X402_NETWORK=base-sepolia|base|mock`, `PURSE_X402_PRIVATE_KEY` or `PURSE_X402_KEY_FILE` (file wins; never logged), `PURSE_X402_ALLOW_MAINNET=1` required for `base`. Readiness: `PURSE_MAX_PENDING` (100). Telemetry: the standard `OTEL_EXPORTER_OTLP_*` variables; telemetry starts only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. A misconfiguration is a fatal, specific error at boot, never a default.

**Agent port.** `POST /request`, `POST /execute`, `POST /status` (same wire shapes as `serveHttp`), `POST /mcp` (streamable HTTP, stateless, one transport per request) exposing tools `request_spend`, `execute_spend`, `spend_status` on the enforcing broker, and `GET /healthz`. No secrets, no principal methods.

**Admin port.** Every route except `/healthz` requires `Authorization: Bearer <PURSE_ADMIN_TOKEN>` (constant-time compare). `GET /pending`, `POST /approve {pendingId}`, `POST /deny {pendingId}`, `GET /verify` → `{ ok, brokenAt?, id?, reason?, records, pending, degraded }`, `GET /audit?since=<ISO>` → receipts, `GET /readyz` → 200 only when the store opened, the chain verified at boot, `degraded()` is null, and `pending() < PURSE_MAX_PENDING`; otherwise 503 with the reason.

**Executor.** `mock` → `MockExecutor`. `x402` → `X402Executor` with `resolvePayee` from `PURSE_X402_RESOURCES`, `toMoney` converting 6-decimal USDC atomic units to cents (`atomic / 10^4`, must divide exactly, currency must be USD) for real networks and the mock's minor units for `mock`, and a signer per `PURSE_X402_SIGNER`.

**EVM signer.** viem `privateKeyToAccount`. Domain `{ name: reqs.extra.name, version: reqs.extra.version, chainId, verifyingContract: reqs.asset }` with chainId from the network (`base-sepolia` 84532, `base` 8453); refuses a challenge without `extra.name` and `extra.version`. Message `{ from, to: payTo, value: maxAmountRequired, validAfter: now - 600, validBefore: now + (maxTimeoutSeconds ?? 60), nonce: 32 random bytes as hex }`, types `TransferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)`. Header is base64 of `JSON.stringify({ x402Version, scheme, network, payload: { signature, authorization: { from, to, value, validAfter, validBefore, nonce } } })` with numeric fields as decimal strings. Exposes `address` so readiness can report where to send test funds. Conformance test: for the same key and challenge, our header and the official `x402` client's header decode to the same structure, and both signatures verify with viem's `verifyTypedData` under the same domain, types, and message.

**Lifecycle.** `createApp(config, overrides?)` returns `{ start, stop, broker, store }`; overrides let tests inject a `SqlClient` (PGlite) and an executor. `stop()` closes both servers, awaits `broker.flush()`, shuts telemetry down, ends the pool. `main.ts` wires SIGTERM and SIGINT to `stop()`.

## D. Image and compose

Multi-stage Dockerfile at `deploy/broker/Dockerfile` on `node:22-alpine`: install with scripts off, build, prune dev dependencies, run as a non-root user, `EXPOSE 8080 8081`, `HEALTHCHECK` on the admin `/healthz`, `CMD ["node", "dist/main.js"]`. `deploy/broker/compose.yaml` runs `postgres:16-alpine` and the broker with the mock executor and a generated admin token, publishing 8080 and 8081 on localhost only.

## E. CI

`.github/workflows/image.yml`: on tags `broker-v*` and manual dispatch, build with buildx and push `ghcr.io/arabiananalyst/purse-broker:<version>` and `:latest` using the workflow token (`permissions: packages: write`). `ci.yml` gains a job that installs and tests `deploy/broker` on every push.

## F. Docs and dashboard

`deploy/README.md` is the walkthrough: compose up, the env table, curl a spend and its receipt, trigger an approval and approve it on the admin port, `GET /verify`, point `OTEL_EXPORTER_OTLP_*` at Grafana Cloud, import `deploy/grafana/purse-broker.json`, what each panel means. It carries the deployment checklist from the threat model with network placement: the agent port reachable only from the agent's network, the admin port only from operators, the signer key only in the image's environment or secret file, no rail credential anywhere near the agent. It states the known limits: single replica, open grants and pending approvals live in memory and do not survive a restart, memory grows with the stream, the signer holds one key.

`deploy/grafana/purse-broker.json`: decisions per minute by outcome, denial ratio, executions by status, pending approvals, store pending and degraded, and a traces panel filtered to `service.name = purse-broker`.

`deploy/fly.toml`: the reference deployment, agent port public, admin port private (reached via `fly proxy`), health check on 8080 `/healthz`. The actual deploy waits on the Fly CLI login.

## G. Release

Plan 1 publishes purse 0.4.0 then deadlatch-otel 0.2.0, whose dev dependency moves to purse 0.4 first. Plan 2 pushes the app, tags `broker-v0.1.0`, CI pushes the image, and the definition of done is run locally against the published image (Docker Desktop required on this machine, not yet installed). A live Base Sepolia settlement needs a funded testnet wallet, provided by ARABA when ready; the conformance test covers the signature until then.

## Non-goals

Multi-replica or shared grant state, TLS termination (the platform does it), rate limiting, a web UI, the x402 v2 protocol generation (`@x402/*` 2.x), Solana, and the hosted Witness.
