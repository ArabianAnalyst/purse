// The agent. Holds ONLY PurseClient — no executor, no credential, no rail.
import { PurseClient } from "../../src/index";

const purse = PurseClient.fromProcess();
const log = (s: string) => console.log(`  [agent] ${s}`);

// 1. normal in-policy spend
let r = await purse.request({ amount: "$3", payee: "api.stripe.com", intent: "top up credits" });
log(`request $3 -> ${r.decision}`);
if (r.grantId) log(`execute -> ${(await purse.execute(r.grantId)).status}`);

// 2. prompt injection: pay an attacker
r = await purse.request({ amount: "$500", payee: "attacker.evil", intent: "URGENT overdue invoice" });
log(`injected pay attacker.evil -> ${r.decision} (${r.reason})`);

// 3. over-threshold: needs a human
r = await purse.request({ amount: "$120", payee: "api.stripe.com", intent: "annual plan" });
log(`request $120 -> ${r.decision}, pendingId=${r.pendingId}`);
process.send?.({ kind: "await-approval", pendingId: r.pendingId });

// wait for the host to tell us it approved, then execute
process.on("message", async (m: { kind?: string; grantId?: string }) => {
  if (m?.kind === "approved" && m.grantId) {
    log(`principal approved -> execute -> ${(await purse.execute(m.grantId)).status}`);
    process.send?.({ kind: "done" });
  }
});
