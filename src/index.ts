// Purse — a policy layer in front of your AI agent's payments.
export { Purse } from "./policy.js";
export type { PurseOptions } from "./policy.js";

export type {
  PolicyConfig,
  AuthorizeRequest,
  NormalizedRequest,
  Decision,
  DecisionStatus,
  AuditRecord,
  DecisionPayload,
} from "./types.js";

export { parseMoney, format, decimalsFor, type Money } from "./money.js";

export { verifyChain, hashRecord, GENESIS, JsonlAuditStore, makeRecord, type AuditStore, type VerifyResult } from "./audit.js";

// Enforcement mode (v0.2)
export { Broker } from "./broker.js";
export type { BrokerOptions, RequestResult, ExecuteResult, StatusResult, PendingView } from "./broker.js";
export { PurseClient } from "./client.js";
export { serveBroker, spawnAgent } from "./server.js";
export { serveHttp, HttpPurseClient } from "./transport/http.js";
export { MockExecutor, scrubReceipt } from "./executor.js";
export type { Executor, Receipt, Payable } from "./executor.js";
export { GrantStore } from "./grants.js";
export type { Grant, GrantState, GrantOrigin } from "./grants.js";
export { evaluate } from "./evaluate.js";
export type { Ledger, EvaluationResult } from "./evaluate.js";
export type { Explain, ExplainRule, AuditEvent, ScrubbedReceipt } from "./types.js";
