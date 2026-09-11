import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PostgresStore, makeReceipt, type SqlClient } from "@olurabian/receipt";
import { P256Signer } from "@olurabian/receipt/anchor";
import { createWitness } from "../src/witness-app.js";
import { createWitnessServer } from "../src/witness-server.js";
import { listen } from "../src/agent-server.js";
import { FakeRekor } from "./helpers/fake-rekor.js";
import { seedReceipts, clock, witnessCfg } from "./helpers/witness-fixture.js";

async function get(url: string) {
  const r = await fetch(url);
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

test("the witness port: index, anchors, verify, events, health, readiness, and nothing else", async () => {
  const db = new PGlite();
  await seedReceipts(db, "t", 3);
  const rekor = new FakeRekor();
  const c = clock();
  const signer = P256Signer.generate();
  const cfg = witnessCfg(rekor);
  const w = await createWitness(cfg, { sqlClient: db as unknown as SqlClient, fetch: rekor.fetch(), now: c.now, signer });
  const srv = await listen(createWitnessServer(w, cfg), 0, "127.0.0.1");
  try {
    assert.equal((await get(`${srv.url}/readyz`)).status, 503, "no tick yet");
    await w.tick();
    const idx = await get(`${srv.url}/`);
    assert.equal(idx.status, 200);
    assert.equal(idx.json.service, "purse-witness");
    assert.equal(idx.json.stream, "t");
    assert.equal((idx.json.witness as { publicKey: string }).publicKey, signer.publicKeyDer());
    assert.equal((idx.json.log as { url: string; keyId: string }).keyId, rekor.keyId);
    assert.ok(!JSON.stringify(idx.json).includes("PRIVATE"));
    const an = await get(`${srv.url}/anchors`);
    assert.equal((an.json.anchors as unknown[]).length, 1);
    assert.equal(((await get(`${srv.url}/anchors?since=2`)).json.anchors as unknown[]).length, 0);
    assert.equal((await get(`${srv.url}/anchors?since=x`)).status, 400);
    assert.equal((await get(`${srv.url}/anchors?since=99999999999999999999`)).status, 400);
    const tail1 = await get(`${srv.url}/anchors?tail=1`);
    assert.equal((tail1.json.anchors as unknown[]).length, 1);
    assert.deepEqual(tail1.json.anchors, an.json.anchors, "tail=1 returns the same anchor");
    const tail5 = await get(`${srv.url}/anchors?tail=5`);
    assert.equal((tail5.json.anchors as unknown[]).length, 1, "tail=5 also returns one anchor since there is only one");
    assert.equal((await get(`${srv.url}/anchors?tail=0`)).status, 400);
    assert.equal((await get(`${srv.url}/anchors?tail=-1`)).status, 400);
    assert.equal((await get(`${srv.url}/anchors?tail=x`)).status, 400);
    const tailWins = await get(`${srv.url}/anchors?since=99&tail=1`);
    assert.equal((tailWins.json.anchors as unknown[]).length, 1, "tail wins over since");
    const v = await get(`${srv.url}/verify`);
    assert.equal(v.status, 200);
    assert.equal(v.json.ok, true);
    assert.equal(v.json.coveredUpTo, 2);
    const ev = await get(`${srv.url}/events`);
    assert.equal((ev.json.events as { kind: string }[])[0]?.kind, "anchored");
    assert.equal((await get(`${srv.url}/events?since=99999999999999999999`)).status, 400);
    assert.deepEqual((await get(`${srv.url}/healthz`)).json, { ok: true });
    assert.equal((await get(`${srv.url}/readyz`)).status, 200);
    c.advance(3 * cfg.intervalMs);
    assert.equal((await get(`${srv.url}/readyz`)).status, 503);
    assert.equal((await get(`${srv.url}/nope`)).status, 404);
    assert.equal((await fetch(`${srv.url}/anchors`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${srv.url}/verify`, { method: "DELETE" })).status, 404);
  } finally {
    await srv.close();
    await w.close();
  }
});

test("GET /chain serves the receipts oldest first, with total and head, validated, and as jsonl", async () => {
  const db = new PGlite();
  await seedReceipts(db, "t", 7);
  const store = await PostgresStore.open<{ reason: string }>(db as unknown as SqlClient, { stream: "t" });
  makeReceipt(store, { kind: "decision", payload: { reason: "payée déjà réglée ✓" } }, { now: () => "2026-09-08T00:00:07.000Z", newId: () => "id-7" });
  await store.flush();
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
    assert.equal(all.json.total, 8);
    assert.equal(all.json.since, 0);
    assert.equal(all.json.count, 8);
    assert.equal(all.json.next, null, "the whole stream in one call needs no more paging");
    const recs = all.json.records as { id: string; prevHash: string; hash: string }[];
    assert.deepEqual(recs.map((r) => r.id), ["id-0", "id-1", "id-2", "id-3", "id-4", "id-5", "id-6", "id-7"]);
    assert.equal(recs[1]!.prevHash, recs[0]!.hash, "the slice is the chain, linked");
    assert.deepEqual(all.json.head, { seq: 7, hash: recs[7]!.hash });
    assert.deepEqual(Object.keys(recs[0]!), ["id", "ts", "kind", "payload", "prevHash", "hash"], "stored key order survives");

    const tail = await get(`${srv.url}/chain?since=5&limit=1`);
    assert.deepEqual((tail.json.records as { id: string }[]).map((r) => r.id), ["id-5"]);
    assert.equal(tail.json.since, 5);
    assert.equal(tail.json.count, 1);
    assert.equal(tail.json.total, 8);

    const past = await get(`${srv.url}/chain?since=99`);
    assert.equal(past.status, 200);
    assert.equal(past.json.count, 0);
    assert.equal(past.json.since, 8, "since is clamped to the stream length");

    assert.equal((await get(`${srv.url}/chain?limit=9999`)).json.count, 8, "a large limit is clamped, not rejected");

    for (const bad of ["since=x", "since=-2", "since=99999999999999999999", "limit=0", "limit=-1", "limit=x", "limit=1.5", "format=xml"]) {
      assert.equal((await get(`${srv.url}/chain?${bad}`)).status, 400, bad);
    }
    assert.equal((await get(`${srv.url}/chain?format=`)).status, 200, "format= behaves like format absent");

    const jl = await fetch(`${srv.url}/chain?format=jsonl&since=4`);
    assert.equal(jl.status, 200);
    assert.equal(jl.headers.get("content-type"), "application/x-ndjson");
    const body = await jl.text();
    assert.ok(body.endsWith("\n"), "trailing newline");
    const lines = body.trim().split("\n");
    assert.equal(lines.length, 4);
    assert.equal((JSON.parse(lines[0]!) as { id: string }).id, "id-4");
    assert.equal(Object.keys(JSON.parse(lines[0]!) as object).join(","), "id,ts,kind,payload,prevHash,hash");
    const lastLine = JSON.parse(lines[3]!) as { id: string; payload: { reason: string } };
    assert.equal(lastLine.id, "id-7");
    assert.equal(lastLine.payload.reason, "payée déjà réglée ✓", "the multibyte payload survives byte-accurate framing");

    const idx = await get(`${srv.url}/`);
    assert.ok(Object.keys(idx.json.routes as object).some((k) => k.startsWith("GET /chain")), "the index lists the route");
    assert.match(String(idx.json.verifyWith), /chain\?format=jsonl&since=\$s&limit=500/);
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
    assert.equal(a.json.next, 500, "a full page short of total names the next position");
    const b = await get(`${srv.url}/chain?since=1&limit=600`);
    assert.equal(b.json.count, 500);
    assert.equal((b.json.records as { id: string }[])[0]!.id, "id-1");
    assert.equal(b.json.next, 501);
    const last = await get(`${srv.url}/chain?since=500`);
    assert.equal(last.json.count, 2);
    assert.deepEqual(last.json.head, { seq: 501, hash: (last.json.records as { hash: string }[])[1]!.hash });
    assert.equal(last.json.next, null, "a short page names no next position");

    const jlPage = await fetch(`${srv.url}/chain?format=jsonl&since=0&limit=500`);
    assert.equal(jlPage.headers.get("x-next-since"), "500");
    const jlLast = await fetch(`${srv.url}/chain?format=jsonl&since=500`);
    assert.equal(jlLast.headers.get("x-next-since"), null, "a short jsonl page carries no x-next-since header");
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
    assert.deepEqual(r.json, { stream: "t", total: 0, head: null, since: 0, count: 0, next: null, records: [] });
    const jl = await fetch(`${srv.url}/chain?format=jsonl`);
    assert.equal(jl.status, 200);
    assert.equal(jl.headers.get("content-type"), "application/x-ndjson");
    assert.equal(await jl.text(), "");
  } finally {
    await srv.close();
    await w.close();
  }
});

test("witness.js keygen prints a P-256 PEM on stdout and the public key on stderr", () => {
  const out = execFileSync(process.execPath, [join(process.cwd(), "dist", "witness.js"), "keygen"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.match(out, /^-----BEGIN PRIVATE KEY-----/);
  assert.equal(P256Signer.fromPem(out).publicKeyDer().length > 80, true);
});

test("witness.js refuses to start on a bad config with the prefix", () => {
  let err = "";
  try { execFileSync(process.execPath, [join(process.cwd(), "dist", "witness.js")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DATABASE_URL: "", WITNESS_KEY_FILE: "", WITNESS_KEY_PEM: "", REKOR_LOG_KEY: "" } }); }
  catch (e) { err = String((e as { stderr: string }).stderr); }
  assert.match(err, /^purse-witness config: DATABASE_URL is required/);
});
