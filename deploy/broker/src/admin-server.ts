import { createServer, type Server } from "node:http";
import type { Broker } from "@olurabian/purse";
import { readJson, send, bearerMatches, errorStatus } from "./http.js";
import type { OpenedStore } from "./store.js";

export interface Readiness { ok: boolean; reason?: string }

export function createAdminServer(broker: Broker, store: OpenedStore, token: string, ready: () => Readiness, stream = "purse"): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://admin");
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
      if (!bearerMatches(req.headers.authorization, token)) return send(res, 401, { error: "unauthorized" });
      if (req.method === "GET") {
        switch (url.pathname) {
          case "/readyz": { const r = ready(); return send(res, r.ok ? 200 : 503, r); }
          case "/pending": return send(res, 200, { pending: broker.pending() });
          case "/verify": {
            const v = broker.verify();
            const anchored = await anchoredUpTo(store, stream);
            return send(res, 200, { ...v, records: broker.audit().length, pending: store.pending(), degraded: store.degraded()?.message ?? null, ...anchored });
          }
          case "/audit": {
            const since = url.searchParams.get("since");
            if (since && Number.isNaN(Date.parse(since))) return send(res, 400, { error: "since must be an ISO-8601 timestamp" });
            const all = broker.audit();
            return send(res, 200, { receipts: since ? all.filter((r) => Date.parse(r.ts) >= Date.parse(since)) : all });
          }
          default: return send(res, 404, { error: "not found" });
        }
      }
      if (req.method === "POST") {
        const body = (await readJson(req)) as { pendingId?: unknown };
        const id = String(body.pendingId ?? "");
        switch (url.pathname) {
          case "/approve": return send(res, 200, broker.approve(id));
          case "/deny": return send(res, 200, broker.deny(id));
          default: return send(res, 404, { error: "not found" });
        }
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      if (!res.headersSent) send(res, errorStatus(e), { error: (e as Error).message });
    }
  });
}

/** The highest anchored seq and the anchor count for this stream, or null and 0 when there is no anchors table yet. */
async function anchoredUpTo(store: OpenedStore, stream: string): Promise<{ anchoredUpTo: number | null; anchors: number }> {
  if (!store.sql) return { anchoredUpTo: null, anchors: 0 };
  try {
    const { rows } = await store.sql.query("SELECT max(seq) AS top, count(*)::int AS n FROM anchors WHERE stream = $1", [stream]);
    const r = rows[0];
    const top = r?.top == null ? null : Number(r.top);
    return { anchoredUpTo: top, anchors: Number(r?.n ?? 0) };
  } catch {
    return { anchoredUpTo: null, anchors: 0 };
  }
}
