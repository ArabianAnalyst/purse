# Purse

**Your AI agent can spend money. Right now, nothing stops it from spending the wrong amount, to the wrong place, on a loop, with no record.**

Purse is the enforcement point your agent's payments pass through. Route every spend through it. Set limits, require human approval over a threshold, and get a tamper-evident log of every decision. Any agent, any payment rail, three lines of code, zero dependencies.

```bash
npm i @olurabian/purse
```

The quickest way in is advisory mode. Purse decides, your code executes.

```ts
import { Purse } from "@olurabian/purse";

const purse = new Purse({
  maxPerAction: "$5.00",
  maxPerDay: "$200.00",
  allow: ["api.stripe.com", "*.aws.amazon.com"],
  requireApprovalOver: "$50.00",
});

// the agent must pass every spend through here first
const decision = purse.authorize({
  amount: "$12.00",
  payee: "api.stripe.com",
  intent: "top up API credits",
});

if (decision.status === "allowed") {
  await executePayment();
} else if (decision.status === "needs_approval") {
  await queueForHuman(decision); // above your auto-approve threshold
} else {
  agent.observe(decision.reason); // "denied: ... not on the allowlist"
}
```

## Why

An AI agent is a loop that picks tools and runs them. Give it a payment tool and a wallet, and one prompt injection or one runaway loop is a drained budget with nobody having clicked "approve." The agent layer is trivial. The layer that decides what it is *allowed* to spend, and proves what it *did* spend, is the part that actually matters. Purse is that layer.

Two principles it holds to.

- **Fail closed.** If the policy check cannot run, the spend is denied, never allowed.
- **Enforcement, not advice.** Route the spend *through* Purse so there is no path around it. A guardrail you can ignore is a suggestion.

## Enforcement mode (v0.2)

Advisory mode still leaves the agent holding the credential and executing the payment itself, so a compromised agent can ignore the verdict. Enforcement mode removes that. The credential moves into a **broker** process the agent cannot reach, and every settled spend binds to a single-use **grant** that policy or a human approved.

The broker runs where you hold the key. The agent runs as a spawned child that imports only a client and never sees the key.

```ts
// broker-host.ts — the process that holds the credential
import { Broker, serveBroker, spawnAgent, MockExecutor } from "@olurabian/purse";

const broker = new Broker({
  maxPerAction: "$5",
  maxPerDay: "$200",
  allow: ["api.stripe.com"],
  requireApprovalOver: "$50",
  executor: new MockExecutor(), // swap for a real rail adapter; it holds the credential, agent-side never sees it
});

const agent = spawnAgent("./agent.js"); // the agent is a subordinate child process
serveBroker(agent, broker);             // exposes only request / execute / status over the wire
```

```ts
// agent.js — holds only the client. No key, no executor, no rail.
import { PurseClient } from "@olurabian/purse";
const purse = PurseClient.fromProcess();

const d = await purse.request({ amount: "$3", payee: "api.stripe.com", intent: "credits" });
if (d.decision === "allowed" && d.grantId) {
  const r = await purse.execute(d.grantId); // the broker settles; the agent never touches the key
}
```

What holds it together.

- **Custody, not convention.** The key lives in a different OS process. The agent cannot `import` it, so "denied" is not a rule it chooses to follow. It is the absence of any other path.
- **Single-use grants.** A non-denied decision mints one grant bound to an exact payee and amount, single-use, with an expiry. Execution is a separate broker-only step gated on that grant.
- **Reservation-aware caps.** Open grants reserve budget the moment they are minted, so a burst of small spends cannot slip under a limit before any of them settle.
- **Human approval, out of band.** Spends over the threshold wait for a principal to approve that exact request. The agent asks. It cannot self-approve.
- **Explainable, tamper-evident audit.** Every decision writes a hash-chained record carrying a structured reason. The *why* is inside the hash too, so you cannot rewrite it after the fact.

## The x402 governed-agent proof

v0.2 ships a real proof, not a claim. Clone the repo and run it.

```bash
npm run demo:x402
```

