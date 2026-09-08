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

/** A syntactically well-formed but foreign Anchor JSON, for the pre-submit conflict tests. */
function foreignAnchor(seq: number, head: string, publicKey = "foreign-witness-key"): string {
  return JSON.stringify({
    v: 1, stream: "t", seq, head, at: "2026-01-01T00:00:00.000Z",
    witness: { alg: "ecdsa-p256", publicKey },
    signature: "AA==",
    log: { url: "https://foreign.example", keyId: "foreign-log" },
    entry: { logIndex: "0", canonicalizedBody: "AA==" },
    proof: { logIndex: "0", treeSize: "1", rootHash: "AA==", hashes: [], checkpoint: "foreign checkpoint" },
  });
}

test("a foreign anchor row already at the head's seq, for a different head, is a conflict caught before submitting", async () => {
  const { db, w, rekor } = await setup(2);
  // Another witness got there first for seq 1, with a different head.
  await db.query("INSERT INTO anchors (stream, seq, head, at, record) VALUES ('t', 1, repeat('0', 64), now(), $1)", [foreignAnchor(1, "0".repeat(64))]);
  await w.tick();
  await w.tick();
  await w.tick();
  assert.equal(rekor.submits, 0, "the conflict is caught before submitting");
  const ev = await w.events();
  const conflicts = ev.filter((e) => e.kind === "anchor-conflict");
  assert.equal(conflicts.length, 1, "the conflict is logged once, not every tick");
  assert.match(conflicts[0]?.detail ?? "", /an anchor for a different head/);
  assert.equal(w.state().lastTickOk, false);
  assert.equal(w.ready().ok, false);
  await seedReceipts(db, "t", 1, 2);
  await w.tick();
  assert.equal(rekor.submits, 1);
  assert.equal(w.state().lastAnchor?.seq, 2);
  await w.close();
});

test("a row anchored by another witness with the same key is adopted, not resubmitted", async () => {
  const db = new PGlite();
  await seedReceipts(db, "t", 2);
  const rekor = new FakeRekor();
  const c = clock();
  const signer = P256Signer.generate();
  const cfg = witnessCfg(rekor);
  const A = await createWitness(cfg, { sqlClient: db as unknown as SqlClient, fetch: rekor.fetch(), now: c.now, signer });
  await A.tick();
  assert.equal(A.state().lastAnchor?.seq, 1);
  const before = rekor.submits;
  const B = await createWitness(cfg, { sqlClient: db as unknown as SqlClient, fetch: rekor.fetch(), now: c.now, signer });
  await B.tick();
  assert.equal(rekor.submits, before, "B adopted A's anchor instead of resubmitting");
  assert.equal(B.state().lastAnchor?.seq, 1);
  await A.close();
  await B.close();
});

test("a row anchored by an untrusted key is a conflict until the next receipt", async () => {
  const db = new PGlite();
  await seedReceipts(db, "t", 2);
  const rekor = new FakeRekor();
  const c = clock();
  const SA = P256Signer.generate();
  const SB = P256Signer.generate();
  const cfg = witnessCfg(rekor);
  const A = await createWitness(cfg, { sqlClient: db as unknown as SqlClient, fetch: rekor.fetch(), now: c.now, signer: SA });
  await A.tick();
  assert.equal(A.state().lastAnchor?.seq, 1);
  const B = await createWitness(cfg, { sqlClient: db as unknown as SqlClient, fetch: rekor.fetch(), now: c.now, signer: SB });
  await B.tick();
  const conflicts = (await B.events()).filter((e) => e.kind === "anchor-conflict");
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0]?.detail ?? "", /untrusted witness key/);
  assert.equal(B.ready().ok, false);
  await seedReceipts(db, "t", 1, 2);
  await B.tick();
  assert.equal(B.state().lastAnchor?.seq, 2);
  assert.equal(B.ready().ok, true);
  await A.close();
  await B.close();
});

test("WITNESS_TRUSTED_KEYS makes an earlier key's anchors count", async () => {
  const db = new PGlite();
  await seedReceipts(db, "t", 2);
  const rekor = new FakeRekor();
  const c = clock();
  const SA = P256Signer.generate();
  const SB = P256Signer.generate();
  const A = await createWitness(witnessCfg(rekor), { sqlClient: db as unknown as SqlClient, fetch: rekor.fetch(), now: c.now, signer: SA });
  await A.tick();
  assert.equal(A.state().lastAnchor?.seq, 1);
  const cfgB = witnessCfg(rekor, { trustedKeys: [SA.publicKeyDer()] });
  const B = await createWitness(cfgB, { sqlClient: db as unknown as SqlClient, fetch: rekor.fetch(), now: c.now, signer: SB });
  await B.tick();
  const conflicts = (await B.events()).filter((e) => e.kind === "anchor-conflict");
  assert.equal(conflicts.length, 0);
  assert.equal(B.state().lastAnchor?.seq, 1);
  const v = await B.verify();
  assert.equal(v.ok, true);
  assert.equal(v.coveredUpTo, 1);
  await A.close();
  await B.close();
});

for (const record of ["{}", "not json"]) {
  test(`a malformed anchor row (record ${JSON.stringify(record)}) at the head's seq neither resubmits, crashes boot, nor breaks /anchors or /verify`, async () => {
    const db = new PGlite();
    await seedReceipts(db, "t", 2);
    // The anchors table must exist before we can seed a bad row into it; createWitness() would otherwise create it on boot.
    await db.query("CREATE TABLE IF NOT EXISTS anchors (n BIGSERIAL PRIMARY KEY, stream TEXT NOT NULL, seq BIGINT NOT NULL, head TEXT NOT NULL, at TIMESTAMPTZ NOT NULL, record TEXT NOT NULL, UNIQUE (stream, seq))");
    await db.query("INSERT INTO anchors (stream, seq, head, at, record) VALUES ('t', 1, repeat('0', 64), now(), $1)", [record]);
    const rekor = new FakeRekor();
    const c = clock();
    const signer = P256Signer.generate();
    const w = await createWitness(witnessCfg(rekor), { sqlClient: db as unknown as SqlClient, fetch: rekor.fetch(), now: c.now, signer });
    assert.equal(w.state().lastAnchor, null, "boot succeeds and does not adopt the bad row");
    await w.tick();
    await w.tick();
    await w.tick();
    await w.tick();
    assert.equal(rekor.submits, 0, "never resubmits against a row it cannot parse");
    const conflicts = (await w.events()).filter((e) => e.kind === "anchor-conflict");
    assert.equal(conflicts.length, 1, "the conflict is logged once, not every tick");
    assert.match(conflicts[0]?.detail ?? "", /malformed/);
    assert.equal(w.ready().ok, false);
    await assert.doesNotReject(async () => assert.deepEqual(await w.anchors(), []));
    assert.equal((await w.verify()).coveredUpTo, null);
    await seedReceipts(db, "t", 1, 2);
    await w.tick();
    assert.equal(w.state().lastAnchor?.seq, 2);
    assert.equal(rekor.submits, 1);
    await w.close();
  });
}

test("the witness never writes the receipts table", async () => {
  const { db, w } = await setup(3);
  const before = await db.query("SELECT count(*)::int AS n FROM receipts");
  await w.tick();
  const after = await db.query("SELECT count(*)::int AS n FROM receipts");
  assert.deepEqual(after.rows, before.rows);
  await w.close();
});
