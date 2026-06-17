// Minimal zero-dependency test runner. Run with:  npm test
import { Purse, parseMoney, verifyChain } from "../src/index";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`);
  }
}

// money is integer minor units, never floats
check("parses $5.00 to 500 cents", parseMoney("$5.00").amount === 500);
check("parses 0.1 + 0.2 without float error", parseMoney("0.30").amount === 30);
check("JPY has zero decimals", parseMoney("¥1000").amount === 1000);
check("KWD has three decimals", parseMoney("10 KWD").amount === 10000);

// per-action cap
{
  const p = new Purse({ maxPerAction: "$5.00", allow: ["x.com"] });
  check("allows under the cap", p.authorize({ amount: "$4.00", payee: "x.com" }).status === "allowed");
  check("denies over the cap", p.authorize({ amount: "$6.00", payee: "x.com" }).status === "denied");
}

// allowlist / denylist
{
  const p = new Purse({ allow: ["*.aws.amazon.com"] });
  check("allowlist glob matches", p.authorize({ amount: "$1", payee: "ec2.aws.amazon.com" }).status === "allowed");
  check("allowlist blocks others", p.authorize({ amount: "$1", payee: "evil.io" }).status === "denied");
}

// approval threshold
{
  const p = new Purse({ requireApprovalOver: "$2.00" });
  check("under threshold is allowed", p.authorize({ amount: "$2.00", payee: "x" }).status === "allowed");
  check("over threshold needs approval", p.authorize({ amount: "$2.01", payee: "x" }).status === "needs_approval");
}

// daily velocity cap
{
  const p = new Purse({ maxPerDay: "$3.00" });
  p.authorize({ amount: "$2.00", payee: "x" }); // allowed, $2 used
  check("second spend within daily cap allowed", p.authorize({ amount: "$1.00", payee: "x" }).status === "allowed");
  check("spend over remaining daily budget denied", p.authorize({ amount: "$1.00", payee: "x" }).status === "denied");
}

// fail-closed on malformed input
{
  const p = new Purse({ maxPerAction: "$5.00" });
  check("malformed amount is denied, not allowed", p.authorize({ amount: "not money", payee: "x" }).status === "denied");
}

// tamper-evident audit
{
  const p = new Purse({ maxPerAction: "$5.00" });
  p.authorize({ amount: "$1", payee: "x" });
  p.authorize({ amount: "$2", payee: "x" });
  check("clean chain verifies", p.verify().ok === true);

  const tampered = p.audit();
  tampered[0]!.request.amount.amount = 999_999; // forge a record
  check("tampered chain is detected", verifyChain(tampered).ok === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
