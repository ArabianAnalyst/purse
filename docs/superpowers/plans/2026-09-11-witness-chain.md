# Witness serves the chain, purse-broker 0.3.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the witness port a read-only `GET /chain` route so anyone can fetch the receipts it anchors, commit the playground broker's Fly configuration, and release purse-broker 0.3.2.

**Architecture:** The witness app already loads the whole stream for its verify tick through a private `records()` read. A new `chain(since, limit)` method on the `Witness` interface slices that read and returns the slice with the stream length and the current head. The server maps `/chain` onto it with query validation, and offers the same slice as `application/x-ndjson` so `npx receipt-verify` can consume it straight from curl. The playground configuration is a second Fly manifest beside the reference one, same image, its own stream and policy, witness port public.

**Tech Stack:** Node 22, TypeScript strict, `node:test` through `tsx`, PGlite in tests, `@olurabian/receipt` 0.3.0, Fly, GitHub Actions image build on `broker-v*` tags.

**Spec:** `SaaS/deadlatch/docs/superpowers/specs/2026-09-11-playground-design.md`, Part 1. The spec names a CHANGELOG entry; the broker has no changelog file and earlier broker releases never created one, so the release notes go in the annotated tag and the README, which is where 0.3.0 and 0.3.1 put theirs.

## Global Constraints

- Repository `SaaS/purse`, branch `witness-chain` from `main` at fe4c7d5. Never stage `docs/launch-x402.md`, it is an untracked local file that stays local.
- Broker code lives in `deploy/broker`. Run `npm test`, `npm run typecheck` and `npm run build` there. Tests are `node:test` through `tsx --test test/*.test.ts` with `assert/strict`.
- `GET /chain` is read-only, no token, no CORS headers. `since` is the 0-based position in the stream, the same number the anchors call `seq`. Default 0. Non-integer, below -1, or unsafe answers 400 `{ error: "since must be a non-negative integer seq" }`. `limit` defaults to 100, is clamped to 500, and zero, negative or non-integer answers 400 `{ error: "limit must be a positive integer" }`. `format` is `json` (default) or `jsonl`, anything else answers 400 `{ error: "format must be json or jsonl" }`.
- JSON response shape, exactly `{ stream, total, head, since, count, records }`. `head` is `{ seq, hash }` of the last record or `null` on an empty stream. `records` are the stored envelopes verbatim, oldest first.
- jsonl response, `content-type: application/x-ndjson`, one envelope per line, a trailing newline after the last line, empty body on an empty slice. Key order of each line is the stored order, `id, ts, kind, payload, prevHash, hash`.
- The records come from the same read the verify tick uses. No second query.
- Version 0.3.2 in `deploy/broker/package.json` and `package-lock.json`, and every `purse-broker:0.3.1` string in `deploy/broker/README.md` becomes `0.3.2`.
- The playground manifest is `deploy/broker/fly.playground.toml`, app `purse-playground`, streams `playground`, policy `$50` per action, `$5000` per day, approval over `$20`, allow `api.stripe.com`, `MONITOR_INTERVAL_MS` `15000`, witness port public on external port 8082 with `tls` and `http` handlers, admin and monitor ports private.
- No colons and no em dashes in README prose. Inline code is exempt. No counterparty names anywhere.
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never run `git clean`, `git checkout --`, `git reset`, or `git stash`.
- Release only on ARABA's go, through the protected flow, push `HEAD:release/witness-chain`, wait for the `test`, `broker` and `gitleaks (secrets)` checks, fast-forward `main`, delete the branch, then the annotated tag.

---

## File map

| File | Responsibility |
|---|---|
| `deploy/broker/src/witness-app.ts` | `chain(since, limit)` on the `Witness` interface, sliced from `records()` |
| `deploy/broker/src/witness-server.ts` | The `/chain` route, index listing, `verifyWith` command |
| `deploy/broker/test/witness-server.test.ts` | Route tests, order, cap, validation, jsonl, empty stream |
| `deploy/broker/fly.playground.toml` | The playground app manifest |
| `deploy/broker/README.md` | Route docs in "The witness", the "A playground broker" section, version strings |
| `deploy/broker/package.json`, `package-lock.json` | 0.3.2 |

---

### Task 1: `chain()` on the witness and `GET /chain` on its port

