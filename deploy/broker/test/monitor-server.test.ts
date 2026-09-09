import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import type { SqlClient } from "@olurabian/receipt";
import { createMonitorApp } from "../src/monitor-app.js";
import { createMonitorServer } from "../src/monitor-server.js";
import { listen } from "../src/agent-server.js";
import { sinceParam } from "../src/http.js";
import { VERSION } from "../src/version.js";
import { clock, ensureReceipts, executed, fakeDeadlatch, monitorCfg, seedDecisions } from "./helpers/monitor-fixture.js";

async function up() {
  const db = new PGlite();
  await ensureReceipts(db, "t");
  const hosted = fakeDeadlatch();
  const c = clock("2026-09-09T01:00:00.000Z");
  const cfg = monitorCfg();
  const app = await createMonitorApp(cfg, { sqlClient: db as unknown as SqlClient, fetch: hosted.fetch, now: c.now });
  const srv = await listen(createMonitorServer(app, cfg), 0, "127.0.0.1");
  const get = async (path: string) => { const r = await fetch(srv.url + path); return { status: r.status, body: (await r.json()) as Record<string, unknown> }; };
  return { db, app, srv, get, close: async () => { await srv.close(); await app.close(); } };
}

test("sinceParam", () => {
  assert.equal(sinceParam(null), -1);
  assert.equal(sinceParam(""), -1);
  assert.equal(sinceParam("0"), 0);
  assert.equal(sinceParam("42"), 42);
  assert.equal(sinceParam("-1"), -1);
  assert.equal(sinceParam("-2"), null);
  assert.equal(sinceParam("abc"), null);
  assert.equal(sinceParam("1.5"), null);
  assert.equal(sinceParam("99999999999999999999"), null);
});

test("GET / describes the monitor without the key, and readiness follows the ticks", async () => {
  const { app, get, close } = await up();
  const before = await get("/readyz");
  assert.equal(before.status, 503);
  assert.deepEqual(before.body, { ok: false, reason: "no tick yet" });
  await app.tick();
  const root = await get("/");
  assert.equal(root.status, 200);
  assert.equal(root.body.service, "purse-monitor");
  assert.equal(root.body.version, VERSION);
  assert.equal(root.body.stream, "t");
  assert.equal(root.body.sink, "deadlatch");
  assert.equal(root.body.keyPrefix, "aaaaaaaa");
  assert.equal(root.body.dashboard, "https://deadlatch.test/app");
  assert.deepEqual(root.body.window, { count: 500, ms: 86_400_000 });
  assert.equal(root.body.intervalMs, 60_000);
  assert.equal(JSON.stringify(root.body).includes("dl_live_"), false, "the key never appears");
  assert.ok(typeof root.body.routes === "object");
  assert.deepEqual(await get("/readyz"), { status: 200, body: { ok: true } });
  assert.deepEqual(await get("/healthz"), { status: 200, body: { ok: true } });
  await close();
});

test("GET /flags and /events serve what the app stored, validate since, and page from n", async () => {
  const { db, app, get, close } = await up();
  await seedDecisions(db, "t", [executed("g9")]);
  await app.tick();
  const flags = await get("/flags");
  assert.equal(flags.status, 200);
  assert.equal(flags.body.stream, "t");
  const list = flags.body.flags as Array<{ n: number; flag: { expectation: { id: string } } }>;
  assert.equal(list.length, 1);
  assert.equal(list[0]?.n, 1);
  assert.equal(list[0]?.flag.expectation.id, "executed-without-grant");
  assert.deepEqual((await get("/flags?since=1")).body.flags, []);
  assert.equal((await get("/flags?since=x")).status, 400);
  assert.equal((await get("/events?since=99999999999999999999")).status, 400);
  const events = await get("/events");
  assert.equal(events.status, 200);
  assert.deepEqual(events.body.events, []);
  await close();
});

test("anything else is 404, and so is any non-GET", async () => {
  const { srv, get, close } = await up();
  assert.equal((await get("/nope")).status, 404);
  const post = await fetch(srv.url + "/flags", { method: "POST" });
  assert.equal(post.status, 404);
  await close();
});
