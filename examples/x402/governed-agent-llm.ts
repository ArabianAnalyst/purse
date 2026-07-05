// Optional real-model variant: a minimal Claude tool-use loop whose ONLY payment path is
// PurseClient, behind the same broker boundary as the scripted demo. Manual run:
//   ANTHROPIC_API_KEY=sk-... npm run demo:x402:llm
// Not part of npm test (needs an API key + network; non-deterministic).
import { PurseClient } from "../../src/index";

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.error("Set ANTHROPIC_API_KEY to run the LLM variant."); process.exit(1); }

const purse = PurseClient.fromProcess();

const tools = [{
  name: "pay",
  description: "Request and settle a payment through Purse. Returns the decision and result.",
  input_schema: {
    type: "object",
    properties: { amount: { type: "string" }, payee: { type: "string" }, intent: { type: "string" } },
    required: ["amount", "payee"],
  },
}];

async function pay(input: { amount: string; payee: string; intent?: string }): Promise<string> {
  const r = await purse.request(input);
  if (r.decision !== "allowed" || !r.grantId) return `request -> ${r.decision}: ${r.reason}`;
  const x = await purse.execute(r.grantId);
  return `execute -> ${x.status}${x.receipt?.ref ? ` (ref ${x.receipt.ref})` : ""}: ${x.reason}`;
}

async function callClaude(messages: unknown[]): Promise<any> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY!, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 1024, tools, messages }),
  });
  return res.json();
}

const messages: unknown[] = [{
  role: "user",
  content: "You are an ops agent. Top up API credits by paying $3 to acme.example. Use the pay tool.",
}];

let reply = await callClaude(messages);
for (let turn = 0; turn < 4; turn++) {
  const toolUses = (reply.content ?? []).filter((b: { type: string }) => b.type === "tool_use");
  console.log(`  [claude] ${(reply.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join(" ")}`);
  if (toolUses.length === 0) break;
  messages.push({ role: "assistant", content: reply.content });
  const results = [];
  for (const tu of toolUses) {
    const result = await pay(tu.input);
    console.log(`  [purse] ${result}`);
    results.push({ type: "tool_result", tool_use_id: tu.id, content: result });
  }
  messages.push({ role: "user", content: results });
  reply = await callClaude(messages);
}

process.send?.({ kind: "report", data: { llm: true } });
