import { test } from "node:test";
import assert from "node:assert/strict";
import { loadMonitorConfig, parseSpan, MonitorConfigError } from "../src/monitor-config.js";

const base = () => ({ DATABASE_URL: "postgres://x" });

test("defaults", () => {
  const c = loadMonitorConfig(base());
  assert.equal(c.stream, "purse");
  assert.equal(c.table, "receipts");
  assert.equal(c.intervalMs, 60000);
  assert.deepEqual(c.window, { count: 500, ms: 24 * 60 * 60 * 1000 });
  assert.deepEqual(c.velocity, { count: 5, ms: 10 * 60 * 1000 });
  assert.deepEqual(c.disable, []);
  assert.equal(c.expectationsModule, undefined);
  assert.deepEqual(c.deadlatch, { url: "https://www.deadlatch.dev", projectKey: undefined });
  assert.equal(c.flagsFile, "/data/flags.jsonl");
  assert.equal(c.port, 8083);
  assert.equal(c.bind, "0.0.0.0");
  assert.equal(c.otel, false);
});

test("PURSE_STREAM is the fallback for MONITOR_STREAM, and MONITOR_STREAM wins", () => {
  assert.equal(loadMonitorConfig({ ...base(), PURSE_STREAM: "s1" }).stream, "s1");
  assert.equal(loadMonitorConfig({ ...base(), PURSE_STREAM: "s1", MONITOR_STREAM: "s2" }).stream, "s2");
});

test("DATABASE_URL is required", () => {
  assert.throws(() => loadMonitorConfig({}), (e: unknown) => e instanceof MonitorConfigError && /DATABASE_URL is required/.test((e as Error).message));
});

test("parseSpan reads count and duration in m, h or d", () => {
  assert.deepEqual(parseSpan("X", "500/24h"), { count: 500, ms: 86_400_000 });
  assert.deepEqual(parseSpan("X", "5/10m"), { count: 5, ms: 600_000 });
  assert.deepEqual(parseSpan("X", "1/2d"), { count: 1, ms: 172_800_000 });
  assert.deepEqual(parseSpan("X", " 7/1h "), { count: 7, ms: 3_600_000 });
});

test("parseSpan rejects the wrong shape, an unknown unit, and zero", () => {
  for (const bad of ["500", "500/24", "500/24s", "abc/1h", "/1h", "500/", "0/1h", "5/0m"]) {
    assert.throws(() => parseSpan("MONITOR_WINDOW", bad), (e: unknown) => e instanceof MonitorConfigError && /MONITOR_WINDOW/.test((e as Error).message), bad);
  }
});

test("MONITOR_WINDOW and MONITOR_VELOCITY are parsed and validated at load", () => {
  const c = loadMonitorConfig({ ...base(), MONITOR_WINDOW: "100/2h", MONITOR_VELOCITY: "3/1m" });
  assert.deepEqual(c.window, { count: 100, ms: 7_200_000 });
  assert.deepEqual(c.velocity, { count: 3, ms: 60_000 });
  assert.throws(() => loadMonitorConfig({ ...base(), MONITOR_VELOCITY: "3 per minute" }), /MONITOR_VELOCITY/);
});

test("DEADLATCH_URL is trimmed of trailing slashes and must be http or https", () => {
  assert.equal(loadMonitorConfig({ ...base(), DEADLATCH_URL: "https://deadlatch.test///" }).deadlatch.url, "https://deadlatch.test");
  assert.throws(() => loadMonitorConfig({ ...base(), DEADLATCH_URL: "deadlatch.test" }), /DEADLATCH_URL must start with/);
});

test("an empty DEADLATCH_PROJECT_KEY is no key", () => {
  assert.equal(loadMonitorConfig({ ...base(), DEADLATCH_PROJECT_KEY: "" }).deadlatch.projectKey, undefined);
  assert.equal(loadMonitorConfig({ ...base(), DEADLATCH_PROJECT_KEY: "dl_live_abc" }).deadlatch.projectKey, "dl_live_abc");
});

test("MONITOR_DISABLE splits on commas and drops blanks, MONITOR_EXPECTATIONS is a path", () => {
  const c = loadMonitorConfig({ ...base(), MONITOR_DISABLE: " executed-once, ,payee-velocity ", MONITOR_EXPECTATIONS: "/etc/purse/expectations.mjs" });
  assert.deepEqual(c.disable, ["executed-once", "payee-velocity"]);
  assert.equal(c.expectationsModule, "/etc/purse/expectations.mjs");
});

test("integers are validated with their floor", () => {
  assert.throws(() => loadMonitorConfig({ ...base(), MONITOR_INTERVAL_MS: "500" }), /MONITOR_INTERVAL_MS must be an integer of at least 1000/);
  assert.throws(() => loadMonitorConfig({ ...base(), MONITOR_PORT: "-1" }), /MONITOR_PORT must be an integer of at least 0/);
  assert.equal(loadMonitorConfig({ ...base(), MONITOR_PORT: "0" }).port, 0);
});

test("otel is on only when the OTLP endpoint is set", () => {
  assert.equal(loadMonitorConfig({ ...base(), OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }).otel, true);
});
