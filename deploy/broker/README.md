# Purse broker

Purse enforcement mode as a container. An agent asks the broker for a spend, the broker decides against policy, performs the payment itself, and writes a hash-chained receipt to Postgres that anyone can verify without trusting the broker. Four ports, agent, admin, witness and monitor. The agent port speaks HTTP and MCP and holds no secret. The admin port takes a bearer token and is for the principal.

## Run it in under an hour

You need Docker and a terminal. Grafana Cloud is optional and takes five extra minutes.

0. Get the code, or just the image.

```bash
git clone https://github.com/ArabianAnalyst/purse.git && cd purse/deploy/broker
```

Only have the image? Point it at your own Postgres and skip straight to routing a spend.

```bash
docker run -e DATABASE_URL=... -e PURSE_ADMIN_TOKEN=... -e PURSE_MAX_PER_ACTION='$50' -e PURSE_ALLOW=api.stripe.com \
  -p 127.0.0.1:8080:8080 -p 127.0.0.1:8081:8081 ghcr.io/arabiananalyst/purse-broker:0.3.0
```

1. Start it.

```bash
export PURSE_ADMIN_TOKEN=$(openssl rand -hex 24)
docker compose up --build
```

Using PowerShell instead of bash? Generate the token this way.

```powershell
$env:PURSE_ADMIN_TOKEN = -join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
```

The broker is up when it prints its two URLs. Postgres holds the receipts. The executor is the mock, which "pays" and returns a receipt, so no money moves.

2. Route a spend from the agent side.

```bash
curl -s localhost:8080/request -H 'content-type: application/json' \
  -d '{"amount":"$12.50","payee":"api.stripe.com","intent":"credits"}'
```

You get a decision. When it is `allowed` it carries a single-use `grantId`. Pull it straight out of the response instead of copying it by hand, with `jq` or with plain Node when `jq` is not installed.

```bash
curl -s localhost:8080/request -H 'content-type: application/json' \
  -d '{"amount":"$12.50","payee":"api.stripe.com","intent":"credits"}' | jq -r .grantId
curl -s localhost:8080/request -H 'content-type: application/json' \
  -d '{"amount":"$12.50","payee":"api.stripe.com","intent":"credits"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).grantId'
```

