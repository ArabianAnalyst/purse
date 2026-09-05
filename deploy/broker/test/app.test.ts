import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { SqlClient } from "@olurabian/receipt";
import { MockExecutor, type Executor } from "@olurabian/purse";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";

const TOKEN = "t".repeat(32);
function cfg(over: Partial<Config> = {}): Config {
  return {
    policy: { currency: "USD", maxPerAction: "$5", maxPerDay: "$100", requireApprovalOver: "$3", allow: ["api.stripe.com"] },
    store: { kind: "postgres", url: "postgres://unused", stream: "t" },
    ports: { agent: 0, admin: 0, bind: "127.0.0.1" },
    adminToken: TOKEN, executor: { kind: "mock" }, maxPending: 5, otel: false, openPolicy: false, ...over,
  };
}
async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}
async function get(url: string, headers: Record<string, string> = {}) {
  const r = await fetch(url, { headers });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}
const auth = { authorization: `Bearer ${TOKEN}` };

test("agent port: request, execute, status, health; admin port: auth, pending, approve, verify, audit, readiness", async () => {
  const db = new PGlite();
  const app = await createApp(cfg(), { sqlClient: db as unknown as SqlClient });
  const { agentUrl, adminUrl } = await app.start();
  try {
    assert.deepEqual((await get(`${agentUrl}/healthz`)).json, { ok: true });
    const r = await post(`${agentUrl}/request`, { amount: "$1", payee: "api.stripe.com", intent: "credits" });
    assert.equal(r.json.decision, "allowed");
    const x = await post(`${agentUrl}/execute`, { grantId: r.json.grantId });
    assert.equal(x.json.status, "paid");
    assert.equal((await post(`${agentUrl}/nope`, {})).status, 404);
    assert.equal((await get(`${adminUrl}/pending`)).status, 401);
    assert.equal((await get(`${adminUrl}/pending`, { authorization: "Bearer wrong" })).status, 401);
    assert.equal((await get(`${adminUrl}/pending`, { authorization: `Bearer ${"x".repeat(32)}` })).status, 401);
    assert.deepEqual((await get(`${adminUrl}/healthz`)).json, { ok: true });
    const held = await post(`${agentUrl}/request`, { amount: "$4", payee: "api.stripe.com", intent: "big" });
    assert.equal(held.json.decision, "needs_approval");
    const pending = await get(`${adminUrl}/pending`, auth);
    assert.equal((pending.json.pending as unknown[]).length, 1);
    const ap = await post(`${adminUrl}/approve`, { pendingId: held.json.pendingId }, auth);
    assert.equal(ap.status, 200);
    const st = await post(`${agentUrl}/status`, { pendingId: held.json.pendingId });
    assert.equal(st.json.state, "approved");
    const x2 = await post(`${agentUrl}/execute`, { grantId: st.json.grantId });
    assert.equal(x2.json.status, "paid");
    const v = await get(`${adminUrl}/verify`, auth);
    assert.equal(v.json.ok, true);
    assert.ok((v.json.records as number) >= 4);
    assert.equal(v.json.degraded, null);
    const audit = await get(`${adminUrl}/audit?since=2000-01-01T00:00:00.000Z`, auth);
    assert.ok((audit.json.receipts as unknown[]).length >= 4);
    assert.equal((await get(`${adminUrl}/readyz`, auth)).status, 200);
    const again = await createApp(cfg(), { sqlClient: db as unknown as SqlClient });
    assert.equal(again.broker.verify().ok, true);
    assert.ok(again.broker.audit().length >= 4);
    await again.stop();
  } finally { await app.stop(); }
});

test("mcp tools on the agent port", async () => {
  const app = await createApp(cfg(), { sqlClient: new PGlite() as unknown as SqlClient });
  const { agentUrl } = await app.start();
  const client = new Client({ name: "test", version: "0.0.0" });
  const errors: string[] = [];
  client.onerror = (e) => errors.push(String(e));
  const transport = new StreamableHTTPClientTransport(new URL(`${agentUrl}/mcp`));
  transport.onerror = (e) => errors.push(String(e));
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((t) => t.name).sort(), ["execute_spend", "request_spend", "spend_status"]);
    const r = await client.callTool({ name: "request_spend", arguments: { amount: "$1", payee: "api.stripe.com", intent: "credits" } });
    const decision = JSON.parse((r.content as { text: string }[])[0]!.text) as { decision: string; grantId?: string };
    assert.equal(decision.decision, "allowed");
    const x = await client.callTool({ name: "execute_spend", arguments: { grantId: decision.grantId } });
    assert.equal(JSON.parse((x.content as { text: string }[])[0]!.text).status, "paid");
    assert.equal((await fetch(`${agentUrl}/mcp`)).status, 405);
    assert.equal(errors.length, 0);
  } finally { await client.close().catch(() => undefined); await app.stop(); }
});