**Files:**
- Modify: `deploy/broker/src/witness-app.ts` (the `Witness` interface near line 31, the returned object near line 200)
- Modify: `deploy/broker/src/witness-server.ts` (index `routes` and `verifyWith`, the `switch`)
- Test: `deploy/broker/test/witness-server.test.ts`

**Interfaces:**
- Consumes: `records(): Promise<Receipt[]>` inside `createWitness`, `send(res, status, body)` from `./http.js`, the local `nonNegative` helper in the server, `seedReceipts(db, stream, n)`, `witnessCfg(rekor)`, `clock()`, `FakeRekor`, `listen` from the existing test.
- Produces: `Witness.chain(since?: number, limit?: number): Promise<ChainSlice>` where `ChainSlice = { total: number; head: { seq: number; hash: string } | null; since: number; records: Receipt[] }`, and the route described in Global Constraints. Task 2 documents both.

- [ ] **Step 1: Write the failing tests**

Append to `deploy/broker/test/witness-server.test.ts`, after the first test and before the `keygen` test:

```ts
test("GET /chain serves the receipts oldest first, with total and head, validated, and as jsonl", async () => {
  const db = new PGlite();
  await seedReceipts(db, "t", 7);
  const rekor = new FakeRekor();
  const c = clock();
  const signer = P256Signer.generate();
  const cfg = witnessCfg(rekor);
  const w = await createWitness(cfg, { sqlClient: db as unknown as SqlClient, fetch: rekor.fetch(), now: c.now, signer });
  const srv = await listen(createWitnessServer(w, cfg), 0, "127.0.0.1");
  try {
    const all = await get(`${srv.url}/chain`);
    assert.equal(all.status, 200);
    assert.equal(all.json.stream, "t");
    assert.equal(all.json.total, 7);
    assert.equal(all.json.since, 0);
    assert.equal(all.json.count, 7);
    const recs = all.json.records as { id: string; prevHash: string; hash: string }[];
    assert.deepEqual(recs.map((r) => r.id), ["id-0", "id-1", "id-2", "id-3", "id-4", "id-5", "id-6"]);
    assert.equal(recs[1]!.prevHash, recs[0]!.hash, "the slice is the chain, linked");
    assert.deepEqual(all.json.head, { seq: 6, hash: recs[6]!.hash });
    assert.deepEqual(Object.keys(recs[0]!), ["id", "ts", "kind", "payload", "prevHash", "hash"], "stored key order survives");

    const tail = await get(`${srv.url}/chain?since=5&limit=1`);
    assert.deepEqual((tail.json.records as { id: string }[]).map((r) => r.id), ["id-5"]);
    assert.equal(tail.json.since, 5);
    assert.equal(tail.json.count, 1);
    assert.equal(tail.json.total, 7);

    const past = await get(`${srv.url}/chain?since=99`);
    assert.equal(past.status, 200);
    assert.equal(past.json.count, 0);
    assert.equal(past.json.since, 7, "since is clamped to the stream length");

    assert.equal((await get(`${srv.url}/chain?limit=9999`)).json.count, 7, "a large limit is clamped, not rejected");

    for (const bad of ["since=x", "since=-2", "since=99999999999999999999", "limit=0", "limit=-1", "limit=x", "limit=1.5", "format=xml"]) {
      assert.equal((await get(`${srv.url}/chain?${bad}`)).status, 400, bad);
    }

    const jl = await fetch(`${srv.url}/chain?format=jsonl&since=4`);
    assert.equal(jl.status, 200);
    assert.equal(jl.headers.get("content-type"), "application/x-ndjson");
    const body = await jl.text();
    assert.ok(body.endsWith("\n"), "trailing newline");
    const lines = body.trim().split("\n");
    assert.equal(lines.length, 3);
    assert.equal((JSON.parse(lines[0]!) as { id: string }).id, "id-4");
    assert.equal(Object.keys(JSON.parse(lines[0]!) as object).join(","), "id,ts,kind,payload,prevHash,hash");

    const idx = await get(`${srv.url}/`);
    assert.ok(Object.keys(idx.json.routes as object).some((k) => k.startsWith("GET /chain")), "the index lists the route");
    assert.match(String(idx.json.verifyWith), /chain\?format=jsonl&limit=500/);
    assert.equal((await fetch(`${srv.url}/chain`, { method: "POST" })).status, 404);
  } finally {
    await srv.close();
    await w.close();
  }
});

test("GET /chain caps a slice at five hundred records", async () => {
  const db = new PGlite();
  await seedReceipts(db, "t", 502);
  const rekor = new FakeRekor();
  const c = clock();
  const cfg = witnessCfg(rekor);
  const w = await createWitness(cfg, { sqlClient: db as unknown as SqlClient, fetch: rekor.fetch(), now: c.now, signer: P256Signer.generate() });
  const srv = await listen(createWitnessServer(w, cfg), 0, "127.0.0.1");
  try {
    const a = await get(`${srv.url}/chain?limit=9999`);
    assert.equal(a.json.count, 500);
    assert.equal(a.json.total, 502);
    assert.equal((a.json.records as { id: string }[])[499]!.id, "id-499");
    const b = await get(`${srv.url}/chain?since=1&limit=600`);
    assert.equal(b.json.count, 500);
    assert.equal((b.json.records as { id: string }[])[0]!.id, "id-1");
    const last = await get(`${srv.url}/chain?since=500`);
    assert.equal(last.json.count, 2);
    assert.deepEqual(last.json.head, { seq: 501, hash: (last.json.records as { hash: string }[])[1]!.hash });
  } finally {
    await srv.close();
    await w.close();
  }
});

test("GET /chain on an empty stream", async () => {
  const db = new PGlite();
  await seedReceipts(db, "t", 0);
  const rekor = new FakeRekor();
  const c = clock();
  const cfg = witnessCfg(rekor);
  const w = await createWitness(cfg, { sqlClient: db as unknown as SqlClient, fetch: rekor.fetch(), now: c.now, signer: P256Signer.generate() });
  const srv = await listen(createWitnessServer(w, cfg), 0, "127.0.0.1");
  try {
    const r = await get(`${srv.url}/chain`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { stream: "t", total: 0, head: null, since: 0, count: 0, records: [] });
    const jl = await fetch(`${srv.url}/chain?format=jsonl`);
    assert.equal(jl.status, 200);
    assert.equal(jl.headers.get("content-type"), "application/x-ndjson");
    assert.equal(await jl.text(), "");
  } finally {
    await srv.close();
    await w.close();
  }
});
```