The same trick pulls `pendingId` out of the held response in step 3, just swap the field name. Redeem the grant.

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
curl -s localhost:8080/execute -H 'content-type: application/json' -d '{"grantId":"<grantId>"}'
```

The agent asked. It could not approve itself. The principal approved on a port the agent cannot reach.

4. Verify the chain.

```bash
curl -s localhost:8081/verify -H "authorization: Bearer $PURSE_ADMIN_TOKEN"
```

`ok` true means every receipt recomputes and every link holds. `pending` is how many receipts are queued but not yet committed, and `degraded` is null while the store is healthy. Verify independently with twenty lines of plain SHA-256, the recipe is in the [receipt package](https://www.npmjs.com/package/@olurabian/receipt) README.

`/readyz` on the admin port is the one an operator polls before routing traffic. `/healthz` on 8081 stays open without a token so the container health check can reach it even from inside the network the agent cannot see.

5. See it in Grafana.

Set the two OpenTelemetry variables for your Grafana Cloud stack and restart, in the same shell that still holds `PURSE_ADMIN_TOKEN`.

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
| `WITNESS_STREAM` | `PURSE_STREAM` or `purse` | The stream the witness anchors. One witness per stream. |
| `WITNESS_KEY_FILE` | | PEM file with the witness's P-256 key. Created on first run when absent. |
| `WITNESS_KEY_PEM` | | The key as a PEM string, for a secret store. The file wins when both are set. `node dist/witness.js keygen` prints one. |
| `WITNESS_TRUSTED_KEYS` | | Comma-separated public keys of earlier witness keys, so anchors they signed still count after a rotation. |
| `REKOR_URL` | `https://log2025-1.rekor.sigstore.dev` | The Rekor v2 instance. It rotates by year, so treat it as configuration. |
| `REKOR_LOG_KEY` | required for the witness | `<origin>=<base64 SPKI DER>`, the log's Ed25519 key from Sigstore's trust root. See "The witness". |
| `REKOR_TIMEOUT_MS` | `30000` | Per submission. The log answers in a few seconds; the client guide asks for at least twenty. |
| `WITNESS_INTERVAL_MS` | `300000` | How often the witness checks the head. |
| `WITNESS_MAX_LAG` | `2` | Intervals the witness may fall behind before readiness goes red. |
| `WITNESS_PORT` | `8082` | The witness port, read-only, no token. |
| `WITNESS_BIND` | `0.0.0.0` | Bind address for the witness port. |
| `MONITOR_STREAM` | `PURSE_STREAM` or `purse` | The stream the monitor reads. One monitor per stream. |
| `MONITOR_INTERVAL_MS` | `60000` | How often the monitor reads new receipts. |
| `MONITOR_WINDOW` | `500/24h` | The sliding window, `<count>/<duration>` with the duration in `m`, `h` or `d`. |
| `MONITOR_VELOCITY` | `5/10m` | The `payee-velocity` threshold, `<count>/<duration>`. |
| `MONITOR_MAX_BEHIND` | `2500` | Readiness goes red when the cursor is more than this many receipts behind the chain head. `0` switches the check off. |
| `MONITOR_DISABLE` | | Comma-separated built-in ids to switch off. |
| `MONITOR_EXPECTATIONS` | | Path to an ES module whose default export is an array of expectations. |
| `DEADLATCH_URL` | `https://www.deadlatch.dev` | Where flags and heartbeats go. |
| `DEADLATCH_PROJECT_KEY` | | The project key from the dashboard. Unset means flags go to the file instead. |
| `MONITOR_FLAGS_FILE` | `/data/flags.jsonl` | The local sink when no key is set. |
| `MONITOR_PORT` | `8083` | The monitor port, read-only, no token. |
| `MONITOR_BIND` | `0.0.0.0` | Bind address for the monitor port. |
| `PURSE_CURRENCY` | `USD` | Policy currency. Must be USD for x402 on a real network. |
| `PURSE_MAX_PER_ACTION` | | Cap per spend, for example `$50`. |
| `PURSE_MAX_PER_DAY` | | Rolling daily cap. Open grants reserve budget. |
| `PURSE_REQUIRE_APPROVAL_OVER` | | Spends above this wait for the principal. |
| `PURSE_ALLOW_OPEN_POLICY` | | Must be `1` to boot with no allowlist and no per-action cap. |
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
| `PURSE_X402_ASSET` | USDC for the network | Override the token contract the broker will pay in. Challenges naming any other asset, network, or scheme are refused. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | | Telemetry starts only when set. Standard OpenTelemetry variables apply. |

A wrong or missing value is a specific error at boot. The broker never falls back to a default that would hide a mistake.

## Settling real money over x402

Set `PURSE_EXECUTOR=x402`, map payees to resource URLs, and give the broker a wallet key through a mounted file. On `base-sepolia` the broker signs an EIP-3009 authorization only when the challenge names the configured network, the exact scheme, and the pinned USDC contract, and refuses anything else, in the exact form the official x402 client produces, and sends it as the payment header. The signer's address is printed at boot so you can fund it. `base` is mainnet and needs `PURSE_X402_ALLOW_MAINNET=1`.

The key exists in the broker's process and nowhere else. Not in the agent. Not in a prompt. Not on the agent port.

## The witness

A hash chain in the broker's own database is tamper-evident to the operator and meaningless to everyone else, because whoever holds the whole log can rebuild it. The witness closes that. It is a second process on the same image, `node dist/witness.js`, that reads the receipt stream every five minutes, verifies the chain, and when the head has moved, signs the head with its own key and submits it to Rekor, Sigstore's public transparency log. The log's reply, an inclusion proof and a signed checkpoint, is verified before it is stored beside the receipts in an `anchors` table, and served read-only on the witness port.

What an anchor proves. Everything at or below the anchored position is what it was when the public log recorded the head. A rewrite there breaks the anchor and is named by position. A truncation there is a missing record and is named too. Order is proven by the log index. Wall-clock time is not, the `at` field is the witness's clock.

Two keys make it meaningful, and neither comes from this image.

1. The log key. Sigstore publishes it in the `sigstore/root-signing` repository, `targets/trusted_root.json`, in the `tlogs` entry whose `baseUrl` is your `REKOR_URL`, field `publicKey.rawBytes`. This prints it in the form `REKOR_LOG_KEY` takes.

```sh
curl -sL https://raw.githubusercontent.com/sigstore/root-signing/main/targets/trusted_root.json \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const t=JSON.parse(d).tlogs.find(t=>t.baseUrl.includes("log2025-1"));console.log(new URL(t.baseUrl).host+"="+t.publicKey.rawBytes)})'
```

   The witness computes the key's C2SP id and refuses to start on anything that is not an Ed25519 key. The `validFor` window on that entry is what lets old anchors verify after the log rotates.

