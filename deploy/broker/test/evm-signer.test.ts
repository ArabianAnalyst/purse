import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData, getAddress } from "viem";
import { createPaymentHeader } from "x402/client";
import { EvmSigner, AUTH_TYPES, CHAIN_IDS } from "../src/evm-signer.js";

const KEY = ("0x" + "7".repeat(64)) as `0x${string}`;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const reqs = {
  scheme: "exact", network: "base-sepolia", maxAmountRequired: "5000000", payTo: PAY_TO, asset: USDC,
  resource: "https://pay.example/resource", description: "test", mimeType: "application/json",
  maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" },
};

function decode(header: string) {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    x402Version: number; scheme: string; network: string;
    payload: { signature: `0x${string}`; authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: `0x${string}` } };
  };
}

async function verifies(address: `0x${string}`, d: ReturnType<typeof decode>) {
  const a = d.payload.authorization;
  return verifyTypedData({
    address,
    domain: { name: "USDC", version: "2", chainId: CHAIN_IDS["base-sepolia"]!, verifyingContract: USDC },
    types: AUTH_TYPES, primaryType: "TransferWithAuthorization",
    message: { from: getAddress(a.from), to: getAddress(a.to), value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
    signature: d.payload.signature,
  });
}

test("matches the official x402 v1 client structurally and both signatures verify", async () => {
  const signer = new EvmSigner(KEY, { network: "base-sepolia" });
  const account = privateKeyToAccount(KEY);
  assert.equal(signer.address, account.address);
  const ours = decode(await signer.sign(reqs, { x402Version: 1 }));
  const theirs = decode(await createPaymentHeader(account, 1, reqs as never));
  for (const k of ["x402Version", "scheme", "network"] as const) assert.equal(ours[k], theirs[k]);
  assert.equal(ours.payload.authorization.from.toLowerCase(), theirs.payload.authorization.from.toLowerCase());
  assert.equal(ours.payload.authorization.to.toLowerCase(), theirs.payload.authorization.to.toLowerCase());
  assert.equal(ours.payload.authorization.value, theirs.payload.authorization.value);
  assert.match(ours.payload.authorization.nonce, /^0x[0-9a-f]{64}$/);
  assert.match(theirs.payload.authorization.nonce, /^0x[0-9a-f]{64}$/);
  assert.ok(Math.abs(Number(ours.payload.authorization.validAfter) - Number(theirs.payload.authorization.validAfter)) <= 5);
  assert.ok(Math.abs(Number(ours.payload.authorization.validBefore) - Number(theirs.payload.authorization.validBefore)) <= 5);
  assert.deepEqual(Object.keys(ours.payload.authorization).sort(), Object.keys(theirs.payload.authorization).sort());
  assert.equal(await verifies(account.address, ours), true);
  assert.equal(await verifies(account.address, theirs), true);
});

test("validity window and nonce come from the injected clock and nonce", async () => {
  const signer = new EvmSigner(KEY, { network: "base-sepolia", nowSeconds: () => 1_700_000_000, newNonce: () => ("0x" + "ab".repeat(32)) as `0x${string}` });
  const d = decode(await signer.sign(reqs, { x402Version: 1 }));
  assert.equal(d.payload.authorization.validAfter, String(1_700_000_000 - 600));
  assert.equal(d.payload.authorization.validBefore, String(1_700_000_000 + 300));
  assert.equal(d.payload.authorization.nonce, "0x" + "ab".repeat(32));
  const d2 = decode(await signer.sign({ ...reqs, maxTimeoutSeconds: undefined }, { x402Version: 1 }));
  assert.equal(d2.payload.authorization.validBefore, String(1_700_000_000 + 60));
});

test("refuses a challenge without the EIP-712 domain or on an unknown network", async () => {
  const signer = new EvmSigner(KEY, { network: "base-sepolia" });
  await assert.rejects(signer.sign({ ...reqs, extra: undefined }, { x402Version: 1 }), /extra\.name and extra\.version/);
  // The chainId lookup is a defensive fallback: in production a signer is only ever configured
  // for a network in CHAIN_IDS, so reaching it needs the signer's own configured network to be
  // the unknown one too (the network-match check above would otherwise fire first).
  const unconfigured = new EvmSigner(KEY, { network: "mock" });
  await assert.rejects(unconfigured.sign({ ...reqs, network: "mock" }, { x402Version: 1 }), /unsupported network "mock"/);
});

test("refuses a challenge on another network or another scheme", async () => {
  const signer = new EvmSigner(KEY, { network: "base-sepolia" });
  await assert.rejects(signer.sign({ ...reqs, network: "base" }, { x402Version: 1 }), /configured for "base-sepolia"/);
  await assert.rejects(signer.sign({ ...reqs, scheme: "upto" }, { x402Version: 1 }), /unsupported scheme/);
});
