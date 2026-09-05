import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { SqlClient } from "@olurabian/receipt";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";

const TOKEN = "t".repeat(32);
function cfg(over: Partial<Config> = {}): Config {
  return {
    policy: { currency: "USD", maxPerAction: "$5", maxPerDay: "$100", requireApprovalOver: "$3", allow: ["api.stripe.com"] },
    store: { kind: "postgres", url: "postgres://unused", stream: "t" },
    ports: { agent: 0, admin: 0, bind: "127.0.0.1" },
    adminToken: TOKEN, executor: { kind: "mock" }, maxPending: 5, otel: false, ...over,
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
  } finally { await app.stop(); }
});

test("mcp tools on the agent port", async () => {
  const app = await createApp(cfg(), { sqlClient: new PGlite() as unknown as SqlClient });
  const { agentUrl } = await app.start();
  const client = new Client({ name: "test", version: "0.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${agentUrl}/mcp`)));
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((t) => t.name).sort(), ["execute_spend", "request_spend", "spend_status"]);
    const r = await client.callTool({ name: "request_spend", arguments: { amount: "$1", payee: "api.stripe.com", intent: "credits" } });
    const decision = JSON.parse((r.content as { text: string }[])[0]!.text) as { decision: string; grantId?: string };
    assert.equal(decision.decision, "allowed");
    const x = await client.callTool({ name: "execute_spend", arguments: { grantId: decision.grantId } });
    assert.equal(JSON.parse((x.content as { text: string }[])[0]!.text).status, "paid");
  } finally { await client.close().catch(() => undefined); await app.stop(); }
});

test("a degraded store takes readiness to 503 and money stops", async () => {
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
