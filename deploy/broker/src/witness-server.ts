import { createServer, type Server } from "node:http";
import { send } from "./http.js";
import { VERSION } from "./version.js";
import type { Witness } from "./witness-app.js";
import type { WitnessConfig } from "./witness-config.js";

/** Read-only, no token. Nothing here is secret, and nothing here can change anything. */
export function createWitnessServer(w: Witness, cfg: WitnessConfig): Server {
  const index = () => {
    const s = w.state();
    return {
      service: "purse-witness",
      version: VERSION,
      what: "Anchors the head of a receipt stream to a public transparency log on a schedule, with its own key, and serves the anchors so anyone can verify the chain without trusting the writer.",
      stream: s.stream,
      witness: { alg: "ecdsa-p256", publicKey: s.publicKey },
      log: s.log,
      intervalMs: s.intervalMs,
      routes: {
        "GET /anchors?since=<seq>": "the anchors for this stream, oldest first",
        "GET /verify": "verifyAnchored over the live chain and anchors, with the pinned log key and this witness's key",
        "GET /events?since=<n>": "anchored, anchor-failed, anchor-conflict, chain-broken",
        "GET /healthz": "liveness",
        "GET /readyz": "200 only when the last tick verified within the lag window and the head is anchored",
      },
      verifyWith: `npx receipt-verify <chain.jsonl> --anchors <this url> --log-key ${cfg.rekor.logKey.origin}=<base64 DER from Sigstore's trust root> --witness-key ${s.publicKey} --stream ${s.stream}`,
    };
  };
  const nonNegative = (v: string | null): number | null => {
    if (v == null || v === "") return -1;
    const n = Number(v);
    return Number.isInteger(n) && n >= -1 ? n : null;
  };
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://witness");
      if (req.method !== "GET") return send(res, 404, { error: "not found" });
      switch (url.pathname) {
        case "/": return send(res, 200, index());
        case "/healthz": return send(res, 200, { ok: true });
        case "/readyz": { const r = w.ready(); return send(res, r.ok ? 200 : 503, r); }
        case "/anchors": {
          const since = nonNegative(url.searchParams.get("since"));
          if (since === null) return send(res, 400, { error: "since must be a non-negative integer seq" });
          return send(res, 200, { stream: cfg.stream, anchors: await w.anchors(since) });
        }
        case "/events": {
          const since = nonNegative(url.searchParams.get("since"));
          if (since === null) return send(res, 400, { error: "since must be a non-negative integer" });
          return send(res, 200, { stream: cfg.stream, events: await w.events(Math.max(0, since)) });
        }
        case "/verify": return send(res, 200, await w.verify());
        default: return send(res, 404, { error: "not found" });
      }
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: (e as Error).message });
    }
  });
}
