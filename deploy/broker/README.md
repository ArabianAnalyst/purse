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
