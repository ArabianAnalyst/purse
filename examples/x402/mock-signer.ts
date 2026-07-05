// mock-signer.ts — deterministic signer for tests/demo. Produces a stand-in X-PAYMENT
// header instead of a real EIP-3009 authorization. Holds no key.
import type { X402Signer, PaymentRequirements } from "./types";

export class MockSigner implements X402Signer {
  async sign(reqs: PaymentRequirements): Promise<string> {
    const payload = JSON.stringify({ payTo: reqs.payTo, amount: reqs.maxAmountRequired, network: reqs.network });
    return "mock-payment:" + Buffer.from(payload).toString("base64");
  }
}
