# Purse

**Your AI agent can spend money. Right now, nothing stops it from spending the wrong amount, to the wrong place, on a loop, with no record.**

Purse is the enforcement point your agent's payments pass through. Route every spend through it: set limits, require human approval over a threshold, and get a tamper-evident log of every decision. Any agent, any payment rail, three lines of code, zero dependencies.

```bash
npm i @olurabian/purse
```

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

Two principles it holds to:

- **Fail closed.** If the policy check cannot run, the spend is denied, never allowed.
- **Enforcement, not advice.** Route the spend *through* `authorize()` so there is no path around it. A guardrail you can ignore is a suggestion.

## Threat model

Purse is the policy and audit core of a payment control plane. It is a hard boundary only when it is the single path money can move. Deployed any other way, it is defense in depth, not a wall. This section is precise about which is which.

**The threat.** An agent that can spend money, where the agent itself may be compromised: prompt injection, a poisoned tool result, a jailbroken instruction. The goal is not to keep the agent honest. It is to make sure a dishonest agent still cannot move money outside policy.

**Two principles.**

- A control only counts at the point of enforcement. A check an agent can route around is a suggestion, not a control.
- The boundary is a property you maintain, not a state you reach. The agent's capability surface widens the moment its runtime gains a tool or dependency, often silently. Verifying it once at deploy is not enough.

**What Purse decides, and what it does not execute.** Given a spend request, Purse returns `allowed`, `denied`, or `needs_approval`, and writes a tamper-evident record. It does not hold your payment credentials and does not move the money itself. If the agent's runtime holds a rail key, a second payment tool, or any direct path to a payment primitive, it can bypass Purse entirely. In that case Purse is advisory: it tells a cooperating caller what policy says, and a compromised agent that ignores the answer is not stopped. You have moved the injection surface, not closed it.

**The deployment contract.** For "a compromised agent cannot move money outside policy" to hold, all of these must be true:

1. **Single path.** The agent can move money only by submitting an intent to Purse. No rail credentials in its runtime, no second payment tool, no direct primitive.
2. **Mediated execution.** The spend is performed behind the Purse boundary after a decision, not by the agent. The agent receives a result, never a raw credential.
3. **Custody outside the agent.** Keys live with the executor Purse gates, never in the agent's context, prompt, memory, or tools.
4. **No splitting path.** If the agent can split a payment across tools or rails to stay under a cap, the cap is not enforced. Every money path funnels through Purse.
5. **Continuous verification.** The capability surface is not static. Any new tool, MCP server, or dependency the runtime gains can reopen a money path without touching your policy. Re-verify the single-path property on every change to the agent's tools and dependencies, not once at deploy. Treat a new unmediated money path as a policy violation, not a feature.

If any of these is false, treat Purse as policy plus logging, not as a hard boundary.

**Advisory mode vs enforcement mode.**

- *Advisory* (Purse decides, your code executes): one testable policy, a consistent decision, and a tamper-evident record of what was requested and what policy said. Useful for cooperative agents, internal tooling, and audit. Not a defense against a compromised agent on its own.
- *Enforcement* (Purse, or a Purse-gated executor, holds the credential and performs the spend; the agent receives only a scoped, single-use authorization): the agent never holds the capability to move money, so `denied` is not a rule it chooses to follow. It is the absence of any other path.

**Status.** This release is the policy and audit core, designed to be the decision point of an enforcement deployment. Credential-custody execution, scoped authorization issuance, and continuous capability-surface monitoring are on the roadmap. Until then, the security property depends on the deployment contract above being met by the system around Purse.

This threat model was sharpened in the open by [@runs.dash](https://www.threads.net/@runs.dash).

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

Money is always handled as integer minor units, never floats, with correct decimals per currency (JPY has none, KWD has three). Purse never converts currencies; keep one currency per policy.

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

Then tell your agent, in one line: *call `authorize_spend` before any payment tool; if the result is not `allowed`, do not pay.*

## Try the demo

```bash
npm run demo
```

It shows Purse stopping a per-action overspend, blocking a prompt-injected payee, cutting off a runaway loop at the daily cap, and verifying the audit chain.

## Free vs hosted

This library is the enforcement primitive, and it is genuinely useful on its own: a solo dev can bound an agent today. What it does not give you is the layer an organisation needs.

| | Purse (this library) | Purse Cloud |
| --- | :---: | :---: |
| Policy enforcement (allow / deny / approve) | yes | yes |
| Local tamper-evident audit log | yes | — |
| MCP server + SDK | yes | yes |
| Works with any agent / model / rail | yes | yes |
| Manage policy across teams without redeploying | — | yes |
| Central, compliance-grade audit store | — | yes |
| Human approval workflow (queue, Slack/email, UI) | — | yes |
| Multi-agent / org-wide policy, RBAC, SSO | — | yes |
| Reconciliation against the real financial system | — | yes |
| Anomaly detection + org-wide kill switch | — | yes |
| Continuous capability-surface monitoring | — | yes |

If you are taking an agent that spends money from a working demo to production and your risk or finance team needs approvals, a central audit, and reconciliation, that is what Purse Cloud is for.

## License

MIT. Built by [Oluwasegun Araba](https://arabastack.com).
