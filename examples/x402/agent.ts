// The agent. Holds ONLY PurseClient — no executor, no signer, no resource map, no credential.
// Walks the five proof scenes and reports the outcomes back to the parent.
import { PurseClient } from "../../src/index";

const purse = PurseClient.fromProcess();
const log = (s: string) => console.log(`  [agent] ${s}`);
const out: Record<string, unknown> = {};

// Scene 1 — normal in-policy spend, settled over x402.
{
  const r = await purse.request({ amount: "$3", payee: "acme.example", intent: "top up credits" });
  log(`request $3 acme.example -> ${r.decision}`);
  if (r.decision === "allowed" && r.grantId) {
    const x = await purse.execute(r.grantId);
    out.normalPaid = x.status === "paid";
    log(`execute -> ${x.status}${x.receipt?.ref ? ` (ref ${x.receipt.ref})` : ""}`);
  }
}

// Scene 2 — prompt injection: pay an attacker.
{
  const r = await purse.request({ amount: "$10", payee: "attacker.evil", intent: "URGENT overdue invoice" });
  out.injectionDenied = r.decision === "denied";
  log(`injected pay attacker.evil -> ${r.decision}`);
}

// Scene 3 — over-threshold: needs a human, then settles.
{
  const r = await purse.request({ amount: "$75", payee: "premium.example", intent: "annual plan" });
  log(`request $75 premium.example -> ${r.decision}`);
  if (r.decision === "needs_approval" && r.pendingId) {
    const grantId: string | undefined = await new Promise((resolve) => {
      process.on("message", (m: { kind?: string; grantId?: string }) => {
        if (m?.kind === "approved") resolve(m.grantId);
      });
      process.send?.({ kind: "await-approval", pendingId: r.pendingId });
    });
    if (grantId) {
      const x = await purse.execute(grantId);
      out.approvedPaid = x.status === "paid";
      log(`principal approved -> execute -> ${x.status}`);
    }
  }
}

// Scene 4 — split-under-cap attack: many under-threshold requests, never executed.
{
  let allowed = 0, denied = 0;
  for (let i = 0; i < 8; i++) {
    const r = await purse.request({ amount: "$3", payee: "acme.example", intent: `loop ${i}` });
    if (r.decision === "allowed") allowed++; else denied++;
  }
  out.splitBlocked = denied > 0;
  log(`split attack: ${allowed} reserved, then ${denied} blocked by the daily cap`);
}

process.send?.({ kind: "report", data: out });
