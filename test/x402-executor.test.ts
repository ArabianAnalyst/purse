import { createServer } from "node:http";
import { startMock402, MockSigner, X402Executor } from "../src/x402/index.js";
import { parseMoney } from "../src/index";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}
const signer = new MockSigner();

// a local 402 resource whose paid response is fully scripted, for the settlement-proof scenes below
function startCustom402(paidResponse: { headers?: Record<string, string>; body?: string }): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const paid = typeof req.headers["x-payment"] === "string" && req.headers["x-payment"].length > 0;
    if (!paid) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({
        x402Version: 1,
        accepts: [{ scheme: "exact", network: "mock", maxAmountRequired: "500", payTo: "acme", asset: "USD-cents", resource: req.url ?? "/" }],
      }));
      return;
    }
    res.writeHead(200, paidResponse.headers ?? {});
    res.end(paidResponse.body ?? "");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

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

// unrecognized asset -> fail closed (default toMoney does not recognize it)
{
  const server = await startMock402({ amount: "500", asset: "WEIRD-TOKEN" });
  const ex = new X402Executor({ resolvePayee: () => server.url, signer });
  const r = await ex.execute({ id: "g5", payee: "acme.example", amount: parseMoney("$5.00", "USD") });
  check("rejects a challenge in an unrecognized asset", r.ok === false);
  await server.close();
}

// a throwing toMoney must not escape execute() (fail closed)
{
  const server = await startMock402({ amount: "500" });
  const ex = new X402Executor({ resolvePayee: () => server.url, signer, toMoney: () => { throw new Error("boom"); } });
  const r = await ex.execute({ id: "g6", payee: "acme.example", amount: parseMoney("$5.00", "USD") });
  check("a throwing toMoney fails closed instead of throwing", r.ok === false);
  await server.close();
}

// settlement proof: a base64-encoded X-PAYMENT-RESPONSE header wins over a non-JSON body
{
  const headerPayload = Buffer.from(JSON.stringify({
    success: true, transaction: "0xabc123", network: "base-sepolia", payer: "0xpayer",
  })).toString("base64");
  const server = await startCustom402({ headers: { "x-payment-response": headerPayload }, body: "the paid content" });
  const ex = new X402Executor({ resolvePayee: () => server.url, signer });
  const r = await ex.execute({ id: "g7", payee: "acme.example", amount: parseMoney("$5.00", "USD") });
  check("reads the settlement ref from a base64 X-PAYMENT-RESPONSE header over a non-JSON body", r.ok === true && r.ref === "0xabc123");
  await server.close();
}

// settlement proof: a plain-JSON X-PAYMENT-RESPONSE header with an empty body
{
  const server = await startCustom402({ headers: { "x-payment-response": JSON.stringify({ ref: "r-1" }) }, body: "" });
  const ex = new X402Executor({ resolvePayee: () => server.url, signer });
  const r = await ex.execute({ id: "g8", payee: "acme.example", amount: parseMoney("$5.00", "USD") });
  check("reads the settlement ref from a plain-JSON X-PAYMENT-RESPONSE header with an empty body", r.ok === true && r.ref === "r-1");
  await server.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
