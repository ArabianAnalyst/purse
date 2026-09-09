import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReceiptLike } from "@olurabian/tripwire/monitor";
import { purseRecord } from "../src/purse-records.js";

const env = (kind: string, payload: unknown): ReceiptLike<unknown> => ({ id: "r1", ts: "2026-09-09T00:00:00.000Z", kind, payload, prevHash: "0".repeat(64), hash: "f".repeat(64) });
const request = { amount: { amount: 1250, currency: "USD" }, payee: "api.stripe.com", intent: "credits" };

test("grant_minted maps to an ok record with the grant in meta and no cost", () => {
  const r = purseRecord(env("decision", { request, status: "allowed", reason: "within policy", policyVersion: "p1", event: "grant_minted", grantId: "g1" }));
  assert.deepEqual(r, {
    action: "grant_minted",
    input: request,
    outcome: "ok",
    meta: { grantId: "g1", policyVersion: "p1", reason: "within policy", status: "allowed", paidAmount: undefined, currency: "USD" },
  });
});

test("executed with a settled amount carries it as cost and in meta", () => {
  const r = purseRecord(env("decision", { request, status: "allowed", reason: "executed", policyVersion: "p1", event: "executed", grantId: "g1", receipt: { ok: true, ref: "pi_1", paidAmount: { amount: 1200, currency: "USD" } } }));
  assert.equal(r?.action, "executed");
  assert.equal(r?.outcome, "ok");
  assert.equal(r?.cost, 1200);
  assert.deepEqual((r?.meta as { paidAmount: unknown }).paidAmount, { amount: 1200, currency: "USD" });
});

test("executed without a settled amount costs the requested amount", () => {
  const r = purseRecord(env("decision", { request, status: "allowed", reason: "executed", policyVersion: "p1", event: "executed", grantId: "g1", receipt: { ok: true } }));
  assert.equal(r?.cost, 1250);
});

test("execution_failed is an error record whatever the status, with the reason as error", () => {
  const r = purseRecord(env("decision", { request, status: "denied", reason: "rejected: grant not found", policyVersion: "p1", event: "execution_failed", grantId: "g1" }));
  assert.equal(r?.action, "execution_failed");
  assert.equal(r?.outcome, "error");
  assert.equal(r?.error, "rejected: grant not found");
  assert.equal(r?.cost, undefined);
});

test("denied is blocked, needs_approval is ok with pending in meta, a decision with no event is action decision", () => {
  const denied = purseRecord(env("decision", { request, status: "denied", reason: "not allowed", policyVersion: "p1", event: "decision" }));
  assert.equal(denied?.outcome, "blocked");
  const pending = purseRecord(env("decision", { request, status: "needs_approval", reason: "needs approval", policyVersion: "p1", event: "decision" }));
  assert.equal(pending?.outcome, "ok");
  assert.equal((pending?.meta as { pending?: boolean }).pending, true);
  const bare = purseRecord(env("decision", { request, status: "allowed", reason: "ok", policyVersion: "p1" }));
  assert.equal(bare?.action, "decision");
  assert.equal((bare?.meta as { pending?: boolean }).pending, undefined);
});

test("a receipt of another kind maps to null", () => {
  assert.equal(purseRecord(env("note", { anything: 1 })), null);
});

test("a decision without a request, or with an unknown status, throws so the source can skip it", () => {
  assert.throws(() => purseRecord(env("decision", { status: "allowed" })), /decision payload without a request/);
  assert.throws(() => purseRecord(env("decision", null)), /decision payload without a request/);
  assert.throws(() => purseRecord(env("decision", { request, status: "maybe", reason: "", policyVersion: "p1" })), /unknown decision status maybe/);
});
