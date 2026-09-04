// Generates docs/integration/samples/purse-sample-receipts.json by running the
// real Purse policy engine. Run:  npm run samples   (after npm run build)
import { pathToFileURL, fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(resolve(here, "../dist/index.js")).href);
const { Purse, verifyChain } = mod;

const purse = new Purse({
  currency: "USD",
  maxPerAction: "$100.00",
  maxPerDay: "$500.00",
  allow: ["api.stripe.com", "*.aws.amazon.com", "acme-supplies.example"],
  deny: ["*.unknown-vendor.example"],
  requireApprovalOver: "$50.00",
});

purse.authorize({ amount: "$12.00",  payee: "api.stripe.com",                 intent: "top up API credits", agentId: "agent-7" }); // allowed
purse.authorize({ amount: "$4.20",   payee: "s3.aws.amazon.com",              intent: "object storage",     agentId: "agent-7" }); // allowed
purse.authorize({ amount: "$80.00",  payee: "acme-supplies.example",          intent: "reorder toner",      agentId: "agent-7" }); // needs_approval
purse.authorize({ amount: "$9.99",   payee: "sketchy.unknown-vendor.example", intent: "unknown",            agentId: "agent-7" }); // denied (deny-list)
purse.authorize({ amount: "$250.00", payee: "api.stripe.com",                 intent: "large charge",       agentId: "agent-7" }); // denied (per-action cap)

const records = purse.audit();
const verdict = verifyChain(records);
if (!verdict.ok) throw new Error("generated chain does not verify: " + JSON.stringify(verdict));

const out = resolve(here, "../docs/integration/samples/purse-sample-receipts.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(records, null, 2) + "\n");
console.log(`wrote ${records.length} receipts (${records.map((r) => r.payload.status).join(", ")}), verify: ${JSON.stringify(verdict)}`);