test("approve then execute over MCP", async () => {
  const app = await createApp(cfg(), { sqlClient: new PGlite() as unknown as SqlClient });
  const { agentUrl, adminUrl } = await app.start();
  const client = new Client({ name: "test", version: "0.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${agentUrl}/mcp`)));
    const r = await client.callTool({ name: "request_spend", arguments: { amount: "$4", payee: "api.stripe.com", intent: "big" } });
    const decision = JSON.parse((r.content as { text: string }[])[0]!.text) as { decision: string; pendingId?: string };
    assert.equal(decision.decision, "needs_approval");
    const ap = await post(`${adminUrl}/approve`, { pendingId: decision.pendingId }, auth);
    assert.equal(ap.status, 200);
    const st = await client.callTool({ name: "spend_status", arguments: { pendingId: decision.pendingId } });
    const status = JSON.parse((st.content as { text: string }[])[0]!.text) as { state: string; grantId?: string };
    assert.equal(status.state, "approved");
    assert.ok(status.grantId);
    const x = await client.callTool({ name: "execute_spend", arguments: { grantId: status.grantId } });
    assert.equal(JSON.parse((x.content as { text: string }[])[0]!.text).status, "paid");
  } finally { await client.close().catch(() => undefined); await app.stop(); }
});

test("/audit?since filters and validates", async () => {
  const app = await createApp(cfg(), { sqlClient: new PGlite() as unknown as SqlClient });
  const { agentUrl, adminUrl } = await app.start();
  try {
    await post(`${agentUrl}/request`, { amount: "$1", payee: "api.stripe.com", intent: "a" });
    const since = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    await post(`${agentUrl}/request`, { amount: "$1", payee: "api.stripe.com", intent: "b" });
    const all = await get(`${adminUrl}/audit`, auth);
    const filtered = await get(`${adminUrl}/audit?since=${encodeURIComponent(since)}`, auth);
    assert.ok((filtered.json.receipts as unknown[]).length < (all.json.receipts as unknown[]).length);
    const bad = await get(`${adminUrl}/audit?since=nope`, auth);
    assert.equal(bad.status, 400);
    assert.match(String(bad.json.error), /ISO-8601/);
  } finally { await app.stop(); }
});

test("readiness fails at the pending limit", async () => {
  const db = new PGlite();
  let gate: Promise<void> | null = null;
  const client: SqlClient = {
    query: async (t, p) => {
      if (t.startsWith("INSERT") && gate) await gate;
      return db.query(t, p as unknown[]);
    },
  };
  const app = await createApp(cfg({ maxPending: 2 }), { sqlClient: client });
  const { agentUrl, adminUrl } = await app.start();
  try {
    let release!: () => void;
    gate = new Promise((r) => { release = r; });
    await post(`${agentUrl}/request`, { amount: "$1", payee: "api.stripe.com", intent: "a" });
    await post(`${agentUrl}/request`, { amount: "$1", payee: "api.stripe.com", intent: "b" });
    const blocked = await get(`${adminUrl}/readyz`, auth);
    assert.equal(blocked.status, 503);
    assert.match(String(blocked.json.reason), /pending/);
    release();
    await app.store.flush();
    assert.equal((await get(`${adminUrl}/readyz`, auth)).status, 200);
  } finally { await app.stop().catch(() => undefined); }
});

test("the payment that latches the store still settles (known limit)", async () => {
  const db = new PGlite();
  let fail = false;
  let executed = 0;
  const flaky: SqlClient = { query: async (t, p) => { if (fail && t.startsWith("INSERT")) throw Object.assign(new Error("relation gone"), { code: "42P01" }); return db.query(t, p as unknown[]); } };
  const counting: Executor = { execute: async (g) => { executed++; return new MockExecutor().execute(g); } };
  const app = await createApp(cfg(), { sqlClient: flaky, executor: counting });
  const { agentUrl } = await app.start();
  try {
    const r1 = await post(`${agentUrl}/request`, { amount: "$1", payee: "api.stripe.com", intent: "a" });
    const r2 = await post(`${agentUrl}/request`, { amount: "$1", payee: "api.stripe.com", intent: "b" });
    fail = true;
    const x1 = await post(`${agentUrl}/execute`, { grantId: r1.json.grantId });
    assert.equal(x1.status, 503);
    assert.equal(executed, 1);
    const x2 = await post(`${agentUrl}/execute`, { grantId: r2.json.grantId });
    assert.equal(x2.status, 503);
    assert.equal(executed, 1);
  } finally { await app.stop().catch(() => undefined); }
});

test("a degraded store fails closed on the next execute", async () => {
  const db = new PGlite();
  let fail = false;
  const flaky: SqlClient = { query: async (t, p) => { if (fail && t.startsWith("INSERT")) throw Object.assign(new Error("relation gone"), { code: "42P01" }); return db.query(t, p as unknown[]); } };
  const app = await createApp(cfg(), { sqlClient: flaky });
  const { agentUrl, adminUrl } = await app.start();
  try {
    assert.equal((await get(`${adminUrl}/readyz`, auth)).status, 200);
    fail = true;
    const r = await post(`${agentUrl}/request`, { amount: "$1", payee: "api.stripe.com", intent: "c" });
    assert.equal(r.json.decision, "allowed");
    const x = await post(`${agentUrl}/execute`, { grantId: r.json.grantId });
    assert.equal(x.status, 503);
    assert.match(String(x.json.error), /degraded/);
    const ready = await get(`${adminUrl}/readyz`, auth);
    assert.equal(ready.status, 503);
    assert.match(String(ready.json.reason), /degraded/);
    const v = await get(`${adminUrl}/verify`, auth);
    assert.match(String(v.json.degraded), /degraded|relation gone/);
  } finally { await app.stop().catch(() => undefined); }
});

test("boot refuses a broken chain", async () => {
  const db = new PGlite();
  const app = await createApp(cfg(), { sqlClient: db as unknown as SqlClient });
  const { agentUrl } = await app.start();
  await post(`${agentUrl}/request`, { amount: "$1", payee: "api.stripe.com", intent: "c" });
  await app.stop();
  await db.query(`UPDATE receipts SET record = replace(record, '"status":"allowed"', '"status":"denied"')`);
  await assert.rejects(createApp(cfg(), { sqlClient: db as unknown as SqlClient }), /fails verification/);
});
