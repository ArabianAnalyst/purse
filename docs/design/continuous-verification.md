# Continuous capability-surface verification

**Status:** design, not yet implemented
**Related:** [Threat model](../../README.md#threat-model), deployment contract item 5 (continuous verification)

## Why this exists

The threat model states that the single-path property, the agent has no way to move money except through Purse, is a property you maintain, not a state you reach. Any new tool, MCP server, or dependency the runtime gains can silently reopen a money path without touching the policy.

This document scopes how that verification should actually work. The naive version, watch for new tools and alert, is the easy part and also the least useful part.

## The problem

Detecting that the capability surface changed is mechanically cheap. The hard problem is knowing *which policy rules are now unsound* when it does.

Every policy rule carries an implicit precondition about the capability surface. A `maxPerAction` cap of $5 is only enforceable while every money path funnels through Purse. That rule's soundness depends on the invariant "no unmediated money path exists." When the surface shifts, some of those invariants break and some do not, and re-checking everything on every change is as useless as re-checking nothing.

## Model: a capability-to-policy dependency graph

Make the preconditions explicit. Model a graph that links each policy rule to the capability-surface invariants it relies on. On any change to the runtime's capabilities, traverse the graph to find rules whose invariants are now at risk, and surface only those for re-evaluation. Targeted, not all-or-nothing.

## The hard part: composition

Capabilities are not atomic "money / not-money." A new tool can be individually harmless and still complete a money path in combination with something already present. A generic HTTP-request tool is benign until the runtime also holds a stored payment credential; together they are an unmediated money path.

So the graph cannot just label tools. It has to reason about emergent capabilities that arise from combinations, the closure of what the agent can do given the full set of primitives. This is where most of the design effort goes, and it is the part worth getting right before writing code.

## Sketch (to refine)

- **Capability model.** Represent each tool or dependency as a set of primitive effects (network egress, holds-credential-X, can-sign-Y), not as a name.
- **Rule annotations.** Each policy rule declares the capability-surface invariants it depends on.
- **Change handler.** On a surface change, recompute the reachable and composed effects, diff against the invariants each rule depends on, and surface the rules now at risk.
- **Fail closed.** If a change cannot be classified, treat affected rules as violated until re-verified.

## Open questions

- How to represent composition without combinatorial blowup? (effect lattice? reachability over a primitive-effect graph?)
- Where does this live: inside Purse, a companion monitor, or Purse Cloud?
- What is the minimum viable version? Even a manual capability manifest plus invariant annotations beats nothing.
- How to get a reliable capability inventory across runtimes (MCP servers, tool registries, dependency trees)?

## Provenance

This direction came out of an open thread with [@runs.dash](https://www.threads.net/@runs.dash) on Threads, who pointed out that continuous verification is the real shape of the deployment contract, and that the dependency graph between capabilities and policy rules is the part worth scoping early.
