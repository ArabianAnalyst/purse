import { MockExecutor, scrubReceipt } from "../src/executor";
import { parseMoney } from "../src/money";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

const payable = { id: "g_1234abcd", payee: "api.stripe.com", amount: parseMoney("$5", "USD") };

const ok = await new MockExecutor().execute(payable);
check("mock succeeds by default", ok.ok === true && typeof ok.ref === "string");
check("mock echoes paid amount", ok.paidAmount?.amount === 500);

const bad = await new MockExecutor({ fail: true }).execute(payable);
check("mock can be forced to fail", bad.ok === false && typeof bad.error === "string");

const scrubbed = scrubReceipt({ ok: true, ref: "r1", raw: { secret: "sk_live_xxx" } });
check("scrub drops raw/secret fields", (scrubbed as Record<string, unknown>).raw === undefined && scrubbed.ref === "r1");

const scrubbedPaid = scrubReceipt({ ok: true, ref: "r2", paidAmount: parseMoney("$3", "USD"), raw: { secret: "x" } });
check("scrub carries the settled paidAmount, still drops raw", scrubbedPaid.paidAmount?.amount === 300 && (scrubbedPaid as Record<string, unknown>).raw === undefined);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
