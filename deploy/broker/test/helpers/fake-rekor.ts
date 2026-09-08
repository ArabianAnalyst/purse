import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { leafHashOf, nodeHashOf, checkpointKeyId, toBase64, fromBase64, type RekorRequest } from "@olurabian/receipt/anchor";

export interface FakeReply {
  logIndex: string;
  logId: { keyId: string };
  kindVersion: { kind: string; version: string };
  integratedTime: string;
  canonicalizedBody: string;
  inclusionProof: { logIndex: string; treeSize: string; rootHash: string; hashes: string[]; checkpoint: { envelope: string } };
}

export function rootOf(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return new Uint8Array(createHash("sha256").digest());
  if (leaves.length === 1) return leaves[0]!;
  const k = largestPowerOfTwoBelow(leaves.length);
  return nodeHashOf(rootOf(leaves.slice(0, k)), rootOf(leaves.slice(k)));
}

export function pathFor(index: number, leaves: Uint8Array[]): Uint8Array[] {
  if (leaves.length <= 1) return [];
  const k = largestPowerOfTwoBelow(leaves.length);
  if (index < k) return [...pathFor(index, leaves.slice(0, k)), rootOf(leaves.slice(k))];
  return [...pathFor(index - k, leaves.slice(k)), rootOf(leaves.slice(0, k))];
}

function largestPowerOfTwoBelow(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** A Rekor-shaped log for tests, real RFC 6962 trees and real C2SP checkpoints under a throwaway Ed25519 key. */
export class FakeRekor {
  readonly origin: string;
  readonly url: string;
  readonly publicKeyDer: string;
  readonly keyId: string;
  private readonly key: KeyObject;
  private readonly bodies: Uint8Array[] = [];
  /** Set to a non-201 status to make every submit fail. */
  status = 201;
  submits = 0;

  constructor(origin = "fake.log.test", url = "https://fake.log.test") {
    this.origin = origin;
    this.url = url;
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    this.key = privateKey;
    this.publicKeyDer = toBase64(new Uint8Array(publicKey.export({ type: "spki", format: "der" }) as Buffer));
    this.keyId = checkpointKeyId(origin, fromBase64(this.publicKeyDer));
  }

  get logKey(): { origin: string; publicKey: string } { return { origin: this.origin, publicKey: this.publicKeyDer }; }
  get size(): number { return this.bodies.length; }

  add(request: RekorRequest): FakeReply {
    const r = request.hashedRekordRequestV002;
    const body = JSON.stringify({ apiVersion: "0.0.2", kind: "hashedrekord", spec: { hashedRekordV002: { data: { algorithm: "SHA2_256", digest: r.digest }, signature: { content: r.signature.content, verifier: { keyDetails: r.signature.verifier.keyDetails, publicKey: { rawBytes: r.signature.verifier.publicKey.rawBytes } } } } } });
    this.bodies.push(new TextEncoder().encode(body));
    return this.entry(this.bodies.length - 1);
  }

  entry(index: number): FakeReply {
    const body = this.bodies[index];
    if (!body) throw new Error(`no entry ${index}`);
    const leaves = this.bodies.map(leafHashOf);
    const size = leaves.length;
    const root = rootOf(leaves);
    const text = `${this.origin}\n${size}\n${toBase64(root)}\n`;
    const sig = new Uint8Array(cryptoSign(null, Buffer.from(text, "utf8"), this.key));
    const line = toBase64(new Uint8Array([...fromBase64(this.keyId).subarray(0, 4), ...sig]));
    return {
      logIndex: String(index), logId: { keyId: this.keyId }, kindVersion: { kind: "hashedrekord", version: "0.0.2" }, integratedTime: "0",
      canonicalizedBody: toBase64(body),
      inclusionProof: { logIndex: String(index), treeSize: String(size), rootHash: toBase64(root), hashes: pathFor(index, leaves).map(toBase64), checkpoint: { envelope: `${text}\n— ${this.origin} ${line}\n` } },
    };
  }

  fetch(): typeof fetch {
    const impl = async (input: unknown, init?: { method?: string; body?: unknown }) => {
      this.submits++;
      if (!String(input).endsWith("/api/v2/log/entries") || init?.method !== "POST") return new Response("not found", { status: 404 });
      if (this.status !== 201) return new Response("unavailable", { status: this.status });
      return new Response(JSON.stringify(this.add(JSON.parse(String(init.body)) as RekorRequest)), { status: 201, headers: { "content-type": "application/json" } });
    };
    return impl as unknown as typeof fetch;
  }
}
