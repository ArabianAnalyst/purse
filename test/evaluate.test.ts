import { evaluate, type Ledger } from "../src/evaluate";
import { parseMoney, zero } from "../src/money";
import type { NormalizedRequest } from "../src/types";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

const empty: Ledger = { spentSince: (_s, c) => zero(c) };
function req(amount: string, payee: string, category?: string): NormalizedRequest {
  return { amount: parseMoney(amount, "USD"), payee, category };
}

// rule reporting
check("deny-list rule", evaluate({ deny: ["evil.io"] }, req("$1", "evil.io"), empty, "USD", 0).rule === "deny-list");
check("allowlist-miss rule", evaluate({ allow: ["ok.com"] }, req("$1", "x.io"), empty, "USD", 0).rule === "allowlist-miss");
check("per-action-cap rule", evaluate({ maxPerAction: "$5" }, req("$6", "x"), empty, "USD", 0).rule === "per-action-cap");
check("within-policy rule", evaluate({}, req("$1", "x"), empty, "USD", 0).rule === "within-policy");
check("require-approval status", evaluate({ requireApprovalOver: "$2" }, req("$3", "x"), empty, "USD", 0).status === "needs_approval");

// velocity uses injected ledger + reservation reported
{
  const used = parseMoney("$3", "USD");
  const ledger: Ledger = { spentSince: (_s, c) => (c === "USD" ? used : zero(c)) };
  const r = evaluate({ maxPerDay: "$3" }, req("$1", "x"), ledger, "USD", 86_400_001);
  check("velocity denies over cap", r.status === "denied" && r.rule === "velocity");
  check("velocity reports reservation", r.reservation?.cap.amount === 300 && r.reservation?.used.amount === 300);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
