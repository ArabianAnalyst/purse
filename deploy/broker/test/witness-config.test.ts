import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { loadWitnessConfig, parseLogKey, WitnessConfigError } from "../src/witness-config.js";

const ed = () => Buffer.from(generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" })).toString("base64");
const base = () => ({ DATABASE_URL: "postgres://x", WITNESS_KEY_FILE: "/data/witness-key.pem", REKOR_LOG_KEY: `log2025-1.rekor.sigstore.dev=${ed()}` });

test("defaults", () => {
  const c = loadWitnessConfig(base());
  assert.equal(c.stream, "purse");
  assert.equal(c.table, "receipts");
  assert.equal(c.rekor.url, "https://log2025-1.rekor.sigstore.dev");
  assert.equal(c.rekor.timeoutMs, 30000);
  assert.equal(c.intervalMs, 300000);
  assert.equal(c.maxLag, 2);
  assert.equal(c.port, 8082);
  assert.equal(c.bind, "0.0.0.0");
  assert.equal(c.otel, false);
  assert.equal(c.key.file, "/data/witness-key.pem");
  assert.equal(c.key.pem, undefined);
});

test("PURSE_STREAM is the fallback for WITNESS_STREAM", () => {
  assert.equal(loadWitnessConfig({ ...base(), PURSE_STREAM: "s1" }).stream, "s1");
  assert.equal(loadWitnessConfig({ ...base(), PURSE_STREAM: "s1", WITNESS_STREAM: "s2" }).stream, "s2");
});

test("the key comes from a file, a pem, or both with the file winning", () => {
  const pem = "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n";
  const { WITNESS_KEY_FILE: _f, ...noFile } = base();
  assert.equal(loadWitnessConfig({ ...noFile, WITNESS_KEY_PEM: pem }).key.pem, pem);
  const both = loadWitnessConfig({ ...base(), WITNESS_KEY_PEM: pem });
  assert.equal(both.key.file, "/data/witness-key.pem");
  assert.equal(both.key.pem, pem);
  assert.throws(() => loadWitnessConfig(noFile), /WITNESS_KEY_FILE or WITNESS_KEY_PEM/);
});

test("REKOR_LOG_KEY must be origin=base64 of an Ed25519 SPKI key", () => {
  const k = parseLogKey(`o.example=${ed()}`);
  assert.equal(k.origin, "o.example");
  const { REKOR_LOG_KEY: _k, ...noKey } = base();
  assert.throws(() => loadWitnessConfig(noKey), /REKOR_LOG_KEY is required/);
  assert.throws(() => loadWitnessConfig({ ...base(), REKOR_LOG_KEY: "nokey" }), /REKOR_LOG_KEY must be/);
  assert.throws(() => loadWitnessConfig({ ...base(), REKOR_LOG_KEY: "=abc" }), /REKOR_LOG_KEY must be/);
  const p256 = Buffer.from(generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "der" })).toString("base64");
  assert.throws(() => loadWitnessConfig({ ...base(), REKOR_LOG_KEY: `o=${p256}` }), /Ed25519/);
});

test("numbers and the url are validated", () => {
  assert.throws(() => loadWitnessConfig({ ...base(), WITNESS_INTERVAL_MS: "500" }), /WITNESS_INTERVAL_MS/);
  assert.throws(() => loadWitnessConfig({ ...base(), WITNESS_MAX_LAG: "0" }), /WITNESS_MAX_LAG/);
  assert.throws(() => loadWitnessConfig({ ...base(), WITNESS_PORT: "x" }), /WITNESS_PORT/);
  assert.throws(() => loadWitnessConfig({ ...base(), REKOR_URL: "log.example" }), /REKOR_URL/);
  assert.throws(() => loadWitnessConfig({ ...base(), DATABASE_URL: "" }), /DATABASE_URL/);
  assert.equal(loadWitnessConfig({ ...base(), WITNESS_INTERVAL_MS: "1000", WITNESS_MAX_LAG: "3", WITNESS_PORT: "9000", REKOR_TIMEOUT_MS: "20000", OTEL_EXPORTER_OTLP_ENDPOINT: "http://o" }).otel, true);
  const c = loadWitnessConfig({ ...base(), WITNESS_INTERVAL_MS: "1000", WITNESS_MAX_LAG: "3", WITNESS_PORT: "9000", REKOR_TIMEOUT_MS: "20000" });
  assert.deepEqual([c.intervalMs, c.maxLag, c.port, c.rekor.timeoutMs], [1000, 3, 9000, 20000]);
});

test("errors carry the prefix", () => {
  try { loadWitnessConfig({}); assert.fail("should throw"); }
  catch (e) { assert.ok(e instanceof WitnessConfigError); assert.match((e as Error).message, /^purse-witness config: /); }
});
