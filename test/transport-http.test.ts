import { serveHttp, HttpPurseClient } from "../src/transport/http";
import { Broker } from "../src/broker";
import { MockExecutor } from "../src/executor";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

const broker = new Broker({ maxPerAction: "$5", allow: ["api.stripe.com"], requireApprovalOver: "$50", executor: new MockExecutor() });
const server = await serveHttp(broker, { port: 0 });
const client = new HttpPurseClient(server.url);

const r = await client.request({ amount: "$3", payee: "api.stripe.com", intent: "credits" });
check("http request returns a grant", r.decision === "allowed" && !!r.grantId);
check("http execute settles", (await client.execute(r.grantId!)).status === "paid");

const bad = await client.request({ amount: "$1", payee: "attacker.evil" });
check("http off-allowlist denied", bad.decision === "denied");

await server.close();
const afterClose = await client.request({ amount: "$1", payee: "api.stripe.com" });
check("fail-closed when broker unreachable", afterClose.decision === "denied");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