2. The witness key. Generated on first run into `WITNESS_KEY_FILE`, or made once with `node dist/witness.js keygen` and stored as `WITNESS_KEY_PEM`. The public key is printed at start and served on `GET /`. Pin it the way you pin an SSH host key. A rotated witness is a new key; old anchors stay valid under the old one because each anchor carries the key that signed it. Put the old key in `WITNESS_TRUSTED_KEYS` so its anchors still count on `/verify` and toward readiness. The file wins over `WITNESS_KEY_PEM` only when it already exists; when `WITNESS_KEY_FILE` is set but the file is absent and a pem is also given, the witness uses the pem and does not write the file.

Run it with compose. `REKOR_LOG_KEY` is the one variable compose will not default for you.

```sh
export REKOR_LOG_KEY="$(curl -sL https://raw.githubusercontent.com/sigstore/root-signing/main/targets/trusted_root.json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const t=JSON.parse(d).tlogs.find(t=>t.baseUrl.includes("log2025-1"));console.log(new URL(t.baseUrl).host+"="+t.publicKey.rawBytes)})')"
docker compose up --build
curl -s http://127.0.0.1:8082/            # the witness's public key, the log it uses, and the exact verify command
curl -s http://127.0.0.1:8082/verify      # verifyAnchored over the live chain, with coveredUpTo
curl -s http://127.0.0.1:8081/verify -H "authorization: Bearer $PURSE_ADMIN_TOKEN"   # the broker's view, now with anchoredUpTo
```

The check a sceptic runs, with nothing from the operator beyond the two public keys and the chain. `npx receipt-verify` is the verifier from `@olurabian/receipt`, a package they can read.

```sh
curl -s http://127.0.0.1:8081/audit -H "authorization: Bearer $PURSE_ADMIN_TOKEN" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.stringify(JSON.parse(d).receipts)))' > chain.json
npx receipt-verify chain.json --anchors http://127.0.0.1:8082 --log-key "$REKOR_LOG_KEY" --witness-key <public key from GET /> --stream purse
```

Exit 0 means the chain verifies and at least one anchor holds. Rewrite a receipt in `chain.json` and run it again, and the output names the position.

Readiness on the witness port, `GET /readyz`, is 200 only when the last tick verified the chain within `WITNESS_MAX_LAG` intervals and the head is anchored or the last anchor is younger than that window. A broken chain, a log that will not answer, or a stalled tick all turn it red, and `GET /events` says which. `GET /events` pages by `since` in chunks of one thousand, so a long history takes more than one call to walk. The witness reads `receipts` and writes only `anchors` and `witness_events`; nothing on its port can change anything.

Limits. One witness per stream, a second one on the same stream records a conflict and stops anchoring. The public log's instance URL rotates by year; when it does, set `REKOR_URL` and `REKOR_LOG_KEY` to the new one and old anchors still verify against the old key. Time is not proven by an anchor, only order.

## The monitor

The broker enforces what an agent may spend. The monitor watches what it did. It is a third process on the same image, `node dist/monitor.js`, that reads new receipts every minute, judges each one once against a sliding window with deterministic expectations, and pushes only the flags to a Deadlatch project, or to a local file when no project key is set. It never writes to the receipts table and never blocks an action.

Four expectations are built in, each defined only over fields the chain carries.

| id | fires when |
|---|---|
| `executed-without-grant` | an `executed` receipt names a grant the window never saw minted, or no grant at all |
| `executed-once` | two `executed` receipts in the window share a grant |
| `paid-matches-decision` | the rail settled more than the minted decision allowed, or in another currency |
| `payee-velocity` | the same payee was executed `MONITOR_VELOCITY` times or more inside its duration, default `5/10m` |

The window must be at least as long as a grant lives, and hold more receipts than the broker writes in that time, for the first rule to mean anything. A grant lives `PURSE_GRANT_TTL_MS`, fifteen minutes by default, and a broker writes about two receipts per request, so raise the count in `MONITOR_WINDOW` on a busy stream. `MONITOR_WINDOW` defaults to `500/24h`, five hundred receipts or one day, whichever ends first. Switch a built-in off by naming it in `MONITOR_DISABLE`. Add your own by pointing `MONITOR_EXPECTATIONS` at an ES module whose default export is an array of expectations, the same shape `@olurabian/tripwire` scans with. An id that collides with a built-in is a boot error.

Three lines connect it to a Deadlatch project. The project's settings page prints them with the key filled in.

