// The principal's process: holds the Broker + the X402Executor (credential) + the resource map.
// Spawns the agent as a subordinate child. Run: npm run demo:x402
import { Broker, serveBroker, spawnAgent } from "../../src/index";
import { X402Executor } from "./x402-executor";
import { MockSigner } from "./mock-signer";
import { startMock402 } from "./mock-402-server";
import { fileURLToPath } from "node:url";

const acme = await startMock402({ amount: "300", payTo: "acme" });       // $3.00
const premium = await startMock402({ amount: "7500", payTo: "premium" }); // $75.00
const resources: Record<string, string> = { "acme.example": acme.url, "premium.example": premium.url };

const broker = new Broker({
  maxPerAction: "$150",
  maxPerDay: "$90",
  allow: ["acme.example", "premium.example"],
  requireApprovalOver: "$50",
  executor: new X402Executor({ resolvePayee: (p) => resources[p], signer: new MockSigner() }),
});

const child = spawnAgent(fileURLToPath(new URL("./agent.ts", import.meta.url)), { execArgv: ["--import", "tsx"] });
serveBroker(child, broker);

child.on("message", async (m: { kind?: string; pendingId?: string }) => {
  if (m?.kind === "await-approval" && m.pendingId) {
    console.log(`  [principal] approving pending ${m.pendingId} (out of band)`);
    const { grantId } = broker.approve(m.pendingId);
    child.send({ kind: "approved", grantId });
  }
  if ((m as { kind?: string }).kind === "report") {
    const executed = broker.audit().filter((r) => r.event === "executed");
    console.log(`\n  [proof] audit records: ${broker.audit().length}`);
    console.log(`  [proof] x402 settlements: ${executed.length} (refs: ${executed.map((r) => r.receipt?.ref).join(", ")})`);
    console.log(`  [proof] tamper-evident chain intact: ${broker.verify().ok}`);
    await acme.close();
    await premium.close();
    child.kill();
    process.exit(0);
  }
});