`seedReceipts(db, "t", 0)` opens the store and writes nothing, which is what an empty stream is.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd deploy/broker && npx tsx --test test/witness-server.test.ts`
Expected: the three new tests fail. The first on `assert.equal(all.status, 200)` receiving 404, because the route does not exist.

- [ ] **Step 3: Add `chain()` to the witness app**

In `deploy/broker/src/witness-app.ts`, add the slice type beside the other exported types near the top of the file, after `WitnessOverrides`:

```ts
export interface ChainSlice { total: number; head: { seq: number; hash: string } | null; since: number; records: Receipt[] }
```

Add the method to the `Witness` interface, after `verify()`:

```ts
  /** The receipts themselves, oldest first from `since` (0-based position), at most `limit`, clamped to 500. The same read the verify tick uses. */
  chain(since?: number, limit?: number): Promise<ChainSlice>;
```

Add the constant near `DEFAULT` values at the top of the file, or directly above `createWitness`:

```ts
/** The most records one GET /chain answers. */
export const CHAIN_LIMIT_MAX = 500;
```

In the object `createWitness` returns, after `verify`, add:

```ts
    async chain(since = 0, limit = 100) {
      const all = await records();
      const total = all.length;
      const head = total ? { seq: total - 1, hash: all[total - 1]!.hash } : null;
      const from = Math.min(Math.max(0, Math.trunc(since)), total);
      const take = Math.min(Math.max(1, Math.trunc(limit)), CHAIN_LIMIT_MAX);
      return { total, head, since: from, records: all.slice(from, from + take) };
    },
```

`Receipt` is already imported in this file for `records()`. If the compiler says otherwise, import the type from `@olurabian/receipt`.

- [ ] **Step 4: Add the route and the index lines to the server**

In `deploy/broker/src/witness-server.ts`, in the `routes` object of `index()`, add this line first:

```ts
        "GET /chain?since=<seq>&limit=<n>&format=<json|jsonl>": "the receipts themselves, oldest first from a 0-based position, at most five hundred, jsonl is the file the verifier reads",