```sh
DEADLATCH_URL=https://www.deadlatch.dev
DEADLATCH_PROJECT_KEY=dl_live_...
MONITOR_STREAM=purse
```

Without a key the monitor still runs. Flags go to `MONITOR_FLAGS_FILE`, one JSON line each. With or without a key, every flag is written to the `monitor_flags` table beside the receipts before any push, and `GET /flags` on the monitor port serves them. The cursor lives in `monitor_cursor` and moves only after every held flag was confirmed, so a hosted outage delays flags and never loses them.

```sh
curl -s http://127.0.0.1:8083/            # what it watches, the key prefix, the cursor, the last tick and push
curl -s http://127.0.0.1:8083/flags       # flags this monitor stored, oldest first, at most a thousand, page with ?since=<n>
curl -s http://127.0.0.1:8083/readyz      # Readiness on the monitor port, `GET /readyz`, is 200 when the last tick succeeded within three intervals, the last push succeeded or there was nothing to push, and the cursor is within `MONITOR_MAX_BEHIND` of the head.
```

To see a flag on a fresh broker, trip the velocity rule through the agent port. Five spends of `$12.50` to `api.stripe.com` clear every default policy gate and land inside ten minutes, so the fifth execution flags `payee-velocity` on the next tick.

```sh
for i in 1 2 3 4 5; do
  grantId=$(curl -s localhost:8080/request -H 'content-type: application/json' \
    -d '{"amount":"$12.50","payee":"api.stripe.com","intent":"credits"}' | jq -r .grantId)
  curl -s localhost:8080/execute -H 'content-type: application/json' -d "{\"grantId\":\"$grantId\"}"
done
sleep 60
curl -s http://127.0.0.1:8083/flags
```

`GET /events` names what went wrong, a skipped row, a failed or rejected push, a revoked key. A revoked or unknown key stops the monitor; fix the key and restart it.

Limits. The monitor reads at most five hundred receipts per tick. `GET /` shows `headSeq` and `behind`, and readiness goes red once `behind` passes `MONITOR_MAX_BEHIND`, so a stream that grows faster than the monitor reads is visible, not silent. Judgment is per record against the window, a receipt the window has already seen is never judged again, and a rule that needs history older than the window cannot fire. Flags beyond the hosted sink's queue of a thousand in one tick are dropped from delivery with a `dropped` event and stay in `monitor_flags`, which a monitor attached to a long existing chain should expect on its first ticks. The monitor is not part of proof. The witness is.

## Where each port may be reached from

The enforcement property only holds under the deployment contract in the Purse threat model. In network terms it comes to this.

- The agent port is reachable from the agent's network and from nowhere else. It carries no secret, but it is the only door to money, so it should not face the public internet without your own gateway in front.
- The admin port is reachable from operators only. Never from the agent's network. A leaked token here is a full compromise, so rotate it like a password.
- The wallet key reaches the broker as a mounted secret. Nothing in the agent's runtime holds a rail credential.
- The agent has no other payment tool and no direct access to the rail. If it can pay some other way, the broker is not a boundary, it is a suggestion.
- The witness port is reachable by operators and by anyone you want to be able to verify, since it is read-only and holds nothing secret. Still, put it behind your own network boundary unless you mean to publish it.
- The monitor port is read-only like the witness port. It shows the first eight characters of the project key after `dl_live_` and nothing else secret. Same rule, your own boundary unless you mean to publish it.

## Known limits

Single replica. Open grants and spends waiting for approval live in memory and do not survive a restart. The audit chain does. The whole receipt stream is loaded into memory at boot, so memory and start-up time grow with the stream. One wallet key per broker. If the process dies before a queued receipt commits, the receipts still counted as pending are lost, which a verifier cannot distinguish from a deliberate truncation, so anchor the chain head if that matters to you. Telemetry is off until an endpoint is set.

The payment that latches the store has usually already settled by the time the broker reports the failure. The grant is consumed, the outcome receipt is in memory only, and the agent sees a 503.

Run one broker per `PURSE_STREAM`. A second broker on the same stream is a fork, the database refuses it, and that broker stops. Deploy with replace, not rolling.

Nothing caps the request body or the request rate; the stream grows with every request, so put your own gateway in front of the agent port.

## Backups and restore

Receipts are the one thing in this deployment that cannot be regenerated. Open grants and pending approvals live in memory and are lost on restart by design (see Known limits), so the database is the whole recovery story.

**Two layers.**

