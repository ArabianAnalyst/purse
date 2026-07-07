// broker-host-llm.ts — same broker/executor/mock setup as broker-host.ts, but spawns the
// LLM-driven agent. Run: ANTHROPIC_API_KEY=sk-... npm run demo:x402:llm
import { Broker, serveBroker, spawnAgent } from "../../src/index";
import { X402Executor } from "./x402-executor";
import { MockSigner } from "./mock-signer";
import { startMock402 } from "./mock-402-server";
import { fileURLToPath } from "node:url";

const acme = await startMock402({ amount: "300", payTo: "acme" });
const resources: Record<string, string> = { "acme.example": acme.url };

const broker = new Broker({
  maxPerAction: "$150", maxPerDay: "$90",
  allow: ["acme.example"], requireApprovalOver: "$50",
  executor: new X402Executor({ resolvePayee: (p) => resources[p], signer: new MockSigner() }),
});

const child = spawnAgent(fileURLToPath(new URL("./governed-agent-llm.ts", import.meta.url)), { execArgv: ["--import", "tsx"] });
serveBroker(child, broker);
child.on("message", async (m: { kind?: string }) => {
  if (m?.kind === "report") {
    console.log(`\n  [proof] chain intact: ${broker.verify().ok}; settlements: ${broker.audit().filter((r) => r.event === "executed").length}`);
    await acme.close();
    child.kill();
    process.exit(0);
  }
});

// If the child exits on its own (e.g. no ANTHROPIC_API_KEY -> it exits before sending a
// report), clean up and exit instead of hanging with the mock server still listening.
child.on("exit", async (code) => {
  await acme.close().catch(() => {});
  process.exit(code ?? 0);
});
