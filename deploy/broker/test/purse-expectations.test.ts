import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Trace } from "@olurabian/tripwire";
import { evaluate, type LiveRecord } from "@olurabian/tripwire/monitor";
import { BUILTIN_IDS, builtinExpectations, loadExpectations } from "../src/purse-expectations.js";

const T0 = Date.UTC(2026, 8, 9, 0, 0, 0);
const at = (minute: number) => new Date(T0 + minute * 60_000);

interface Opts { grant?: string; payee?: string; amount?: number; currency?: string; paid?: number; paidCurrency?: string; minute?: number }

/** A live record at `seq`, timestamped `seq` minutes in unless `minute` is given. */
function rec(seq: number, action: "grant_minted" | "executed" | "execution_failed" | "decision", o: Opts = {}): LiveRecord {
  const currency = o.currency ?? "USD";
  const paid = o.paid === undefined ? undefined : { amount: o.paid, currency: o.paidCurrency ?? currency };
  return {
    action,
    input: { amount: { amount: o.amount ?? 1250, currency }, payee: o.payee ?? "api.stripe.com" },
    outcome: action === "execution_failed" ? "error" : "ok",
    meta: { grantId: o.grant, paidAmount: paid, currency },
    ref: { stream: "t", seq, id: `id-${seq}`, hash: "a".repeat(64), ts: at(o.minute ?? seq).toISOString() },
  };
}

const exps = builtinExpectations({ count: 5, ms: 10 * 60_000 });
const ids = (records: LiveRecord[]) => {
  const last = records[records.length - 1]!;
  return evaluate(exps, last, new Trace(records), at(99)).map((f) => f.expectation.id);
};

test("the four built-ins carry the spec's ids and reasons", () => {
  assert.deepEqual(exps.map((e) => e.id), [...BUILTIN_IDS]);
  assert.deepEqual(exps.map((e) => e.reason), [
    "An execution happened for a grant this window never saw minted.",
    "A single-use grant executed twice.",
    "The rail settled a different amount than the decision allowed.",
    "The same payee was paid too many times too quickly.",
  ]);
});

test("executed-without-grant holds when the grant was minted earlier in the window", () => {
  assert.deepEqual(ids([rec(1, "grant_minted", { grant: "g1" }), rec(2, "executed", { grant: "g1" })]), []);
});

test("executed-without-grant fires with no minted record, a minted record for another grant, a minted record later than the execution, or no grant at all", () => {
  assert.deepEqual(ids([rec(1, "executed", { grant: "g1" })]), ["executed-without-grant"]);
  assert.deepEqual(ids([rec(1, "grant_minted", { grant: "g2" }), rec(2, "executed", { grant: "g1" })]), ["executed-without-grant"]);
  assert.deepEqual(ids([rec(2, "grant_minted", { grant: "g1" }), rec(1, "executed", { grant: "g1" })]), ["executed-without-grant"]);
  assert.deepEqual(ids([rec(1, "grant_minted", { grant: "g1" }), rec(2, "executed", {})]), ["executed-without-grant"]);
});

test("executed-once fires on a second execution of the same grant and not on a different grant", () => {
  const minted = [rec(1, "grant_minted", { grant: "g1" }), rec(2, "grant_minted", { grant: "g2" })];
  assert.deepEqual(ids([...minted, rec(3, "executed", { grant: "g1" }), rec(4, "executed", { grant: "g1" })]), ["executed-once"]);
  assert.deepEqual(ids([...minted, rec(3, "executed", { grant: "g1" }), rec(4, "executed", { grant: "g2" })]), []);
  assert.deepEqual(ids([...minted, rec(3, "execution_failed", { grant: "g1" }), rec(4, "executed", { grant: "g1" })]), []);
});

test("paid-matches-decision holds on the minted amount and currency, fires on a different amount or currency, and holds with no settled amount or no minted record", () => {
  const minted = rec(1, "grant_minted", { grant: "g1", amount: 1250 });
  assert.deepEqual(ids([minted, rec(2, "executed", { grant: "g1", paid: 1250 })]), []);
  assert.deepEqual(ids([minted, rec(2, "executed", { grant: "g1", paid: 1200 })]), ["paid-matches-decision"]);
  assert.deepEqual(ids([minted, rec(2, "executed", { grant: "g1", paid: 1250, paidCurrency: "EUR" })]), ["paid-matches-decision"]);
  assert.deepEqual(ids([minted, rec(2, "executed", { grant: "g1" })]), []);
  assert.deepEqual(ids([rec(2, "executed", { grant: "g1", paid: 99 })]), ["executed-without-grant"]);
});