A two-process demo settles over the x402 payment rail while a scripted agent tries to misbehave. It walks five scenes, each asserted headlessly in CI.

1. A normal in-policy spend settles over x402.
2. A prompt-injected off-allowlist payment is denied. The injection moves nothing.
3. An over-threshold spend is held and settles only after human approval.
4. A split-under-cap attack, many small payments to slip under the daily limit, is blocked by reservations.
5. The audit chain verifies. Each record's hash includes the previous one.

The demo settles over a local x402 mock, so you can run the whole thing with no wallet and no funds. It speaks the real x402 flow (HTTP 402, payment requirements, X-PAYMENT header). The live Base Sepolia path (USDC, EIP-3009 signing) is documented under `examples/x402/`.

## Threat model

Purse is the policy and audit core of a payment control plane. It is a hard boundary only when it is the single path money can move. Deployed any other way, it is defense in depth, not a wall. This section is precise about which is which.

**The threat.** An agent that can spend money, where the agent itself may be compromised by prompt injection, a poisoned tool result, or a jailbroken instruction. The goal is not to keep the agent honest. It is to make sure a dishonest agent still cannot move money outside policy.

**Two principles.**

- A control only counts at the point of enforcement. A check an agent can route around is a suggestion, not a control.
- The boundary is a property you maintain, not a state you reach. The agent's capability surface widens the moment its runtime gains a tool or dependency, often silently. Verifying it once at deploy is not enough.

**The deployment contract.** For "a compromised agent cannot move money outside policy" to hold, all of these must be true.

1. **Single path.** The agent can move money only by submitting an intent to the broker. No rail credentials in its runtime, no second payment tool, no direct primitive.
2. **Mediated execution.** The spend is performed behind the broker boundary after a decision, not by the agent. The agent receives a result, never a raw credential.
3. **Custody outside the agent.** Keys live with the executor the broker gates, never in the agent's context, prompt, memory, or tools.
4. **No splitting path.** If the agent can split a payment across tools or rails to stay under a cap, the cap is not enforced. Every money path funnels through the broker.
5. **Continuous verification.** The capability surface is not static. Any new tool, MCP server, or dependency the runtime gains can reopen a money path without touching your policy. Re-verify the single-path property on every change to the agent's tools and dependencies, not once at deploy.

If any of these is false, treat Purse as policy plus logging, not as a hard boundary.

**One honest limit.** Locking the key out of the agent stops *forgery*, the agent minting a payment it was never handed the means to make. It does not by itself stop *misdirection*, a compromised agent handing the broker a perfectly in-policy request that is not what you meant. Principal-approved grants bind to an intent a human actually saw, so misdirection is closed there. Auto-granted small spends are bounded by the caps and allowlist, not eliminated. This is the confused deputy at the payments layer, and it is where the roadmap goes next.

**Status.** v0.2 ships enforcement mode. The broker holds the credential and performs the spend, the agent receives a scoped single-use grant, and every decision is a tamper-evident record with a structured reason. What remains on the roadmap is continuous capability-surface monitoring and the hosted layer, Purse Cloud. Until those land, the security property depends on the deployment contract above being met by the system around the broker.

