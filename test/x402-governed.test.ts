import { spawnAgent, serveBroker, Broker } from "../src/index";
import { X402Executor } from "../examples/x402/x402-executor";
import { MockSigner } from "../examples/x402/mock-signer";
import { startMock402 } from "../examples/x402/mock-402-server";
import { fileURLToPath } from "node:url";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

// Two priced mock resources (parent-side; the agent never sees them).
const acme = await startMock402({ amount: "300", payTo: "acme" });
const premium = await startMock402({ amount: "7500", payTo: "premium" });
const resources: Record<string, string> = { "acme.example": acme.url, "premium.example": premium.url };

const broker = new Broker({
  maxPerAction: "$150",
  maxPerDay: "$90",
  allow: ["acme.example", "premium.example"],
  requireApprovalOver: "$50",
  executor: new X402Executor({ resolvePayee: (p) => resources[p], signer: new MockSigner() }),
});

const child = spawnAgent(fileURLToPath(new URL("../examples/x402/agent.ts", import.meta.url)));
serveBroker(child, broker);

const report: Record<string, unknown> = await new Promise((resolve) => {
  child.on("message", (m: { kind?: string; pendingId?: string; data?: Record<string, unknown> }) => {
    if (m?.kind === "await-approval" && m.pendingId) {
      const { grantId } = broker.approve(m.pendingId);
      child.send({ kind: "approved", grantId });
    }
    if (m?.kind === "report") resolve(m.data ?? {});
  });
});
child.kill();
await acme.close();
await premium.close();

check("scene 1: in-policy spend settled over x402", report.normalPaid === true);
check("scene 2: injected off-allowlist payment denied", report.injectionDenied === true);
check("scene 3: over-threshold settled only after principal approval", report.approvedPaid === true);
check("scene 4: split-under-cap attack was blocked at least once", report.splitBlocked === true);
check("scene 5: audit chain verifies (broker side)", broker.verify().ok === true);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