```

Replace the `verifyWith` line with:

```ts
      verifyWith: `curl -s "<this url>/chain?format=jsonl&limit=500" > chain.jsonl && npx receipt-verify chain.jsonl --anchors <this url> --log-key ${cfg.rekor.logKey.origin}=<base64 DER from Sigstore's trust root> --witness-key ${s.publicKey} --stream ${s.stream}`,
```

In the `switch`, add a case before `case "/verify"`:

```ts
        case "/chain": {
          const since = nonNegative(url.searchParams.get("since"));
          if (since === null) return send(res, 400, { error: "since must be a non-negative integer seq" });
          const limitRaw = url.searchParams.get("limit");
          const limit = limitRaw == null || limitRaw === "" ? 100 : Number(limitRaw);
          if (!Number.isInteger(limit) || limit < 1) return send(res, 400, { error: "limit must be a positive integer" });
          const format = url.searchParams.get("format") ?? "json";
          if (format !== "json" && format !== "jsonl") return send(res, 400, { error: "format must be json or jsonl" });
          const c = await w.chain(Math.max(0, since), limit);
          if (format === "jsonl") {
            const text = c.records.map((r) => JSON.stringify(r) + "\n").join("");
            res.writeHead(200, { "content-type": "application/x-ndjson", "content-length": Buffer.byteLength(text) });
            return res.end(text);
          }
          return send(res, 200, { stream: cfg.stream, total: c.total, head: c.head, since: c.since, count: c.records.length, records: c.records });
        }
```

`nonNegative` returns -1 for an absent value, which `Math.max(0, since)` turns into 0, and returns null for anything below -1 or unsafe, which is the 400. A `limit` of `9999` passes the check here and the app clamps it, so a large limit is clamped, not rejected, as the tests expect.

- [ ] **Step 5: Run the witness tests, then the whole suite and the typecheck**

Run: `cd deploy/broker && npx tsx --test test/witness-server.test.ts`
Expected: all witness server tests pass, including the three new ones. The 502-record test takes a few seconds on PGlite.

Run: `cd deploy/broker && npm run typecheck && npm test`
Expected: clean typecheck of `src` and `test`, and the whole suite green.

- [ ] **Step 6: Commit**

```bash
cd deploy/broker
git add src/witness-app.ts src/witness-server.ts test/witness-server.test.ts
git commit -m "witness: GET /chain, the receipts oldest first, json or jsonl

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The playground manifest, the README, and the version

**Files:**
- Create: `deploy/broker/fly.playground.toml`
- Modify: `deploy/broker/README.md` ("The witness" section, a new "A playground broker" section after "Reference deployment on Fly", every `0.3.1` image tag)
- Modify: `deploy/broker/package.json`, `deploy/broker/package-lock.json` (version)

**Interfaces:**
- Consumes: the route from Task 1 and its exact query and response shapes from Global Constraints.
- Produces: `fly.playground.toml`, which Part 2's provisioning uses verbatim, and the README steps it follows.

- [ ] **Step 1: The manifest**

Create `deploy/broker/fly.playground.toml`:

```toml
app = "purse-playground"
primary_region = "lhr"

# The playground broker. Same image as the reference deployment, its own stream, its own witness key, its own
# dashboard project, and a policy tuned for strangers. The mock executor is the only executor here, nothing settles.
# One broker, one witness and one monitor per stream, so the deploy strategy stays immediate and --ha=false.
[deploy]
  strategy = "immediate"

[build]
  dockerfile = "Dockerfile"

[processes]
  app = "node dist/main.js"
  witness = "node dist/witness.js"
  monitor = "node dist/monitor.js"

[env]
  PURSE_STREAM = "playground"
  PURSE_AGENT_PORT = "8080"
  PURSE_ADMIN_PORT = "8081"
  PURSE_EXECUTOR = "mock"
  PURSE_MAX_PER_ACTION = "$50"
  PURSE_MAX_PER_DAY = "$5000"
  PURSE_REQUIRE_APPROVAL_OVER = "$20"
  PURSE_ALLOW = "api.stripe.com"
  WITNESS_STREAM = "playground"
  WITNESS_PORT = "8082"
  REKOR_URL = "https://log2025-1.rekor.sigstore.dev"
  MONITOR_STREAM = "playground"
  MONITOR_PORT = "8083"
  MONITOR_INTERVAL_MS = "15000"
  DEADLATCH_URL = "https://www.deadlatch.dev"

# The agent port is public on 443 and 80, on the app process only.
[[services]]
  processes = ["app"]
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

# The witness port is public too, on 8082, read-only and without a secret, so anyone can fetch the chain and the
# anchors and run the verifier. The admin and monitor ports stay private.
[[services]]
  processes = ["witness"]
  internal_port = 8082
  protocol = "tcp"
  auto_stop_machines = false
  min_machines_running = 1
  [[services.ports]]
    port = 8082
    handlers = ["tls", "http"]
  [[services.http_checks]]
    interval = "15s"
    timeout = "3s"
    path = "/healthz"

# Secrets, set once: fly secrets set -a purse-playground DATABASE_URL=... PURSE_ADMIN_TOKEN=... WITNESS_KEY_PEM=... REKOR_LOG_KEY=... DEADLATCH_PROJECT_KEY=...
# DATABASE_URL points at a database of its own in the existing purse-broker-db cluster, so the playground stream never shares a table with the reference chain.
```

