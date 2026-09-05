import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Broker } from "@olurabian/purse";
import { startMock402 } from "@olurabian/purse/x402";
import { buildExecutor, usdcToMoney, USDC_BY_NETWORK } from "../src/executor.js";

test("mock executor pays", async () => {
  const { executor, signerAddress } = buildExecutor({ kind: "mock" }, "USD");
  assert.equal(signerAddress, undefined);
  const b = new Broker({ maxPerAction: "$5", allow: ["v"], executor });
  const r = b.request({ amount: "$1", payee: "v", intent: "t" });
  assert.equal((await b.execute(r.grantId!)).status, "paid");
});

test("x402 executor with the mock signer settles against the packaged mock server", async () => {
  const mock = await startMock402({ amount: "300" });
  try {
    const { executor } = buildExecutor({ kind: "x402", resources: { vendor: mock.url }, signer: "mock", network: "mock", allowMainnet: false }, "USD");
    const b = new Broker({ maxPerAction: "$5", allow: ["vendor"], executor });
    const r = b.request({ amount: "$3", payee: "vendor", intent: "t" });
    const x = await b.execute(r.grantId!);
    assert.equal(x.status, "paid");
    assert.equal(x.receipt?.ref, "mock_tx_1");
    const r2 = b.request({ amount: "$3", payee: "unknown", intent: "t" });
    assert.equal(r2.decision, "denied");
  } finally { await mock.close(); }
});

const SEPOLIA_USDC = USDC_BY_NETWORK["base-sepolia"]!;

test("usdc atomic units convert to cents only when exact", () => {
  assert.deepEqual(usdcToMoney({ maxAmountRequired: "5000000", asset: SEPOLIA_USDC, scheme: "exact" }, "USD", SEPOLIA_USDC), { amount: 500, currency: "USD" });
  assert.deepEqual(usdcToMoney({ maxAmountRequired: "10000", asset: SEPOLIA_USDC, scheme: "exact" }, "USD", SEPOLIA_USDC), { amount: 1, currency: "USD" });
  assert.ok(Number.isNaN(usdcToMoney({ maxAmountRequired: "123", asset: SEPOLIA_USDC, scheme: "exact" }, "USD", SEPOLIA_USDC).amount));
  assert.ok(Number.isNaN(usdcToMoney({ maxAmountRequired: "5000000", asset: SEPOLIA_USDC, scheme: "exact" }, "EUR", SEPOLIA_USDC).amount));
  assert.ok(Number.isNaN(usdcToMoney({ maxAmountRequired: "5000000", asset: "0x1111111111111111111111111111111111111111", scheme: "exact" }, "USD", SEPOLIA_USDC).amount));
  assert.ok(Number.isNaN(usdcToMoney({ maxAmountRequired: "5000000", asset: SEPOLIA_USDC, scheme: "upto" }, "USD", SEPOLIA_USDC).amount));
});

test("evm signer is built from config and exposes its address", () => {
  const { signerAddress } = buildExecutor({ kind: "x402", resources: { v: "https://x" }, signer: "evm", network: "base-sepolia", privateKey: ("0x" + "7".repeat(64)) as `0x${string}`, allowMainnet: false }, "USD");
  assert.match(signerAddress ?? "", /^0x[0-9a-fA-F]{40}$/);
});

/** Serves an x402 402 challenge until it sees an X-PAYMENT header, then "settles" with 200. Counts
 *  how many requests actually carried a payment, which must stay at zero when the broker refuses. */
function startChallengeServer(challenge: Record<string, unknown>): Promise<{ url: string; paidRequests: number; close(): Promise<void> }> {
  const state = { paidRequests: 0 };
  const server = createServer((req, res) => {
    if (req.headers["x-payment"]) {
      state.paidRequests++;
      res.writeHead(200, { "content-type": "application/json", "x-payment-response": JSON.stringify({ ref: "settled_tx" }) });
      res.end(JSON.stringify({ ref: "settled_tx" }));
      return;
    }
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify({ x402Version: 1, accepts: [challenge] }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/r`,
        get paidRequests() { return state.paidRequests; },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

test("a real-network broker never signs a challenge for another network or asset", async () => {
  const KEY = ("0x" + "7".repeat(64)) as `0x${string}`;
  const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";

  // Variant 1: the challenge claims mainnet ("base") while the broker is configured for base-sepolia.
  {
    const mock = await startChallengeServer({
      scheme: "exact", network: "base", maxAmountRequired: "20000000", payTo: PAY_TO,
      asset: "0x1111111111111111111111111111111111111111", resource: "/r", maxTimeoutSeconds: 60,
      extra: { name: "NotUSDC", version: "1" },
    });
    try {
      const { executor } = buildExecutor({ kind: "x402", resources: { v: mock.url }, signer: "evm", network: "base-sepolia", privateKey: KEY, allowMainnet: false }, "USD");
      const b = new Broker({ maxPerAction: "$50", allow: ["v"], executor });
      const r = b.request({ amount: "$25", payee: "v", intent: "t" });
      const x = await b.execute(r.grantId!);
      assert.equal(x.status, "rejected");
      assert.equal(mock.paidRequests, 0);
    } finally { await mock.close(); }
  }

  // Variant 2: the challenge names the right network but the wrong asset contract.
  {
    const mock = await startChallengeServer({
      scheme: "exact", network: "base-sepolia", maxAmountRequired: "20000000", payTo: PAY_TO,
      asset: "0x2222222222222222222222222222222222222222", resource: "/r", maxTimeoutSeconds: 60,
      extra: { name: "NotUSDC", version: "1" },
    });
    try {
      const { executor } = buildExecutor({ kind: "x402", resources: { v: mock.url }, signer: "evm", network: "base-sepolia", privateKey: KEY, allowMainnet: false }, "USD");
      const b = new Broker({ maxPerAction: "$50", allow: ["v"], executor });
      const r = b.request({ amount: "$25", payee: "v", intent: "t" });
      const x = await b.execute(r.grantId!);
      assert.equal(x.status, "rejected");
      assert.equal(mock.paidRequests, 0);
    } finally { await mock.close(); }
  }
});
