import { createServer } from "node:http";
import { startMock402 } from "../examples/x402/mock-402-server";
import { MockSigner } from "../examples/x402/mock-signer";
import { X402Executor } from "../examples/x402/x402-executor";
import { parseMoney } from "../src/index";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}
const signer = new MockSigner();

// happy path: 402 amount matches the grant -> settles
{
  const server = await startMock402({ amount: "500", payTo: "acme" }); // 500 cents
  const ex = new X402Executor({ resolvePayee: () => server.url, signer });
  const r = await ex.execute({ id: "g1", payee: "acme.example", amount: parseMoney("$5.00", "USD") });
  check("settles when 402 amount matches the grant", r.ok === true && typeof r.ref === "string");
  check("receipt echoes the granted amount", r.paidAmount?.amount === 500);
  await server.close();
}

// grant as ceiling: 402 amount ABOVE the grant -> fail closed
{
  const server = await startMock402({ amount: "999" }); // vendor demands $9.99
  const ex = new X402Executor({ resolvePayee: () => server.url, signer });
  const r = await ex.execute({ id: "g2", payee: "acme.example", amount: parseMoney("$5.00", "USD") });
  check("rejects when 402 amount exceeds the grant ceiling", r.ok === false);
  await server.close();
}

// grant as ceiling: 402 amount BELOW the grant -> settles the vendor's actual price
{
  const server = await startMock402({ amount: "300" }); // vendor charges $3
  const ex = new X402Executor({ resolvePayee: () => server.url, signer });
  const r = await ex.execute({ id: "g2b", payee: "acme.example", amount: parseMoney("$5.00", "USD") }); // authorized up to $5
  check("settles the vendor price when below the grant ceiling", r.ok === true);
  check("paidAmount reflects the actual price, not the ceiling", r.paidAmount?.amount === 300);
  await server.close();
}

// unmapped payee -> fail closed, no network call
{
  const ex = new X402Executor({ resolvePayee: () => undefined, signer });
  const r = await ex.execute({ id: "g3", payee: "unknown", amount: parseMoney("$1", "USD") });
  check("rejects an unmapped payee", r.ok === false);
}

// resource does not challenge (200, no 402) -> fail closed
{
  const plain = createServer((_req, res) => { res.writeHead(200); res.end("{}"); });
  await new Promise<void>((r) => plain.listen(0, "127.0.0.1", r));
  const addr = plain.address();
  const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  const ex = new X402Executor({ resolvePayee: () => url, signer });
  const r = await ex.execute({ id: "g4", payee: "acme.example", amount: parseMoney("$5", "USD") });
  check("rejects when the resource does not return a 402 challenge", r.ok === false);
  await new Promise<void>((res) => plain.close(() => res()));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
