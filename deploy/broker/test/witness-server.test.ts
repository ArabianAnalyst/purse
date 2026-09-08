import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { SqlClient } from "@olurabian/receipt";
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
    const v = await get(`${srv.url}/verify`);
    assert.equal(v.status, 200);
    assert.equal(v.json.ok, true);
    assert.equal(v.json.coveredUpTo, 2);
    const ev = await get(`${srv.url}/events`);
    assert.equal((ev.json.events as { kind: string }[])[0]?.kind, "anchored");
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
