import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { SqlClient } from "@olurabian/receipt";
import { P256Signer } from "@olurabian/receipt/anchor";
import { createWitness, loadOrCreateSigner } from "../src/witness-app.js";
import { FakeRekor } from "./helpers/fake-rekor.js";
import { seedReceipts, clock, witnessCfg } from "./helpers/witness-fixture.js";

async function setup(n: number) {
  const db = new PGlite();
  await seedReceipts(db, "t", n);
  const rekor = new FakeRekor();
  const c = clock();
  const signer = P256Signer.generate();
  const w = await createWitness(witnessCfg(rekor), { sqlClient: db as unknown as SqlClient, fetch: rekor.fetch(), now: c.now, signer });
  return { db, rekor, c, signer, w };
}

test("loadOrCreateSigner generates a key file once and reuses it, never logging the private key", () => {
  const dir = mkdtempSync(join(tmpdir(), "witness-"));
  const file = join(dir, "nested", "witness-key.pem");
  const lines: string[] = [];
  const s1 = loadOrCreateSigner({ file }, (l) => lines.push(l));
  assert.ok(existsSync(file));
  assert.match(readFileSync(file, "utf8"), /BEGIN PRIVATE KEY/);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes(s1.publicKeyDer()));
  assert.ok(!lines[0]!.includes("PRIVATE"));
  const s2 = loadOrCreateSigner({ file }, (l) => lines.push(l));
  assert.equal(s2.publicKeyDer(), s1.publicKeyDer());
  assert.equal(lines.length, 1, "no log line on reuse");
  const s3 = loadOrCreateSigner({ pem: s1.toPem() });
  assert.equal(s3.publicKeyDer(), s1.publicKeyDer());
  const s4 = loadOrCreateSigner({ file, pem: P256Signer.generate().toPem() });
  assert.equal(s4.publicKeyDer(), s1.publicKeyDer(), "the file wins over the pem");
});

test("an empty stream ticks green and anchors nothing", async () => {
  const { w, rekor } = await setup(0);
  await w.tick();
  const s = w.state();
  assert.equal(s.lastTickOk, true);
  assert.equal(s.head, null);
  assert.equal(s.lastAnchor, null);
  assert.equal(rekor.submits, 0);
  assert.deepEqual(w.ready(), { ok: true });
  await w.close();
});

test("a moved head is anchored once, a still head is not anchored again, a new receipt is anchored", async () => {
  const { db, w, rekor } = await setup(3);
  await w.tick();
  let s = w.state();
  assert.deepEqual(s.head, { seq: 2, hash: s.head!.hash });
  assert.equal(s.lastAnchor?.seq, 2);
  assert.equal(rekor.submits, 1);
  assert.equal(s.lag, 0);
  await w.tick();
  assert.equal(rekor.submits, 1, "unchanged head, no submit");
  await seedReceipts(db, "t", 2, 3);
  await w.tick();
  s = w.state();
  assert.equal(s.lastAnchor?.seq, 4);
  assert.equal(rekor.submits, 2);
  assert.equal((await w.anchors()).length, 2);
  assert.deepEqual((await w.anchors(2)).map((a) => a.seq), [4]);
  const ev = await w.events();
  assert.deepEqual(ev.map((e) => e.kind), ["anchored", "anchored"]);
  const v = await w.verify();
  assert.equal(v.ok, true);
  assert.equal(v.coveredUpTo, 4);
  assert.equal(v.stream, "t");
  await w.close();
});

test("a broken chain anchors nothing, records an event, and readiness goes red", async () => {
  const { db, w, rekor } = await setup(4);
  await w.tick();
  await seedReceipts(db, "t", 1, 4);
  await db.query("UPDATE receipts SET record = replace(record, '\"n\":1', '\"n\":1000') WHERE stream = 't' AND id = 'id-1'");
  await w.tick();
  const s = w.state();
  assert.equal(s.lastTickOk, false);
  assert.match(s.lastError ?? "", /chain broken/);
  assert.equal(rekor.submits, 1, "no anchor on a broken chain");
  const ev = await w.events();
  assert.equal(ev[ev.length - 1]?.kind, "chain-broken");
  assert.match(ev[ev.length - 1]?.detail ?? "", /chain broken at 1 \(id-1\)/);
  assert.equal(w.ready().ok, false);
  await w.close();
});

test("a Rekor failure records an event, keeps the head unanchored, and the next tick retries", async () => {
  const { w, rekor } = await setup(2);
  rekor.status = 503;
  await w.tick();
  let s = w.state();
  assert.equal(s.lastTickOk, false);
  assert.match(s.lastError ?? "", /rekor: 503/);
  assert.equal(s.lastAnchor, null);
  assert.equal(s.lag, 2);
  assert.equal((await w.events())[0]?.kind, "anchor-failed");
  assert.equal(w.ready().ok, false);
  rekor.status = 201;
  await w.tick();
  s = w.state();
  assert.equal(s.lastTickOk, true);
  assert.equal(s.lastAnchor?.seq, 1);
  assert.equal(s.lag, 0);
  assert.deepEqual(w.ready(), { ok: true });
  await w.close();
});

test("a transient Rekor failure stays green while the last anchor is younger than the window, then goes red", async () => {
  const { db, w, rekor, c } = await setup(2);
  await w.tick();
  await seedReceipts(db, "t", 1, 2);
  rekor.status = 503;
  await w.tick();
  const s = w.state();
  assert.equal(s.lastTickOk, false);
  assert.equal(s.lastVerifyOk, true);
  assert.equal(s.lag, 1);
  assert.deepEqual(w.ready(), { ok: true }, "the last anchor is seconds old");
  c.advance(2 * 60000 + 1);
  await w.tick();
  const r = w.ready();
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /not anchored, 1 receipts behind/);
  rekor.status = 201;
  await w.tick();
  assert.deepEqual(w.ready(), { ok: true });
  await w.close();
});

test("readiness follows the lag rule on the clock", async () => {
  const { w, c } = await setup(2);
  assert.equal(w.ready().ok, false, "no tick yet");
  await w.tick();
  assert.deepEqual(w.ready(), { ok: true });
  c.advance(2 * 60000 + 1);
  const r = w.ready();
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /stale/);
  await w.tick();
  assert.deepEqual(w.ready(), { ok: true });
  await w.close();
});

test("an anchor row that already exists for the head's seq is recorded as a conflict, not a crash", async () => {
  const { db, w, rekor } = await setup(2);
  // Another witness (or a stale row) got there first for seq 1, with a different head.
  await db.query("INSERT INTO anchors (stream, seq, head, at, record) VALUES ('t', 1, repeat('0', 64), now(), '{}')");
  await w.tick();
  const s = w.state();
  assert.equal(s.lastTickOk, false);
  assert.equal(rekor.submits, 1, "the submit happened, the append was refused");
  const ev = await w.events();
  assert.equal(ev[ev.length - 1]?.kind, "anchor-conflict");
  assert.equal(w.ready().ok, false);
  await w.close();
});

test("the witness never writes the receipts table", async () => {
  const { db, w } = await setup(3);
  const before = await db.query("SELECT count(*)::int AS n FROM receipts");
  await w.tick();
  const after = await db.query("SELECT count(*)::int AS n FROM receipts");
  assert.deepEqual(after.rows, before.rows);
  await w.close();
});
