import { fileURLToPath } from "node:url";
import { spawnAgent, serveBroker } from "../src/server";
import { Broker } from "../src/broker";
import { MockExecutor } from "../src/executor";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

// The broker lives HERE (parent, holds the executor/credential).
const broker = new Broker({ maxPerAction: "$5", allow: ["api.stripe.com"], requireApprovalOver: "$50", executor: new MockExecutor() });
const child = spawnAgent(fileURLToPath(new URL("./fixtures/agent-child.ts", import.meta.url)));
serveBroker(child, broker);

// The child (agent) runs a scripted flow and reports its results back on a "report" message.
const report: Record<string, unknown> = await new Promise((resolve) => {
  child.on("message", (m: { kind?: string; data?: Record<string, unknown> }) => {
    if (m && m.kind === "report") resolve(m.data ?? {});
  });
});
child.kill();

check("agent got a grant for an in-policy spend", report.allowedGrant === true);
check("agent settled the spend across the process boundary", report.paid === true);
check("agent's injected off-allowlist payment was denied", report.injectionDenied === true);
check("audit chain (broker side) verifies after cross-process flow", broker.verify().ok === true);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
