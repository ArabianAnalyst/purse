import { JsonlAuditStore, makeRecord, verifyChain, hashRecord } from "../src/audit";
import { parseMoney } from "../src/money";
import type { NormalizedRequest, Explain } from "../src/types";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

const req: NormalizedRequest = { amount: parseMoney("$1", "USD"), payee: "x" };
const explain: Explain = { rule: "within-policy", policyVersion: "v1", evaluated: { amount: req.amount, payee: "x" } };

const store = new JsonlAuditStore();
makeRecord(store, { request: req, status: "allowed", reason: "ok", policyVersion: "v1", event: "decision", explain });
makeRecord(store, { request: req, status: "allowed", reason: "paid", policyVersion: "v1", event: "executed", receipt: { ok: true, ref: "r1" } });

check("chain with explain verifies", verifyChain(store.all()).ok === true);
check("explain is persisted", store.all()[0]!.explain?.rule === "within-policy");
check("event is persisted", store.all()[1]!.event === "executed");

// tampering the explain breaks the chain
const tampered = store.all();
tampered[0]!.explain!.rule = "deny-list";
check("tampered explain is detected", verifyChain(tampered).ok === false);

// a v0.1-shaped record (no event/explain) still hashes stably
const legacy = { id: "a", ts: "2026-01-01T00:00:00.000Z", request: req, status: "allowed" as const, reason: "ok", policyVersion: "v1", prevHash: "0".repeat(64) };
const h1 = hashRecord(legacy);
const h2 = hashRecord({ ...legacy, event: undefined, explain: undefined });
check("undefined new fields do not change legacy hash", h1 === h2);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
