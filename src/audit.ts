// audit.ts
// Purse's audit log is a chain of Deadlatch receipts. The engine (hashing,
// chain verification, stores) lives in @olurabian/receipt. This module types
// it for payment decisions and keeps Purse's public names stable:
// JsonlAuditStore, makeRecord, verifyChain, hashRecord, GENESIS.

import { JsonlStore, makeReceipt } from "@olurabian/receipt";
import type { Receipt, Store } from "@olurabian/receipt";
import type { DecisionPayload } from "./types.js";

export { GENESIS, hashRecord, verifyChain } from "@olurabian/receipt";
export type { VerifyResult } from "@olurabian/receipt";

/** A store of decision receipts. */
export type AuditStore = Store<DecisionPayload>;

/** The caller-owned fields of a decision receipt. The engine assigns id, ts, prevHash, hash. */
export type RecordInput = DecisionPayload;

/**
 * Append-only JSONL store of decision receipts. Zero third-party dependencies.
 * Pass a path to persist; omit it for an in-memory store.
 */
export class JsonlAuditStore extends JsonlStore<DecisionPayload> implements AuditStore {
  constructor(path?: string) {
    super(path);
    const isLegacyFlatRecord = this.all().some((r) => !("kind" in r) && !("payload" in r));
    if (isLegacyFlatRecord) {
      throw new Error(
        `JsonlAuditStore: ${path} was written by Purse 0.2 and uses the old flat record shape. Archive it and start a new audit file, or convert it. See README, Upgrading from 0.2.`,
      );
    }
  }
}

/** Build, hash, and append a decision receipt (kind "decision"). Returns the finished record. */
export function makeRecord(store: AuditStore, input: RecordInput): Receipt<DecisionPayload> {
  return makeReceipt(store, { kind: "decision", payload: input });
}
