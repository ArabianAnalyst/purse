# Purse

**Your AI agent can spend money. Right now, nothing stops it from spending the wrong amount, to the wrong place, on a loop, with no record.**

Purse is the policy layer that sits in front of your agent's payments. Set limits, require human approval over a threshold, and get a tamper-evident log of every decision. Any agent, any payment rail, three lines of code, zero dependencies.

```bash
npm i purse
```

```ts
import { Purse } from "purse";

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

If you are taking an agent that spends money from a working demo to production and your risk or finance team needs approvals, a central audit, and reconciliation, that is what Purse Cloud is for.

## License

MIT. Built by [Oluwasegun Araba](https://arabastack.com).
