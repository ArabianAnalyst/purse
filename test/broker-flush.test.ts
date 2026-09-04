import { Broker } from "../src/broker";
import { MockExecutor } from "../src/executor";
import { JsonlAuditStore } from "../src/audit";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

class FlushingStore extends JsonlAuditStore {
  constructor(private readonly log: string[], private readonly fail = false) { super(); }
  async flush(): Promise<void> {
    this.log.push("flush");
    if (this.fail) throw new Error("db down");
  }
}

class LoggingExecutor extends MockExecutor {
  constructor(private readonly log: string[]) { super(); }
  override async execute(p: Parameters<MockExecutor["execute"]>[0]) {
    this.log.push("execute");
    return super.execute(p);
  }
}

// Scene 1: execute flushes before the executor runs and before it returns
{
  const log: string[] = [];
  const b = new Broker({ maxPerAction: "$5", allow: ["api.stripe.com"], executor: new LoggingExecutor(log), store: new FlushingStore(log) });
  const r = b.request({ amount: "$3", payee: "api.stripe.com", intent: "credits" });
  const x = await b.execute(r.grantId!);
  check("spend is paid", x.status === "paid");
  check("flush runs before the executor and again before returning", JSON.stringify(log) === JSON.stringify(["flush", "execute", "flush"]));
}

// Scene 2: a rejecting flush stops the executor from running and rejects execute
{
  const log: string[] = [];
  const b = new Broker({ maxPerAction: "$5", maxPerDay: "$5", allow: ["api.stripe.com"], executor: new LoggingExecutor(log), store: new FlushingStore(log, true) });
  const r = b.request({ amount: "$3", payee: "api.stripe.com", intent: "credits" });
  let threw = "";
  try { await b.execute(r.grantId!); } catch (e) { threw = (e as Error).message; }
  check("execute rejects when the receipt cannot be made durable", /db down/.test(threw));
  check("the executor never ran", !log.includes("execute"));

  const again = b.request({ amount: "$3", payee: "api.stripe.com", intent: "credits" });
  check("the failed grant no longer counts against the day budget", again.decision === "allowed");
}

// Scene 3: stores without flush are fine, and Broker.flush()/Purse.flush() are no-ops on them
{
  const b = new Broker({ maxPerAction: "$5", allow: ["api.stripe.com"], executor: new MockExecutor() });
  const r = b.request({ amount: "$3", payee: "api.stripe.com", intent: "credits" });
  const x = await b.execute(r.grantId!);
  check("plain store still pays", x.status === "paid");
  await b.flush();
  check("Broker.flush() resolves on a store without flush", true);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
