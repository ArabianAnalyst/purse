import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlAuditStore } from "../src/audit";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

// A Purse 0.2 audit file: flat fields at the top level, no kind, no payload.
const dir = mkdtempSync(join(tmpdir(), "purse-audit-legacy-"));
const path = join(dir, "audit-0.2.jsonl");
const legacyLine = JSON.stringify({
  id: "a",
  ts: "2026-01-01T00:00:00.000Z",
  request: { amount: "$1.00", payee: "x" },
  status: "allowed",
  reason: "ok",
  policyVersion: "v",
  prevHash: "0".repeat(64),
  hash: "deadbeef",
});
writeFileSync(path, legacyLine + "\n");

let threw = false;
let message = "";
try {
  new JsonlAuditStore(path);
} catch (e) {
  threw = true;
  message = (e as Error).message;
}

check("throws on a Purse 0.2 flat audit file", threw);
check("error message matches /Purse 0.2/", /Purse 0\.2/.test(message));

rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
