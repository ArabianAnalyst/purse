import { GrantStore } from "../src/grants";
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

// controllable clock
let t = 1_000_000;
const store = new GrantStore(60_000, () => t); // 60s ttl

const g = store.mint(req("$5"), "policy");
check("mint returns an open grant", g.state === "open");
check("mint sets expiry from ttl", new Date(g.expiresAt).getTime() === 1_060_000);

const c1 = store.claim(g.id);
check("first claim succeeds", c1.ok === true);
store.markRedeemed(g.id);
const c2 = store.claim(g.id);
check("second claim on redeemed grant is rejected", c2.ok === false);

// expiry
const g2 = store.mint(req("$2"), "policy");
t = 1_000_000 + 60_001; // advance past ttl
const c3 = store.claim(g2.id);
check("expired grant cannot be claimed", c3.ok === false && c3.reason.includes("expired"));

// unknown id
check("unknown grant id is rejected", store.claim("nope").ok === false);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
