// Purse — a policy layer in front of your AI agent's payments.
export { Purse } from "./policy";
export type { PurseOptions } from "./policy";

export type {
  PolicyConfig,
  AuthorizeRequest,
  NormalizedRequest,
  Decision,
  DecisionStatus,
  AuditRecord,
} from "./types";

export { parseMoney, format, decimalsFor, type Money } from "./money";

export { verifyChain, JsonlAuditStore, type AuditStore, type VerifyResult } from "./audit";

// Enforcement mode (v0.2)
export { Broker } from "./broker";
export type { BrokerOptions, RequestResult, ExecuteResult, StatusResult, PendingView } from "./broker";
export { PurseClient } from "./client";
export { serveBroker, spawnAgent } from "./server";
export { serveHttp, HttpPurseClient } from "./transport/http";
export { MockExecutor, scrubReceipt } from "./executor";
export type { Executor, Receipt, Payable } from "./executor";
export { GrantStore } from "./grants";
export type { Grant, GrantState, GrantOrigin } from "./grants";
export { evaluate } from "./evaluate";
export type { Ledger, EvaluationResult } from "./evaluate";
export type { Explain, ExplainRule, AuditEvent, ScrubbedReceipt } from "./types";
