import { MockExecutor, type Executor } from "@olurabian/purse";
import { X402Executor, MockSigner, type PaymentRequirements, type X402Signer } from "@olurabian/purse/x402";
import { EvmSigner } from "./evm-signer.js";
import type { ExecutorConfig } from "./config.js";

export interface Money { amount: number; currency: string }

/** 6-decimal USDC atomic units to policy cents. Anything that does not divide exactly, or a non-USD policy, is NaN so the ceiling guard rejects it. */
export function usdcToMoney(reqs: Pick<PaymentRequirements, "maxAmountRequired">, currency: string): Money {
  if (currency !== "USD") return { amount: Number.NaN, currency };
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
    const evm = new EvmSigner(cfg.privateKey!);
    signer = evm;
    signerAddress = evm.address;
  }
  const real = cfg.network !== "mock";
  const executor = new X402Executor({
    resolvePayee: (payee: string) => cfg.resources[payee],
    signer,
    ...(real ? { toMoney: (reqs: PaymentRequirements, cur: string) => usdcToMoney(reqs, cur) } : {}),
  });
  return { executor, signerAddress };
}
