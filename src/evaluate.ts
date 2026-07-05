// evaluate.ts — the pure policy engine, shared by Purse (advisory) and Broker (enforcement).
// The caller injects a Ledger (how much has been spent/reserved) and the clock, so this
// function is deterministic and side-effect free.
import type { PolicyConfig, NormalizedRequest, DecisionStatus, ExplainRule } from "./types";
import { parseMoney, format, gt, add, assertSameCurrency, type Money } from "./money";

export interface Ledger {
  spentSince(sinceMs: number, currency: string): Money;
}

export interface EvaluationResult {
  status: DecisionStatus;
  reason: string;
  rule: ExplainRule;
  reservation?: { used: Money; reserved: Money; cap: Money };
}

export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}
export function matchesAny(value: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(value));
}

export function evaluate(
  cfg: PolicyConfig,
  req: NormalizedRequest,
  ledger: Ledger,
  currency: string,
  nowMs: number,
): EvaluationResult {
  if (cfg.deny && matchesAny(req.payee, cfg.deny))
    return { status: "denied", reason: `denied: payee "${req.payee}" is blocked`, rule: "deny-list" };

  if (cfg.allow && cfg.allow.length > 0 && !matchesAny(req.payee, cfg.allow))
    return { status: "denied", reason: `denied: payee "${req.payee}" is not on the allowlist`, rule: "allowlist-miss" };

  if (cfg.categories && cfg.categories.length > 0) {
    if (!req.category || !cfg.categories.includes(req.category))
      return { status: "denied", reason: `denied: category "${req.category ?? "none"}" is not permitted`, rule: "category" };
  }

  if (cfg.maxPerAction !== undefined) {
    const cap = parseMoney(cfg.maxPerAction, currency);
    assertSameCurrency(req.amount, cap);
    if (gt(req.amount, cap))
      return { status: "denied", reason: `denied: ${format(req.amount)} exceeds the per-action cap of ${format(cap)}`, rule: "per-action-cap" };
  }

  const windows: Array<{ cap: Money; windowMs: number; label: string }> = [];
  if (cfg.maxPerDay !== undefined) windows.push({ cap: parseMoney(cfg.maxPerDay, currency), windowMs: 86_400_000, label: "daily" });
  if (cfg.maxPerWindow !== undefined) windows.push({ cap: parseMoney(cfg.maxPerWindow.amount, currency), windowMs: cfg.maxPerWindow.windowMs, label: "window" });
  for (const w of windows) {
    const used = ledger.spentSince(nowMs - w.windowMs, req.amount.currency);
    const projected = add(used, req.amount);
    if (gt(projected, w.cap))
      return {
        status: "denied",
        reason: `denied: would exceed the ${w.label} cap of ${format(w.cap)} (${format(used)} already used)`,
        rule: "velocity",
        reservation: { used, reserved: req.amount, cap: w.cap },
      };
  }

  if (cfg.requireApprovalOver !== undefined) {
    const threshold = parseMoney(cfg.requireApprovalOver, currency);
    assertSameCurrency(req.amount, threshold);
    if (gt(req.amount, threshold))
      return { status: "needs_approval", reason: `needs approval: ${format(req.amount)} is above the auto-approve threshold of ${format(threshold)}`, rule: "require-approval" };
  }

  return { status: "allowed", reason: "within policy", rule: "within-policy" };
}
