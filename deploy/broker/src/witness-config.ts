import { checkpointKeyId, fromBase64 } from "@olurabian/receipt/anchor";

export class WitnessConfigError extends Error {
  constructor(message: string) { super(`purse-witness config: ${message}`); this.name = "WitnessConfigError"; }
}

export interface WitnessConfig {
  databaseUrl: string;
  stream: string;
  /** The receipts table the broker writes. */
  table: string;
  key: { file?: string; pem?: string };
  rekor: { url: string; logKey: { origin: string; publicKey: string }; timeoutMs: number };
  intervalMs: number;
  maxLag: number;
  port: number;
  bind: string;
  otel: boolean;
}

type Env = Record<string, string | undefined>;

const int = (name: string, v: string | undefined, dflt: number, min: number): number => {
  if (v == null || v === "") return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new WitnessConfigError(`${name} must be an integer of at least ${min}, got "${v}"`);
  return n;
};

/** `<origin>=<base64 SPKI DER>` of an Ed25519 log key, as Sigstore's trust root publishes it. */
export function parseLogKey(value: string): { origin: string; publicKey: string } {
  const i = value.indexOf("=");
  const origin = i > 0 ? value.slice(0, i) : "";
  const publicKey = i > 0 ? value.slice(i + 1) : "";
  if (!origin || !publicKey) throw new WitnessConfigError("REKOR_LOG_KEY must be <origin>=<base64 SPKI DER of the log's Ed25519 key>");
  try { checkpointKeyId(origin, fromBase64(publicKey)); }
  catch (e) { throw new WitnessConfigError(`REKOR_LOG_KEY is not an Ed25519 SPKI key (${(e as Error).message})`); }
  return { origin, publicKey };
}

export function loadWitnessConfig(env: Env = process.env): WitnessConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new WitnessConfigError("DATABASE_URL is required");
  const stream = env.WITNESS_STREAM ?? env.PURSE_STREAM ?? "purse";
  const file = env.WITNESS_KEY_FILE || undefined;
  const pem = env.WITNESS_KEY_PEM || undefined;
  if (!file && !pem) throw new WitnessConfigError("set WITNESS_KEY_FILE or WITNESS_KEY_PEM (run `node dist/witness.js keygen` to make one)");
  const url = (env.REKOR_URL ?? "https://log2025-1.rekor.sigstore.dev").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) throw new WitnessConfigError(`REKOR_URL must start with http:// or https://, got "${url}"`);
  if (!env.REKOR_LOG_KEY) throw new WitnessConfigError("REKOR_LOG_KEY is required, <origin>=<base64 SPKI DER> from Sigstore's trust root");
  const logKey = parseLogKey(env.REKOR_LOG_KEY);
  return {
    databaseUrl, stream, table: "receipts",
    key: { file, pem },
    rekor: { url, logKey, timeoutMs: int("REKOR_TIMEOUT_MS", env.REKOR_TIMEOUT_MS, 30000, 1000) },
    intervalMs: int("WITNESS_INTERVAL_MS", env.WITNESS_INTERVAL_MS, 300000, 1000),
    maxLag: int("WITNESS_MAX_LAG", env.WITNESS_MAX_LAG, 2, 1),
    port: int("WITNESS_PORT", env.WITNESS_PORT, 8082, 0),
    bind: env.WITNESS_BIND ?? "0.0.0.0",
    otel: Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT),
  };
}
