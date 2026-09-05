import { getAddress } from "viem";
import { MockExecutor, type Executor } from "@olurabian/purse";
import { X402Executor, MockSigner, type PaymentRequirements, type X402Signer } from "@olurabian/purse/x402";
import { EvmSigner } from "./evm-signer.js";
import type { ExecutorConfig } from "./config.js";

export interface Money { amount: number; currency: string }

/** USDC contract per network. The default `toMoney` for a real network pins the challenge to this
 *  address (or `PURSE_X402_ASSET` when set) so a challenge cannot name an arbitrary token. */
export const USDC_BY_NETWORK: Record<string, `0x${string}`> = {
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

/** 6-decimal USDC atomic units to policy cents. Anything that does not divide exactly, names an
 *  asset other than the one this broker is configured to pay in, is not the "exact" scheme, or is
 *  a non-USD policy, is NaN so the ceiling guard rejects it. */
export function usdcToMoney(reqs: Pick<PaymentRequirements, "maxAmountRequired" | "asset" | "scheme">, currency: string, expectedAsset: `0x${string}`): Money {
  if (reqs.scheme !== "exact") return { amount: Number.NaN, currency };
  if (currency !== "USD") return { amount: Number.NaN, currency };
  try {
    if (getAddress(reqs.asset) !== getAddress(expectedAsset)) return { amount: Number.NaN, currency };
  } catch { return { amount: Number.NaN, currency }; }
  let atomic: bigint;
  try { atomic = BigInt(reqs.maxAmountRequired); } catch { return { amount: Number.NaN, currency }; }
  if (atomic < 0n || atomic % 10_000n !== 0n) return { amount: Number.NaN, currency };
  return { amount: Number(atomic / 10_000n), currency };
}

export function buildExecutor(cfg: ExecutorConfig, currency: string, overrides: { signer?: X402Signer } = {}): { executor: Executor; signerAddress?: string } {
  if (cfg.kind === "mock") return { executor: new MockExecutor() };
  let signer: X402Signer;
  let signerAddress: string | undefined;
  if (overrides.signer) signer = overrides.signer;
  else if (cfg.signer === "mock") signer = new MockSigner();
  else {
    const evm = new EvmSigner(cfg.privateKey!, { network: cfg.network });
    signer = evm;
    signerAddress = evm.address;
  }
  const real = cfg.network !== "mock";
  const expectedAsset = cfg.asset ?? USDC_BY_NETWORK[cfg.network]!;
  const executor = new X402Executor({
    resolvePayee: (payee: string) => cfg.resources[payee],
    signer,
    ...(real ? { toMoney: (reqs: PaymentRequirements, cur: string) => usdcToMoney(reqs, cur, expectedAsset) } : {}),
  });
  return { executor, signerAddress };
}
