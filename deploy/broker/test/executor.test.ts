import { test } from "node:test";
import assert from "node:assert/strict";
import { Broker } from "@olurabian/purse";
import { startMock402 } from "@olurabian/purse/x402";
import { buildExecutor, usdcToMoney } from "../src/executor.js";

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

test("usdc atomic units convert to cents only when exact", () => {
  assert.deepEqual(usdcToMoney({ maxAmountRequired: "5000000" }, "USD"), { amount: 500, currency: "USD" });
  assert.deepEqual(usdcToMoney({ maxAmountRequired: "10000" }, "USD"), { amount: 1, currency: "USD" });
  assert.ok(Number.isNaN(usdcToMoney({ maxAmountRequired: "123" }, "USD").amount));
  assert.ok(Number.isNaN(usdcToMoney({ maxAmountRequired: "5000000" }, "EUR").amount));
});

test("evm signer is built from config and exposes its address", () => {
  const { signerAddress } = buildExecutor({ kind: "x402", resources: { v: "https://x" }, signer: "evm", network: "base-sepolia", privateKey: ("0x" + "7".repeat(64)) as `0x${string}`, allowMainnet: false }, "USD");
  assert.match(signerAddress ?? "", /^0x[0-9a-fA-F]{40}$/);
});
