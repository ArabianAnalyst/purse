import { Broker } from "../src/broker";
import { MockExecutor } from "../src/executor";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

// Scene 1: allowed → auto-grant → execute → paid
{
  const b = new Broker({ maxPerAction: "$5", allow: ["api.stripe.com"], requireApprovalOver: "$50", executor: new MockExecutor() });
  const r = b.request({ amount: "$3", payee: "api.stripe.com", intent: "credits" });
  check("under-threshold request is allowed with a grant", r.decision === "allowed" && !!r.grantId);
  const x = await b.execute(r.grantId!);
  check("execute settles via executor", x.status === "paid" && x.receipt?.ok === true);
  check("settled receipt carries the paid amount", x.receipt?.paidAmount?.amount === 300);
  const x2 = await b.execute(r.grantId!);
  check("second execute on same grant is rejected (single-use)", x2.status === "rejected");
}

// Scene 2: prompt-injected payee is denied, no grant
{
  const b = new Broker({ allow: ["api.stripe.com"], executor: new MockExecutor() });
  const r = b.request({ amount: "$1", payee: "attacker.evil", intent: "urgent invoice" });
  check("off-allowlist payee is denied", r.decision === "denied" && !r.grantId);
  const x = await b.execute("any-made-up-id");
  check("execute with no valid grant is rejected", x.status === "rejected");
}

// Scene 3: over-threshold waits for principal approval, then executes
{
  const b = new Broker({ requireApprovalOver: "$50", executor: new MockExecutor() });
  const r = b.request({ amount: "$120", payee: "api.stripe.com", intent: "annual" });
  check("over-threshold needs approval with a pendingId", r.decision === "needs_approval" && !!r.pendingId);
  check("cannot execute a pending before approval", (await b.execute(r.pendingId!)).status === "rejected");
  const ap = b.approve(r.pendingId!);
  check("approve mints a grant", !!ap.grantId);
  check("status reflects approval", b.status(r.pendingId!).state === "approved");
  check("approved grant executes", (await b.execute(ap.grantId!)).status === "paid");
}

// Scene 4: split-under-cap attack blocked by reservations
{
  const b = new Broker({ maxPerDay: "$3", requireApprovalOver: "$50", executor: new MockExecutor() });
  b.request({ amount: "$2", payee: "api.stripe.com" }); // reserves $2
  const second = b.request({ amount: "$2", payee: "api.stripe.com" });
  check("second under-cap request denied by reservation", second.decision === "denied");
}

// Scene 5: executor failure releases the grant and is recorded; chain verifies
{
  const b = new Broker({ requireApprovalOver: "$50", executor: new MockExecutor({ fail: true }) });
  const r = b.request({ amount: "$1", payee: "api.stripe.com" });
  const x = await b.execute(r.grantId!);
  check("executor failure yields rejected", x.status === "rejected");
  check("audit chain verifies across the lifecycle", b.verify().ok === true);
  check("explain is present on decisions", b.audit()[0]!.explain?.rule === "within-policy");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
