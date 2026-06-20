# Continuous capability-surface verification

**Status:** design, not yet implemented
**Related:** [Threat model](../../README.md#threat-model), deployment contract item 5 (continuous verification)

## Why this exists

The threat model states that the single-path property, the agent has no way to move money except through Purse, is a property you maintain, not a state you reach. Any new tool, MCP server, or dependency the runtime gains can silently reopen a money path without touching the policy.

This document scopes how that verification should actually work. The naive version, watch for new tools and alert, is the easy part and also the least useful part.

## The problem

Detecting that the capability surface changed is mechanically cheap. The hard problem is knowing *which assumptions are now unsound* when it does.

A new tool can be harmless alone and still complete a money path in combination with something already present: a generic HTTP client plus a stored payment credential is an unmediated money path.

## The wrong approach: enumerate composition

The tempting response is to model emergent capabilities, to reason about every way primitives combine into a money path. This is combinatorial and a losing game. You will not enumerate every composition, and the one you miss is the breach.

## The right approach: reachability by construction

Do not enumerate combinations. Make the dangerous primitive unreachable.

The credential lives only in the broker's process, never the agent's. The agent can request a payment; it cannot call the rail. Enforcement is the process boundary, not a policy check inside the agent's reach. Under that design, HTTP plus stored-credential cannot compose, because the credential was never in the agent's scope to begin with. Reachability becomes the question, and the answer is no by construction, not by policy.

This collapses the problem. Composition stops being something you defend against and becomes something that cannot occur.

## What is left to verify

The surface does not vanish. It shrinks to one place: the broker's request interface. That is the only thing the agent can reach, so it is the only thing to harden. Keep it minimal (request a payment, nothing that lets the agent shape what the broker does with the request) and validate every field on the broker side. Finite and auditable, instead of combinatorial.

Continuous verification then reduces to two invariants:

1. The agent's process holds no reference to a credential or a rail-calling capability. No new tool or dependency changes this as long as the isolation boundary holds.
2. The broker's request interface stays narrow and fully validated.

## The harder half: forgery vs misdirection

Capability isolation closes one attack and surfaces another. Locking the credential in the broker's process stops the agent from *forging* a payment: it cannot mint money it was never handed the means to move. But the agent still authors the request, the who and the how-much, and a compromised agent can hand the broker a request that is perfectly in-policy and still not what the principal meant. Pay a different allowlisted vendor. Pay the maximum the cap allows. Split to stay under a limit. The key is locked; the authorization leaks through the field the agent controls. This is the confused deputy at the semantic layer.

The rule: wherever enforcement trusts an agent-supplied field for who or how much, the boundary is nominal. The process boundary stops forgery. It does nothing about misdirection.

So a broker that only checks "is this payee allowlisted, is this amount under the cap" is enforcing syntax, not intent. Any in-policy value the agent supplies passes, including the attacker's choice of in-policy value.

## Intent-binding: the answer to misdirection

The broker cannot treat "any in-policy value the agent supplies" as authorized. The who and the how-much have to bind to a specific intent the principal already approved, out of band from the agent, rather than to a standing policy the agent can satisfy with free input.

Concretely: scoped, single-use authorizations. The principal (the human, or the system acting for the human) approves a specific payment, a specific payee and amount, or a tightly bounded set, and the broker matches the agent's request against that pre-approval. The agent can only execute what was already approved, not anything that happens to be in policy. A standing policy says "you may pay any allowlisted vendor up to the cap." An intent binding says "you may pay this vendor, this amount, once."

Two controls, two jobs:

- **Capability isolation** (the process boundary) stops the agent forging the means to pay.
- **Intent-binding** (scoped, single-use authorization) stops the agent misdirecting a payment it is allowed to request.

Broad policy caps are still useful as a backstop, the blast radius if intent-binding is ever loose, but they are not the authorization. The authorization is the binding to a specific approved intent.

## Where the dependency graph still applies

Policy-level rules (caps, allowlists, categories) can still go stale when their inputs change, and a capability-to-rule map helps decide which rules to re-evaluate. That is a smaller, separate concern from the composition problem above, which the architecture removes rather than manages.

## Open questions

- How to enforce the process boundary in practice across runtimes: a separate process, a separate container, or a signing service the agent calls?
- What is the minimal request interface, and how is every field validated broker-side?
- How to attest, continuously, that the agent's process holds no credential reference?
- Where does the principal's intent come from, and how is it captured without a human in every loop?
- How tightly must an authorization be scoped before it becomes unusable: exact payee and amount, or a bounded set?

## Provenance

This design was worked out in the open with [@runs.dash](https://www.threads.net/@runs.dash) on Threads. The key move, that composition is dissolved by putting the credential below the agent's reach and making enforcement the process boundary rather than a policy check, is his. So is the follow-on: that capability isolation stops forgery but not misdirection, and that authorization must bind to a specific approved intent rather than to any in-policy value the agent supplies.
