# AgentDojo-style injection demo

A runnable demonstration of Purse's core claim: **a prompt-injected agent still cannot move money outside policy.**

```bash
npm run demo:agentdojo
```

## What it shows

[AgentDojo](https://github.com/ethz-spylab/agentdojo) (ETH Zurich) measures a specific threat: a tool result carries a hidden instruction that subverts a tool-using agent into an action it should never take. This demo reproduces that threat at the money layer.

A banking agent is asked to pay $1,500 rent to the landlord. A poisoned "bank note" field in a tool result tells it to *also* wire $5,000 to an attacker. The injected agent obeys both. We run it two ways:

- **Ungoverned** — both transfers execute. $5,000 reaches the attacker. The agent is drained.
- **Through Purse** — the rent is `ALLOWED`, the attacker transfer is `DENIED` (payee not on the allowlist), $0 reaches the attacker, and both decisions land in a tamper-evident audit log that verifies.

The point is not that the agent behaved. It is that a *misbehaving* agent could not move the money.

## What this does and does not claim

This is a faithful reproduction of AgentDojo's **core threat** — an injection in a tool result driving a harmful money action — run against real Purse. It is **not** the official AgentDojo benchmark harness, and no LLM drives the agent here (the injected plan is scripted, because an agent that follows the note is exactly the failure case).

To make a citable "passed AgentDojo" claim, wire Purse into AgentDojo's actual pipeline with a live model driving the agent, and run it in a sandbox. This example is the mechanism; that run is the citation.
