// Runs in a SEPARATE process. Holds only PurseClient — no Broker, no Executor, no credential.
import { PurseClient } from "../../src/client";

const purse = PurseClient.fromProcess();

const out: Record<string, unknown> = {};

// in-policy spend → grant → execute
const r = await purse.request({ amount: "$3", payee: "api.stripe.com", intent: "credits" });
out.allowedGrant = r.decision === "allowed" && !!r.grantId;
if (r.grantId) {
  const x = await purse.execute(r.grantId);
  out.paid = x.status === "paid";
}

// prompt injection → off-allowlist payee must be denied
const bad = await purse.request({ amount: "$1", payee: "attacker.evil", intent: "urgent" });
out.injectionDenied = bad.decision === "denied";

process.send?.({ kind: "report", data: out });