This threat model was sharpened in the open by [@runs.dash](https://www.threads.net/@runs.dash).

## Audit your own setup

Not sure where your agent stands? The [Agent Payment Security Audit](prompts/agent-payment-security-audit.md) is a self-serve prompt. It scores your setup against the deployment contract above and tells you, in money terms, where a compromised agent could still move funds. Anything you leave out comes back as Unknown, not a guess.

## The paper behind it

The threat model and the confused-deputy argument are written up in full in the whitepaper, [Agent-Payment Enforcement and the Confused Deputy](docs/whitepaper/agent-payment-enforcement.md). It separates what enforcement closes (forgery) from the open problem it does not (misdirection, the in-policy but wrong request), and places the work in the comprehensive-AI-services frame.

## Harness card

An honest disclosure of what the enforcement deployment controls, in Control / Agency / Runtime terms.

| Layer | What it covers |
| --- | --- |
| **Control** (before the step) | policy config (allow, deny, per-action cap, velocity caps, `requireApprovalOver`, categories), policy-version hash, the deployment contract |
| **Agency** (the agent's action surface) | the agent may only call `request`, `execute`, `status`. It cannot call a payment rail, mint grants, approve, or read or set policy. Every field is validated broker-side |
| **Runtime** (over time) | single-use grants with expiry, reservation-aware velocity, no silent retry on failure, fail-closed on every error path, tamper-evident audit with a structured reason |
| **Not guaranteed** | misdirection on auto-granted small spends is bounded by caps, not eliminated. Continuous capability-surface monitoring is not included. The property holds only while the process boundary and single-path deployment hold |

## What you can express

```ts
new Purse({
  currency: "USD",                       // default currency for bare amounts
  maxPerAction: "$5.00",                 // ceiling on a single spend
  maxPerDay: "$200.00",                  // rolling 24h velocity cap
  maxPerWindow: { amount: "$50", windowMs: 3_600_000 }, // any custom window
  allow: ["api.stripe.com", "*.aws.amazon.com"],        // payee allowlist (globs)
  deny: ["*.ru", "scam-vendor.io"],                     // payee blocklist
  requireApprovalOver: "$50.00",         // above this -> needs_approval
  categories: ["infra", "data"],         // restrict by spend category
  auditFile: "./purse-audit.jsonl",      // persist the tamper-evident log
});
```

The same policy config drives both `Purse` (advisory) and `Broker` (enforcement). Money is always handled as integer minor units, never floats, with correct decimals per currency (JPY has none, KWD has three). Purse never converts currencies, so keep one currency per policy.

## The tamper-evident audit log

Every decision writes an immutable record whose hash includes the previous record's hash. Alter, insert, or remove any record and the chain breaks. You can *prove* the log was not edited after the fact.

```ts
purse.verify();
// { ok: true }  — or { ok: false, brokenAt, reason } if tampered
```

This is the difference between "we think the agent behaved" and "here is the cryptographically verifiable record of every spend it was authorized to make."

## Use it as an MCP server

Expose Purse to any MCP-capable agent so it authorizes spends before executing them.

```bash
npm i @modelcontextprotocol/sdk zod
PURSE_MAX_PER_ACTION="$5" PURSE_MAX_PER_DAY="$200" PURSE_ALLOW="api.stripe.com" npm run mcp
```

Then tell your agent, in one line, *call `authorize_spend` before any payment tool. If the result is not `allowed`, do not pay.*

## Demos

Clone the repo and run either.

```bash
npm run demo        # advisory: per-action overspend, injected payee, runaway loop, chain verify
npm run demo:x402   # enforcement: the two-process x402 governed-agent proof, five scenes
```

## Free vs hosted

This library is the enforcement primitive, and it is genuinely useful on its own. A solo dev can bound an agent today. What it does not give you is the layer an organisation needs.

| | Purse (this library) | Purse Cloud |
| --- | :---: | :---: |
| Policy enforcement (allow / deny / approve) | yes | yes |
| Credential custody + mediated execution | yes | yes |
| Single-use grants + reservation caps | yes | yes |
| Local tamper-evident audit log | yes | yes |
| MCP server + SDK | yes | yes |
| Works with any agent / model / rail | yes | yes |
| Manage policy across teams without redeploying | no | yes |
| Central, compliance-grade audit store | no | yes |
| Human approval workflow (queue, Slack/email, UI) | no | yes |
| Multi-agent / org-wide policy, RBAC, SSO | no | yes |
| Reconciliation against the real financial system | no | yes |
| Anomaly detection + org-wide kill switch | no | yes |
| Continuous capability-surface monitoring | no | yes |

If you are taking an agent that spends money from a working demo to production and your risk or finance team needs approvals, a central audit, and reconciliation, that is what Purse Cloud is for.

## License

MIT. Built by [Oluwasegun Araba](https://olurabian.com).
