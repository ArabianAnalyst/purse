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
const cursorRow = async (db: PGlite) => {
  const row = (await db.query<{ seq: unknown }>("SELECT seq FROM monitor_cursor WHERE stream = 't'")).rows[0];
  return row ? String(row.seq) : null;
};

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
