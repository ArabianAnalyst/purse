import { createServer, type Server } from "node:http";
import type { Broker } from "@olurabian/purse";
import { readJson, send, bearerMatches, errorStatus } from "./http.js";
import type { OpenedStore } from "./store.js";

export interface Readiness { ok: boolean; reason?: string }

export function createAdminServer(broker: Broker, store: OpenedStore, token: string, ready: () => Readiness): Server {
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
            return send(res, 200, { ...v, records: broker.audit().length, pending: store.pending(), degraded: store.degraded()?.message ?? null });
          }
          case "/audit": {
            const since = url.searchParams.get("since");
            const all = broker.audit();
            return send(res, 200, { receipts: since ? all.filter((r) => r.ts >= since) : all });
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