test("payee-velocity fires on the fifth execution to one payee inside ten minutes, and not when spread out, to different payees, or four", () => {
  // mints sit at low seqs and minute 0, executions at seqs 11 and up, one per minute, so only velocity can fire
  const mint = (n: number) => rec(n, "grant_minted", { grant: `g${n}`, minute: 0 });
  const burst = (n: number, o: Opts = {}) => Array.from({ length: n }, (_, i) => rec(11 + i, "executed", { grant: `g${i + 1}`, minute: i + 1, ...o }));
  const mints = Array.from({ length: 5 }, (_, i) => mint(i + 1));
  assert.deepEqual(ids([...mints, ...burst(4)]), []);
  assert.deepEqual(ids([...mints, ...burst(5)]), ["payee-velocity"]);
  const spread = burst(5).map((r, i) => ({ ...r, ref: { ...r.ref, ts: at(i * 3).toISOString() } }));
  assert.deepEqual(ids([...mints, ...spread]), []);
  const mixed = burst(5).map((r, i) => (i === 0 ? { ...r, input: { ...(r.input as object), payee: "other.example" } } : r));
  assert.deepEqual(ids([...mints, ...mixed]), []);
});

test("payee-velocity counts only executions at or before the record's own receipt time, so a later-timestamped record already in the window cannot inflate an earlier one", () => {
  const mints = Array.from({ length: 5 }, (_, i) => rec(i + 1, "grant_minted", { grant: `g${i + 1}`, minute: 0 }));
  // four executions timestamped minutes 20 to 23 are already in the window
  const later = Array.from({ length: 4 }, (_, i) => rec(11 + i, "executed", { grant: `g${i + 1}`, minute: 20 + i }));
  // the record under evaluation is the last one appended but carries an earlier timestamp, minute 15
  const earlier = rec(15, "executed", { grant: "g5", minute: 15 });
  assert.deepEqual(ids([...mints, ...later, earlier]), []);
  // the same record timestamped after the four trips the rule
  const latest = rec(15, "executed", { grant: "g5", minute: 24 });
  assert.deepEqual(ids([...mints, ...later, latest]), ["payee-velocity"]);
});

test("loadExpectations applies MONITOR_DISABLE and rejects an unknown id", async () => {
  const some = await loadExpectations({ velocity: { count: 5, ms: 600_000 }, disable: ["executed-once", "payee-velocity"], expectationsModule: undefined });
  assert.deepEqual(some.map((e) => e.id), ["executed-without-grant", "paid-matches-decision"]);
  await assert.rejects(loadExpectations({ velocity: { count: 5, ms: 600_000 }, disable: ["nope"], expectationsModule: undefined }), /unknown built-in "nope"/);
});

test("loadExpectations loads a custom module after the built-ins, and a colliding id is a boot error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "purse-monitor-exp-"));
  const ok = join(dir, "ok.mjs");
  writeFileSync(ok, `export default [{ id: "no-big-tips", reason: "A tip over 100.", where: { action: "executed" }, must: (r) => r.input.amount.amount <= 100 }];\n`);
  const all = await loadExpectations({ velocity: { count: 5, ms: 600_000 }, disable: [], expectationsModule: ok });
  assert.deepEqual(all.map((e) => e.id), [...BUILTIN_IDS, "no-big-tips"]);
  const clash = join(dir, "clash.mjs");
  writeFileSync(clash, `export default [{ id: "executed-once", reason: "x", must: () => true }];\n`);
  await assert.rejects(loadExpectations({ velocity: { count: 5, ms: 600_000 }, disable: [], expectationsModule: clash }), /Duplicate expectation id: executed-once/);
  const notArray = join(dir, "notarray.mjs");
  writeFileSync(notArray, `export default { id: "x" };\n`);
  await assert.rejects(loadExpectations({ velocity: { count: 5, ms: 600_000 }, disable: [], expectationsModule: notArray }), /must default-export an array/);
  await assert.rejects(loadExpectations({ velocity: { count: 5, ms: 600_000 }, disable: [], expectationsModule: join(dir, "missing.mjs") }), /cannot load MONITOR_EXPECTATIONS/);
});
