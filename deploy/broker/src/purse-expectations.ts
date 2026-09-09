import { pathToFileURL } from "node:url";
import { defineExpectations, type ActionRecord, type Expectation, type Trace } from "@olurabian/tripwire";
import type { MonitorConfig, Span } from "./monitor-config.js";

interface Money { amount: number; currency: string }
interface Ref { seq: number; ts: string }

const metaOf = (r: ActionRecord) => (r.meta ?? {}) as { grantId?: string; paidAmount?: Money };
const grantOf = (r: ActionRecord) => metaOf(r).grantId;
const refOf = (r: ActionRecord) => (r as { ref?: Ref }).ref;
const seqOf = (r: ActionRecord) => refOf(r)?.seq ?? -1;
const tsOf = (r: ActionRecord) => Date.parse(refOf(r)?.ts ?? "");
const payeeOf = (r: ActionRecord) => (r.input as { payee?: string } | undefined)?.payee;
const amountOf = (r: ActionRecord) => (r.input as { amount?: Money } | undefined)?.amount;
const mintedFor = (trace: Trace, grantId: string) => trace.records.find((x) => x.action === "grant_minted" && grantOf(x) === grantId);

export const BUILTIN_IDS = ["executed-without-grant", "executed-once", "paid-matches-decision", "payee-velocity"] as const;

/** The four built-ins, each defined only over fields the chain carries. */
export function builtinExpectations(velocity: Span): Expectation[] {
  return defineExpectations([
    {
      id: "executed-without-grant",
      reason: "An execution happened for a grant this window never saw minted.",
      where: { action: "executed" },
      must: (r, trace) => {
        const g = grantOf(r);
        if (!g) return false;
        const minted = mintedFor(trace, g);
        return !!minted && seqOf(minted) < seqOf(r);
      },
    },
    {
      id: "executed-once",
      reason: "A single-use grant executed twice.",
      where: { action: "executed" },
      must: (r, trace) => {
        const g = grantOf(r);
        if (!g) return true;
        return !trace.records.some((x) => x !== r && x.action === "executed" && grantOf(x) === g);
      },
    },
    {
      id: "paid-matches-decision",
      reason: "The rail settled more than the decision allowed.",
      where: { action: "executed" },
      must: (r, trace) => {
        const paid = metaOf(r).paidAmount;
        const g = grantOf(r);
        if (!paid || !g) return true;
        const minted = mintedFor(trace, g);
        const want = minted ? amountOf(minted) : undefined;
        if (!want) return true;
        return paid.amount <= want.amount && paid.currency === want.currency;
      },
    },
    {
      id: "payee-velocity",
      reason: "The same payee was paid too many times too quickly.",
      where: { action: "executed" },
      must: (r, trace) => {
        const payee = payeeOf(r);
        const t = tsOf(r);
        if (!payee || Number.isNaN(t)) return true;
        const n = trace.records.filter((x) => {
          if (x.action !== "executed" || payeeOf(x) !== payee) return false;
          const xt = tsOf(x);
          return !Number.isNaN(xt) && xt <= t && xt >= t - velocity.ms;
        }).length;
        return n < velocity.count;
      },
    },
  ]);
}

/** Built-ins minus MONITOR_DISABLE, then the custom module's default export. Ids must not collide. */
export async function loadExpectations(cfg: Pick<MonitorConfig, "velocity" | "disable" | "expectationsModule">): Promise<Expectation[]> {
  const known = new Set<string>(BUILTIN_IDS);
  for (const id of cfg.disable) {
    if (!known.has(id)) throw new Error(`purse-monitor: MONITOR_DISABLE names an unknown built-in "${id}", known ids are ${BUILTIN_IDS.join(", ")}`);
  }
  const builtins = builtinExpectations(cfg.velocity).filter((e) => !cfg.disable.includes(e.id));
  let custom: Expectation[] = [];
  if (cfg.expectationsModule) {
    let mod: { default?: unknown };
    try {
      mod = (await import(pathToFileURL(cfg.expectationsModule).href)) as { default?: unknown };
    } catch (e) {
      throw new Error(`purse-monitor: cannot load MONITOR_EXPECTATIONS ${cfg.expectationsModule}, ${(e as Error).message}`);
    }
    if (!Array.isArray(mod.default)) throw new Error(`purse-monitor: MONITOR_EXPECTATIONS ${cfg.expectationsModule} must default-export an array of expectations`);
    custom = mod.default as Expectation[];
  }
  try {
    return defineExpectations([...builtins, ...custom]);
  } catch (e) {
    throw new Error(`purse-monitor: ${(e as Error).message}`);
  }
}
