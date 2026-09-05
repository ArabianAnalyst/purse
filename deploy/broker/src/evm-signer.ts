import { randomBytes } from "node:crypto";
import { getAddress, toHex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { PaymentRequirements, X402Signer } from "@olurabian/purse/x402";

export const CHAIN_IDS: Record<string, number> = { "base-sepolia": 84532, base: 8453 };

export const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * Signs x402 v1 "exact" payments on EVM networks: an EIP-3009 TransferWithAuthorization
 * over the USDC contract named in the challenge, encoded as the X-PAYMENT header the way
 * the official client does it. The key lives only in this object.
 */
export class EvmSigner implements X402Signer {
  readonly address: `0x${string}`;
  private readonly account: PrivateKeyAccount;
  private readonly network: string;
  private readonly nowSeconds: () => number;
  private readonly newNonce: () => `0x${string}`;

  constructor(
    privateKey: `0x${string}`,
    opts: { network: string; nowSeconds?: () => number; newNonce?: () => `0x${string}` },
  ) {
    this.account = privateKeyToAccount(privateKey);
    this.address = this.account.address;
    this.network = opts.network;
    this.nowSeconds = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.newNonce = opts.newNonce ?? (() => toHex(randomBytes(32)));
  }

  async sign(reqs: PaymentRequirements, ctx: { x402Version: number }): Promise<string> {
    if (reqs.scheme !== "exact") throw new Error(`EvmSigner: unsupported scheme "${reqs.scheme}"`);
    if (reqs.network !== this.network) throw new Error(`EvmSigner: challenge is for network "${reqs.network}" but this signer is configured for "${this.network}"`);
    const chainId = CHAIN_IDS[reqs.network];
    if (!chainId) throw new Error(`EvmSigner: unsupported network "${reqs.network}"`);
    const name = reqs.extra?.name;
    const version = reqs.extra?.version;
    if (!name || !version) throw new Error("EvmSigner: the 402 requirements lack extra.name and extra.version (the EIP-712 domain)");
    const now = this.nowSeconds();
    const authorization = {
      from: this.address,
      to: getAddress(reqs.payTo),
      value: reqs.maxAmountRequired,
      validAfter: String(now - 600),
      validBefore: String(now + (reqs.maxTimeoutSeconds ?? 60)),
      nonce: this.newNonce(),
    };
    const signature = await this.account.signTypedData({
      domain: { name, version, chainId, verifyingContract: getAddress(reqs.asset) },
      types: AUTH_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
    });
    const payment = { x402Version: ctx.x402Version, scheme: reqs.scheme, network: reqs.network, payload: { signature, authorization } };
    return Buffer.from(JSON.stringify(payment), "utf8").toString("base64");
  }
}
