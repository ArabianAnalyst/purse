import { startMock402 } from "../examples/x402/mock-402-server";
import { MockSigner } from "../examples/x402/mock-signer";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

const server = await startMock402({ amount: "500", payTo: "acme" });

// unpaid GET -> 402 with a single payment requirement
const r1 = await fetch(server.url);
check("unpaid GET returns 402", r1.status === 402);
const body = await r1.json() as { accepts?: Array<{ maxAmountRequired: string; payTo: string }> };
check("challenge carries the configured amount", body.accepts?.[0]?.maxAmountRequired === "500");
check("challenge carries the payTo", body.accepts?.[0]?.payTo === "acme");

// GET with X-PAYMENT -> 200 with a settlement ref
const r2 = await fetch(server.url, { headers: { "X-PAYMENT": "anything" } });
check("paid GET returns 200", r2.status === 200);
const settle = await r2.json() as { ok: boolean; ref: string };
check("settlement carries a ref", settle.ok === true && typeof settle.ref === "string");

// mock signer is deterministic and encodes the challenge
const sig = await new MockSigner().sign({ scheme: "exact", network: "mock", maxAmountRequired: "500", payTo: "acme", asset: "USD-cents", resource: "/" });
check("mock signer returns a non-empty header value", typeof sig === "string" && sig.length > 0);

await server.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
