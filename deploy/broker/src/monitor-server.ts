import { createServer, type Server } from "node:http";
import { send, sinceParam } from "./http.js";
import type { MonitorApp } from "./monitor-app.js";
import type { MonitorConfig } from "./monitor-config.js";

/** Read-only, no token. The key never appears here, only its prefix. Nothing on this port can change anything. */
export function createMonitorServer(app: MonitorApp, cfg: MonitorConfig): Server {
  const index = () => {
    const s = app.state();
    return {
      service: "purse-monitor",
      version: s.version,
      what: "Reads new receipts on a schedule, judges each one once against a sliding window with deterministic expectations, stores every flag beside the receipts, and pushes only the flags to a Deadlatch project or a local file.",
      stream: s.stream,
      sink: s.sink,
      keyPrefix: s.keyPrefix,
      dashboard: s.keyPrefix ? `${cfg.deadlatch.url}/app` : null,
      flagsFile: s.sink === "file" ? cfg.flagsFile : null,
      cursor: s.cursor,
      window: s.window,
      windowCount: s.windowCount,
      intervalMs: s.intervalMs,
      ticks: s.ticks,
      lastTickAt: s.lastTickAt,
      lastTickOk: s.lastTickOk,
      lastPushAt: s.lastPushAt,
      lastPushOk: s.lastPushOk,
      queued: s.queued,
      flags: s.flags,
      routes: {
        "GET /flags?since=<n>": "flags this monitor stored, oldest first, at most one thousand",
        "GET /events?since=<n>": "skipped, push-failed, push-rejected, dropped, heartbeat-failed, error",
        "GET /healthz": "liveness",
        "GET /readyz": "200 only when the last tick succeeded within three intervals and the last push succeeded or had nothing to push",
      },
    };
  };
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://monitor");
      if (req.method !== "GET") return send(res, 404, { error: "not found" });
      switch (url.pathname) {
        case "/": return send(res, 200, index());
        case "/healthz": return send(res, 200, { ok: true });
        case "/readyz": { const r = app.ready(); return send(res, r.ok ? 200 : 503, r); }
        case "/flags": {
          const since = sinceParam(url.searchParams.get("since"));
          if (since === null) return send(res, 400, { error: "since must be a non-negative integer" });
          return send(res, 200, { stream: cfg.stream, flags: await app.flags(Math.max(0, since)) });
        }
        case "/events": {
          const since = sinceParam(url.searchParams.get("since"));
          if (since === null) return send(res, 400, { error: "since must be a non-negative integer" });
          return send(res, 200, { stream: cfg.stream, events: await app.events(Math.max(0, since)) });
        }
        default: return send(res, 404, { error: "not found" });
      }
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: (e as Error).message });
    }
  });
}
