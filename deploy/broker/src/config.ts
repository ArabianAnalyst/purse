import { readFileSync } from "node:fs";

export class ConfigError extends Error {
  constructor(message: string) { super(`purse-broker config: ${message}`); this.name = "ConfigError"; }
}

export interface PolicyEnv {
  currency: string; maxPerAction?: string; maxPerDay?: string; requireApprovalOver?: string; allow?: string[]; deny?: string[]; grantTtlMs?: number;
}
export type StoreConfig = { kind: "postgres"; url: string; stream: string } | { kind: "jsonl"; file: string };
export type ExecutorConfig =
  | { kind: "mock" }
  | { kind: "x402"; resources: Record<string, string>; signer: "mock" | "evm"; network: string; privateKey?: `0x${string}`; allowMainnet: boolean; asset?: `0x${string}` };
export interface Config {
  policy: PolicyEnv; store: StoreConfig; ports: { agent: number; admin: number; bind: string };
  adminToken: string; executor: ExecutorConfig; maxPending: number; otel: boolean;
}

type Env = Record<string, string | undefined>;
const list = (v?: string) => v?.split(",").map((s) => s.trim()).filter(Boolean);
const int = (name: string, v: string | undefined, dflt: number): number => {
  if (v == null || v === "") return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`${name} must be a non-negative integer, got "${v}"`);
  return n;
};
const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const REAL_NETWORKS = new Set(["base-sepolia", "base"]);

export function loadConfig(env: Env = process.env, readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): Config {
  const adminToken = env.PURSE_ADMIN_TOKEN;
  if (!adminToken) throw new ConfigError("PURSE_ADMIN_TOKEN is required (a random string of at least 24 characters)");
  if (adminToken.length < 24) throw new ConfigError("PURSE_ADMIN_TOKEN must be at least 24 characters");

  const currency = env.PURSE_CURRENCY ?? "USD";
  const policy: PolicyEnv = { currency };
  if (env.PURSE_MAX_PER_ACTION) policy.maxPerAction = env.PURSE_MAX_PER_ACTION;
  if (env.PURSE_MAX_PER_DAY) policy.maxPerDay = env.PURSE_MAX_PER_DAY;
  if (env.PURSE_REQUIRE_APPROVAL_OVER) policy.requireApprovalOver = env.PURSE_REQUIRE_APPROVAL_OVER;
  const allow = list(env.PURSE_ALLOW); if (allow?.length) policy.allow = allow;
  const deny = list(env.PURSE_DENY); if (deny?.length) policy.deny = deny;
  if (env.PURSE_GRANT_TTL_MS) policy.grantTtlMs = int("PURSE_GRANT_TTL_MS", env.PURSE_GRANT_TTL_MS, 0);

  let store: StoreConfig;
  if (env.PURSE_STORE === "jsonl") {
    store = { kind: "jsonl", file: env.PURSE_AUDIT_FILE ?? "./purse-audit.jsonl" };
  } else {
    if (!env.DATABASE_URL) throw new ConfigError("DATABASE_URL is required (set PURSE_STORE=jsonl only for development)");
    store = { kind: "postgres", url: env.DATABASE_URL, stream: env.PURSE_STREAM ?? "purse" };
  }

  const ports = { agent: int("PURSE_AGENT_PORT", env.PURSE_AGENT_PORT, 8080), admin: int("PURSE_ADMIN_PORT", env.PURSE_ADMIN_PORT, 8081), bind: env.PURSE_BIND ?? "0.0.0.0" };
  if (ports.agent === ports.admin) throw new ConfigError("PURSE_AGENT_PORT and PURSE_ADMIN_PORT must differ");

  let executor: ExecutorConfig = { kind: "mock" };
  const kind = env.PURSE_EXECUTOR ?? "mock";
  if (kind === "x402") {
    if (!env.PURSE_X402_RESOURCES) throw new ConfigError("PURSE_X402_RESOURCES is required for the x402 executor (JSON object of payee to resource URL)");
    let resources: Record<string, string>;
    try {
      const parsed = JSON.parse(env.PURSE_X402_RESOURCES) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      resources = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([k, v]) => {
        if (typeof v !== "string" || !/^https?:\/\//.test(v)) throw new Error(`resource for "${k}" must be an http(s) URL`);
        return [k, v];
      }));
    } catch (e) { throw new ConfigError(`PURSE_X402_RESOURCES is not a JSON object of payee to URL (${(e as Error).message})`); }
    const network = env.PURSE_X402_NETWORK ?? "base-sepolia";
    if (network !== "mock" && !REAL_NETWORKS.has(network)) throw new ConfigError(`PURSE_X402_NETWORK must be mock, base-sepolia, or base, got "${network}"`);
    const signer = (env.PURSE_X402_SIGNER ?? (network === "mock" ? "mock" : "evm")) as "mock" | "evm";
    if (signer !== "mock" && signer !== "evm") throw new ConfigError(`PURSE_X402_SIGNER must be mock or evm, got "${signer}"`);
    if (network === "mock" && signer === "evm") throw new ConfigError("PURSE_X402_SIGNER=evm cannot be used with the mock network");
    if (signer === "mock" && network !== "mock") throw new ConfigError("PURSE_X402_SIGNER=mock is only valid with PURSE_X402_NETWORK=mock");
    if (signer === "evm" && !REAL_NETWORKS.has(network)) throw new ConfigError(`PURSE_X402_NETWORK must be base-sepolia or base for the evm signer, got "${network}"`);
    const allowMainnet = env.PURSE_X402_ALLOW_MAINNET === "1";
    if (network === "base" && !allowMainnet) throw new ConfigError("PURSE_X402_NETWORK=base moves real money; set PURSE_X402_ALLOW_MAINNET=1 to confirm");
    if (REAL_NETWORKS.has(network) && currency !== "USD") throw new ConfigError("PURSE_CURRENCY must be USD when settling USDC over x402");
    let privateKey: `0x${string}` | undefined;
    if (signer === "evm") {
      let raw = env.PURSE_X402_KEY_FILE ? readFile(env.PURSE_X402_KEY_FILE).trim() : env.PURSE_X402_PRIVATE_KEY?.trim();
      if (!raw) throw new ConfigError("the evm signer needs PURSE_X402_PRIVATE_KEY or PURSE_X402_KEY_FILE");
      if (!raw.startsWith("0x")) raw = `0x${raw}`;
      if (!HEX_KEY.test(raw)) throw new ConfigError("the signer key must be 64 hex characters, optionally 0x-prefixed");
      privateKey = raw as `0x${string}`;
    }
    let asset: `0x${string}` | undefined;
    if (env.PURSE_X402_ASSET) {
      if (!HEX_ADDRESS.test(env.PURSE_X402_ASSET)) throw new ConfigError("PURSE_X402_ASSET must be a 0x-prefixed 20-byte address");
      if (network === "mock") throw new ConfigError("PURSE_X402_ASSET cannot be used with PURSE_X402_NETWORK=mock");
      asset = env.PURSE_X402_ASSET as `0x${string}`;
    }
    executor = { kind: "x402", resources, signer, network, privateKey, allowMainnet, asset };
  } else if (kind !== "mock") {
    throw new ConfigError(`PURSE_EXECUTOR must be mock or x402, got "${kind}"`);
  }

  return { policy, store, ports, adminToken, executor, maxPending: int("PURSE_MAX_PENDING", env.PURSE_MAX_PENDING, 100), otel: Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT) };
}