Run: `cd deploy/broker && ~/.fly/bin/flyctl.exe config validate -c fly.playground.toml`
Expected: the manifest validates. If flyctl reports that `config validate` needs an app to exist, note the exact message in the report and rely on the TOML parse in the next step instead.

Run: `cd deploy/broker && node -e 'const t=require("fs").readFileSync("fly.playground.toml","utf8");for (const k of ["PURSE_STREAM = \"playground\"","WITNESS_STREAM = \"playground\"","MONITOR_STREAM = \"playground\"","PURSE_MAX_PER_DAY = \"$5000\"","MONITOR_INTERVAL_MS = \"15000\"","processes = [\"witness\"]","port = 8082"]) if(!t.includes(k)) {console.error("missing",k);process.exit(1)};console.log("manifest ok")'`
Expected: `manifest ok`.

- [ ] **Step 2: The README, the witness section**

In `deploy/broker/README.md`, inside "The witness", directly after the compose block that ends with the admin `/verify` curl, add:

```markdown
The witness also serves the chain it anchors, so a sceptic needs nothing from the admin port.

```sh
curl -s "http://127.0.0.1:8082/chain?since=0&limit=100"          # { stream, total, head, since, count, records }, oldest first, at most five hundred
curl -s "http://127.0.0.1:8082/chain?format=jsonl&limit=500"     # one receipt per line, the file the verifier reads
```

`since` is the 0-based position in the stream, the same number the anchors carry as `seq`. `total` is the stream length, so a tail is `since = total - n`. `head` is the last record's position and hash, or null on an empty stream.
```

Replace the sceptic's two-line check that follows ("The check a sceptic runs…") so the chain comes from the witness instead of the admin port:

```sh
curl -s "http://127.0.0.1:8082/chain?format=jsonl&limit=500" > chain.jsonl
npx receipt-verify chain.jsonl --anchors http://127.0.0.1:8082 --log-key "$REKOR_LOG_KEY" --witness-key <public key from GET /> --stream purse
```

Keep the sentence after it about exit 0 and rewriting a receipt, change `chain.json` to `chain.jsonl` in it. In "Where each port may be reached from", extend the witness bullet's first sentence so it reads "since it is read-only and holds nothing secret, and since 0.3.2 it serves the chain as well as the anchors".

- [ ] **Step 3: The README, a playground broker**

After the "Reference deployment on Fly" section and before "Image", add:

```markdown
## A playground broker

A second app from the same image, for strangers. Its own stream, its own witness key, its own dashboard project, a policy tuned so a visitor sees allowed, held and denied in three presses, and the witness port public so anyone can fetch the chain and run the verifier. `fly.playground.toml` is that app. The mock executor is the only executor it runs, nothing settles, and the daily cap is the hard stop against abuse.

```bash
flyctl apps create purse-playground
# a database of its own in the existing cluster, created from inside the cluster's machine
flyctl machine exec <db machine id> -a purse-broker-db "sh -c 'PGPASSWORD=\$OPERATOR_PASSWORD psql -h localhost -U postgres -d postgres -c \"CREATE DATABASE purse_playground\"'"
flyctl secrets set -a purse-playground DATABASE_URL="<the cluster's connection string with /purse_playground>" PURSE_ADMIN_TOKEN=... WITNESS_KEY_PEM="$(docker run --rm ghcr.io/arabiananalyst/purse-broker:0.3.2 node dist/witness.js keygen)" REKOR_LOG_KEY=...
flyctl deploy --config fly.playground.toml -a purse-playground --image ghcr.io/arabiananalyst/purse-broker:0.3.2 --ha=false
curl -s https://purse-playground.fly.dev/                 # the agent port
curl -s https://purse-playground.fly.dev:8082/            # the witness port, public here
```

`DEADLATCH_PROJECT_KEY` comes from a project on the dashboard, set it the same way and the monitor starts pushing flags. Never reuse the reference deployment's admin token or witness key here.
```

