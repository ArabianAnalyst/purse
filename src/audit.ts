// audit.ts
// A tamper-evident decision log. Every record's hash includes the previous
// record's hash, so the chain breaks if any record is altered, inserted, or
// removed. You can prove the log was not edited after the fact.

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import type { AuditRecord, NormalizedRequest, DecisionStatus, AuditEvent, Explain, ScrubbedReceipt } from "./types";

const GENESIS = "0".repeat(64);

export interface AuditStore {
  /** Hash of the most recent record, or GENESIS if empty. */
  lastHash(): string;
  append(rec: AuditRecord): void;
  all(): AuditRecord[];
}

/**
 * Append-only JSONL store. Zero dependencies. Writes one record per line.
 * Pass a path to persist; omit it for an in-memory store.
 */
export class JsonlAuditStore implements AuditStore {
  private records: AuditRecord[] = [];

  constructor(private path?: string) {
    if (path && existsSync(path)) {
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      this.records = lines.map((l) => JSON.parse(l) as AuditRecord);
    }
  }

  lastHash(): string {
    const last = this.records[this.records.length - 1];
    return last ? last.hash : GENESIS;
  }

  append(rec: AuditRecord): void {
    this.records.push(rec);
    if (this.path) appendFileSync(this.path, JSON.stringify(rec) + "\n");
  }

  all(): AuditRecord[] {
    return [...this.records];
  }
}

/** Deterministic hash over every field except `hash` itself. Undefined fields are omitted by JSON.stringify, so v0.1 records hash identically. */
export function hashRecord(rec: Omit<AuditRecord, "hash">): string {
  const payload = JSON.stringify({
    id: rec.id,
    ts: rec.ts,
    request: rec.request,
    status: rec.status,
    reason: rec.reason,
    policyVersion: rec.policyVersion,
    event: rec.event,
    explain: rec.explain,
    grantId: rec.grantId,
    receipt: rec.receipt,
    prevHash: rec.prevHash,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export interface RecordInput {
  request: NormalizedRequest;
  status: DecisionStatus;
  reason: string;
  policyVersion: string;
  event?: AuditEvent;
  explain?: Explain;
  grantId?: string;
  receipt?: ScrubbedReceipt;
}

/** Build, hash, and append a record. Returns the finished record. */
export function makeRecord(store: AuditStore, input: RecordInput): AuditRecord {
  const base: Omit<AuditRecord, "hash"> = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    request: input.request,
    status: input.status,
    reason: input.reason,
    policyVersion: input.policyVersion,
    event: input.event,
    explain: input.explain,
    grantId: input.grantId,
    receipt: input.receipt,
    prevHash: store.lastHash(),
  };
  const rec: AuditRecord = { ...base, hash: hashRecord(base) };
  store.append(rec);
  return rec;
}

export interface VerifyResult {
  ok: boolean;
  /** Index of the first broken record, if any. */
  brokenAt?: number;
  reason?: string;
}

/**
 * Walk the chain and confirm it has not been tampered with.
 * Detects altered records (hash mismatch) and inserted/removed records
 * (prevHash mismatch).
 */
export function verifyChain(records: AuditRecord[]): VerifyResult {
  let prev = GENESIS;
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (r.prevHash !== prev) {
      return { ok: false, brokenAt: i, reason: "prevHash mismatch (a record was inserted or removed)" };
    }
    if (r.hash !== hashRecord(r)) {
      return { ok: false, brokenAt: i, reason: "hash mismatch (a record was altered)" };
    }
    prev = r.hash;
  }
  return { ok: true };
}
