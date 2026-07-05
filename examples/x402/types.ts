// types.ts — the minimal x402 shapes this adapter needs. A real x402 challenge carries
// more fields; these are the ones the executor reads.
export interface PaymentRequirements {
  scheme: string;            // "exact"
  network: string;           // "base-sepolia" (real) or "mock"
  maxAmountRequired: string; // atomic units of `asset`, as a string
  payTo: string;             // receiving address / vendor id
  asset: string;             // token contract address, or "USD-cents" in the mock
  resource: string;          // the resource URL being paid for
}

// Given the challenge, produce the value for the X-PAYMENT header.
// Mock: encodes the challenge. Real: signs an EIP-3009 authorization with a wallet.
export interface X402Signer {
  sign(reqs: PaymentRequirements): Promise<string>;
}