1. **Volume snapshots.** Fly snapshots the Postgres volume daily. Set the retention to fourteen days once per volume, with `flyctl volumes update <volume id> -a <db app> --snapshot-retention 14`. List them with `flyctl volumes snapshots list <volume id>`. To recover a whole database, create a new Postgres app from a snapshot with `flyctl postgres create --snapshot-id <id>` and re-attach it to the broker. Recovery point up to twenty-four hours, recovery time a few minutes.
2. **A logical dump you hold yourself.** The table dumps as plain SQL with one INSERT per receipt, which restores into any Postgres, including the embedded one the restore check below uses. This pulls it from outside the machine, without a tunnel.

```sh
flyctl machine exec <db machine id> -a <db app> \
  "sh -c 'PGPASSWORD=$OPERATOR_PASSWORD pg_dump -h localhost -U postgres -d <database> -t receipts --no-owner --no-privileges --inserts'" \
  > receipts-$(date +%F).sql
```

The password is read from the machine's own environment and never leaves it. Keep the dump somewhere that is not Fly. Weekly is enough while the stream is small.

**The restore check.** A backup that has not been restored is a guess. This restores a dump into an embedded Postgres and runs the same chain verification `/verify` runs, in a fresh database, on your machine.

```sh
node scripts/restore-verify.mjs receipts-2026-09-07.sql purse
```

It prints the number of receipts restored, the head hash, and the verify result, and exits non-zero if the chain does not verify or the stream is empty. Compare the count with the live `/verify` and the head hash with the last receipt. Run it after every dump, and file the output next to the dump.

## Reference deployment on Fly

`fly.toml` runs the agent port publicly and keeps the admin port private. Set the secrets once, then deploy.

```bash
flyctl apps create purse-broker
flyctl postgres create --name purse-broker-db --region lhr --vm-size shared-cpu-1x --initial-cluster-size 1 --volume-size 1
flyctl postgres attach purse-broker-db -a purse-broker
flyctl secrets set -a purse-broker PURSE_ADMIN_TOKEN=... WITNESS_KEY_PEM="$(docker run --rm ghcr.io/arabiananalyst/purse-broker:0.3.0 node dist/witness.js keygen)" REKOR_LOG_KEY=... OTEL_EXPORTER_OTLP_ENDPOINT=... OTEL_EXPORTER_OTLP_HEADERS=... OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
flyctl deploy --config fly.toml -a purse-broker --image ghcr.io/arabiananalyst/purse-broker:0.3.0 --ha=false
```

`--ha=false` matters. Fly's default first deploy creates two machines, and two brokers on one stream is a fork the database will refuse. The attach step sets `DATABASE_URL` for you. `flyctl deploy` creates one machine per process group in `[processes]`, so this same deploy also starts the witness.

Why `WITNESS_KEY_PEM` is a secret rather than a mounted file on Fly. Fly volumes mount root-owned, and the image runs as a non-root user, so the witness process cannot write a key file onto one. Fly secrets are app-wide, so the broker machines receive `WITNESS_KEY_PEM` too, though the broker never reads it. An operator who wants the key on the witness machines alone can run the witness as its own Fly app, with the same image and the same command, and set the secret there instead.

The same deploy starts the monitor on its own machine. Until `DEADLATCH_PROJECT_KEY` is set it writes flags to its own machine and to the `monitor_flags` table, and `GET /flags` on port 8083 serves them. `flyctl secrets set DEADLATCH_PROJECT_KEY=... -a purse-broker` connects it to a project and Fly restarts the machines.

The admin port is not exposed. Reach it through a WireGuard proxy, `flyctl proxy 8081:8081 -a purse-broker`, which on Windows needs an elevated terminal. Without one, run the admin call inside the machine instead.

```bash
flyctl machine exec <machine-id> -a purse-broker "wget -qO- --header='authorization: Bearer $PURSE_ADMIN_TOKEN' http://127.0.0.1:8081/verify"
```

The witness port is not exposed either. Reach it the same way, on the witness machine.

```bash
flyctl machine exec <witness machine id> -a purse-broker "wget -qO- http://127.0.0.1:8082/verify"
```

And the monitor port, on the monitor machine.

```bash
flyctl machine exec <monitor machine id> -a purse-broker "wget -qO- http://127.0.0.1:8083/"
```

## Image

`ghcr.io/arabiananalyst/purse-broker:<version>` is built by GitHub Actions on every `broker-v*` tag from `deploy/broker/Dockerfile`, multi-stage, non-root, with a health check on the admin port.