- [ ] **Step 4: Version strings**

In `deploy/broker/package.json` set `"version": "0.3.2"`. Run `cd deploy/broker && npm install --package-lock-only --ignore-scripts` so `package-lock.json` carries 0.3.2 in its top-level entries. Replace every `purse-broker:0.3.1` in `deploy/broker/README.md` with `purse-broker:0.3.2` (the quick start `docker run`, the Fly secrets line, the Fly deploy line).

Run: `cd deploy/broker && grep -c "purse-broker:0.3.1" README.md; grep -c "purse-broker:0.3.2" README.md; node -e 'console.log(require("./package.json").version, require("./package-lock.json").version)'`
Expected: `0`, a count of at least 5, then `0.3.2 0.3.2`.

- [ ] **Step 5: Prose scan, build, tests**

Run: `cd deploy/broker && node -e 'const s=require("fs").readFileSync("README.md","utf8");const bad=s.split("\n").filter((l,i)=>!/^\s*(\||```|curl|npx|flyctl|docker|#)/.test(l)&&/—/.test(l));console.log("em dashes in prose:",bad.length)'`
Expected: `em dashes in prose: 0`. Read the two new sections once for colons outside inline code and fix any.

Run: `cd deploy/broker && npm run build && npm test`
Expected: build clean, suite green.

- [ ] **Step 6: Commit**

```bash
cd deploy/broker
git add fly.playground.toml README.md package.json package-lock.json
git commit -m "broker 0.3.2: the playground manifest, the chain route in the docs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Release 0.3.2 and move the reference deployment (runs only on ARABA's go)

**Files:** none changed. Tag, image, deploy.

- [ ] **Step 1: The protected flow**

```bash
cd SaaS/purse
git push origin HEAD:release/witness-chain
gh api repos/ArabianAnalyst/purse/commits/$(git rev-parse HEAD)/check-runs --jq '[.check_runs[] | {name, status, conclusion}]'
```

Wait until `test`, `broker` and `gitleaks (secrets)` show `success`, then

```bash
git push origin HEAD:main
git push origin --delete release/witness-chain
git checkout main && git merge --ff-only witness-chain && git branch -d witness-chain
```

- [ ] **Step 2: The tag and the image**

```bash
git tag -a broker-v0.3.2 -m "purse-broker 0.3.2

The witness serves the chain it anchors. GET /chain on the witness port returns the receipts oldest first from a 0-based position, at most five hundred, with the stream length and the current head, as JSON or as one receipt per line for npx receipt-verify. fly.playground.toml adds a second Fly app from the same image with its own stream, a visitor-tuned policy, and the witness port public."
git push origin broker-v0.3.2
gh run list --workflow image.yml --limit 1
gh run watch $(gh run list --workflow image.yml --limit 1 --json databaseId --jq '.[0].databaseId')
docker manifest inspect ghcr.io/arabiananalyst/purse-broker:0.3.2 > /dev/null && echo "image 0.3.2 published"
```

- [ ] **Step 3: The reference deployment to 0.3.2**

```bash
cd deploy/broker
~/.fly/bin/flyctl.exe deploy --config fly.toml -a purse-broker --image ghcr.io/arabiananalyst/purse-broker:0.3.2 --ha=false
curl -s https://purse-broker.fly.dev/ | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log("agent port version", JSON.parse(s).version))'
~/.fly/bin/flyctl.exe machine list -a purse-broker
~/.fly/bin/flyctl.exe machine exec <witness machine id> -a purse-broker "wget -qO- 'http://127.0.0.1:8082/chain?since=0&limit=1'"
```

Expected: `agent port version 0.3.2`, three machines on the new image, and the witness answering with `total` equal to the reference chain's length and `head` set. The reference witness port stays private.

- [ ] **Step 4: Record**

Ledger the main commit, the tag, the image digest line, and the three machine ids on 0.3.2. Part 2 can now be provisioned.
