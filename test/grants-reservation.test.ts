import { GrantStore } from "../src/grants";
import { evaluate, type Ledger } from "../src/evaluate";
import { parseMoney } from "../src/money";
import type { NormalizedRequest } from "../src/types";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}
function req(amount: string, payee = "x"): NormalizedRequest {
  return { amount: parseMoney(amount, "USD"), payee };
}

let t = 5_000_000;
const store = new GrantStore(600_000, () => t); // 10 min ttl
const ledger: Ledger = { spentSince: (s, c) => store.spentSince(s, c) };
const cfg = { maxPerDay: "$3.00" };

// Simulate the split-under-cap attack: mint under-cap grants without executing them.
store.mint(req("$2.00"), "policy"); // reserves $2 of the $3 daily cap

// A second $2 request must now be denied by reservation, even though nothing executed.
const ev = evaluate(cfg, req("$2.00"), ledger, "USD", t);
check("open grant reserves budget (split attack blocked)", ev.status === "denied" && ev.rule === "velocity");

// A $1 request still fits ($2 reserved + $1 = $3 <= cap).
check("remaining budget still spendable", evaluate(cfg, req("$1.00"), ledger, "USD", t).status === "allowed");

// Let the reservation expire → budget is released.
t = 5_000_000 + 600_001;
check("expired reservation is released", evaluate(cfg, req("$2.00"), ledger, "USD", t).status === "allowed");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
