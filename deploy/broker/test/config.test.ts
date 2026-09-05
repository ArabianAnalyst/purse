import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, ConfigError } from "../src/config.js";

const TOKEN = "a".repeat(32);
const base = { PURSE_ADMIN_TOKEN: TOKEN, DATABASE_URL: "postgres://u:p@h/db" };
const KEY = "0x" + "1".repeat(64);

test("minimal valid env", () => {
  const c = loadConfig(base);
  assert.equal(c.store.kind, "postgres");
  assert.equal(c.store.kind === "postgres" && c.store.stream, "purse");
  assert.equal(c.executor.kind, "mock");
  assert.deepEqual(c.ports, { agent: 8080, admin: 8081, bind: "0.0.0.0" });
  assert.equal(c.maxPending, 100);
  assert.equal(c.policy.currency, "USD");
  assert.equal(c.otel, false);
});

test("policy and ports parse", () => {
  const c = loadConfig({ ...base, PURSE_MAX_PER_ACTION: "$5", PURSE_MAX_PER_DAY: "$200", PURSE_REQUIRE_APPROVAL_OVER: "$50", PURSE_ALLOW: "a.com, b.com", PURSE_DENY: "c.com", PURSE_GRANT_TTL_MS: "5000", PURSE_AGENT_PORT: "9000", PURSE_ADMIN_PORT: "9001", PURSE_BIND: "127.0.0.1", PURSE_MAX_PENDING: "7", OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel:4318" });
  assert.deepEqual(c.policy, { currency: "USD", maxPerAction: "$5", maxPerDay: "$200", requireApprovalOver: "$50", allow: ["a.com", "b.com"], deny: ["c.com"], grantTtlMs: 5000 });
  assert.deepEqual(c.ports, { agent: 9000, admin: 9001, bind: "127.0.0.1" });
  assert.equal(c.maxPending, 7);
  assert.equal(c.otel, true);
});

test("admin token is required and at least 24 characters", () => {
  assert.throws(() => loadConfig({ DATABASE_URL: "postgres://x" }), (e: unknown) => e instanceof ConfigError && /PURSE_ADMIN_TOKEN/.test(e.message));
  assert.throws(() => loadConfig({ ...base, PURSE_ADMIN_TOKEN: "short" }), /at least 24/);
});

test("database is required unless jsonl is requested explicitly", () => {
  assert.throws(() => loadConfig({ PURSE_ADMIN_TOKEN: TOKEN }), /DATABASE_URL/);
  const c = loadConfig({ PURSE_ADMIN_TOKEN: TOKEN, PURSE_STORE: "jsonl", PURSE_AUDIT_FILE: "./x.jsonl" });
  assert.deepEqual(c.store, { kind: "jsonl", file: "./x.jsonl" });
});

test("x402 config: resources, signer, key file wins, mainnet gate", () => {
  const resources = JSON.stringify({ vendor: "https://pay.example/resource" });
  assert.throws(() => loadConfig({ ...base, PURSE_EXECUTOR: "x402" }), /PURSE_X402_RESOURCES/);
  assert.throws(() => loadConfig({ ...base, PURSE_EXECUTOR: "x402", PURSE_X402_RESOURCES: "{bad" }), /PURSE_X402_RESOURCES/);
  assert.throws(() => loadConfig({ ...base, PURSE_EXECUTOR: "x402", PURSE_X402_RESOURCES: resources, PURSE_X402_SIGNER: "evm", PURSE_X402_NETWORK: "base-sepolia" }), /PURSE_X402_PRIVATE_KEY or PURSE_X402_KEY_FILE/);
  const env = { ...base, PURSE_EXECUTOR: "x402", PURSE_X402_RESOURCES: resources, PURSE_X402_SIGNER: "evm", PURSE_X402_NETWORK: "base-sepolia", PURSE_X402_PRIVATE_KEY: "0x" + "2".repeat(64), PURSE_X402_KEY_FILE: "/run/secrets/key" };
  const c = loadConfig(env, () => `${KEY}\n`);
  assert.equal(c.executor.kind, "x402");
  if (c.executor.kind === "x402") {
    assert.equal(c.executor.privateKey, KEY);
    assert.equal(c.executor.network, "base-sepolia");
    assert.deepEqual(c.executor.resources, { vendor: "https://pay.example/resource" });
  }
  assert.throws(() => loadConfig({ ...env, PURSE_X402_NETWORK: "base" }, () => KEY), /PURSE_X402_ALLOW_MAINNET/);
  assert.throws(() => loadConfig({ ...env, PURSE_X402_PRIVATE_KEY: "nothex", PURSE_X402_KEY_FILE: undefined }), /64 hex/);
  assert.throws(() => loadConfig({ ...env, PURSE_CURRENCY: "EUR" }, () => KEY), /USD/);
  const m = loadConfig({ ...base, PURSE_EXECUTOR: "x402", PURSE_X402_RESOURCES: resources, PURSE_X402_NETWORK: "mock" });
  assert.equal(m.executor.kind === "x402" && m.executor.signer, "mock");
  assert.throws(() => loadConfig({ ...base, PURSE_EXECUTOR: "x402", PURSE_X402_RESOURCES: resources, PURSE_X402_SIGNER: "evm", PURSE_X402_NETWORK: "mock", PURSE_X402_PRIVATE_KEY: KEY }), /mock network/);
});

test("rejects a bad network, a mock signer on a real network, and negative ports", () => {
  const resources = JSON.stringify({ vendor: "https://pay.example/resource" });
  assert.throws(() => loadConfig({ ...base, PURSE_EXECUTOR: "x402", PURSE_X402_RESOURCES: resources, PURSE_X402_SIGNER: "mock", PURSE_X402_NETWORK: "polygon" }), /PURSE_X402_NETWORK must be/);
  assert.throws(() => loadConfig({ ...base, PURSE_EXECUTOR: "x402", PURSE_X402_RESOURCES: resources, PURSE_X402_SIGNER: "mock", PURSE_X402_NETWORK: "base-sepolia" }), /only valid with PURSE_X402_NETWORK=mock/);
  assert.throws(() => loadConfig({ ...base, PURSE_AGENT_PORT: "-1" }), /non-negative integer/);
  assert.throws(() => loadConfig({ ...base, PURSE_MAX_PENDING: "1.5" }), /non-negative integer/);
});
