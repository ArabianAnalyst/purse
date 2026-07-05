// The principal's process: holds the Broker + the executor (credential). Spawns the agent.
import { fileURLToPath } from "node:url";
import { Broker, serveBroker, spawnAgent } from "../../src/index";
import { MockExecutor } from "../../src/index";

const broker = new Broker({
  // NOTE: maxPerAction must stay ABOVE requireApprovalOver. evaluate.ts checks the
  // per-action cap before the approval threshold, so a cap <= the threshold would
  // deny (per-action-cap) every over-threshold request before it could ever reach
  // needs_approval. $150 leaves room for the $120 over-threshold scene below.
  maxPerAction: "$150",
  maxPerDay: "$200",
  allow: ["api.stripe.com", "*.aws.amazon.com"],
  requireApprovalOver: "$50",
  executor: new MockExecutor(),
});

const child = spawnAgent(fileURLToPath(new URL("./agent.ts", import.meta.url)));
serveBroker(child, broker);

child.on("message", (m: { kind?: string; pendingId?: string }) => {
  if (m?.kind === "await-approval" && m.pendingId) {
    console.log(`  [principal] approving pending ${m.pendingId} (out of band)`);
    const { grantId } = broker.approve(m.pendingId);
    child.send({ kind: "approved", grantId });
  }
  if (m?.kind === "done") {
    console.log(`\n  [proof] audit records: ${broker.audit().length}`);
    console.log(`  [proof] tamper-evident chain intact: ${broker.verify().ok}`);
    child.kill();
    process.exit(0);
  }
});
