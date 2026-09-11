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
        "GET /chain?since=<seq>&limit=<n>&format=<json|jsonl>": "the receipts themselves, oldest first from a 0-based position, at most five hundred per call with next for the rest, jsonl is the file the verifier reads",
        "GET /anchors?since=<seq> or ?tail=<n>": "the anchors for this stream, oldest first, or the newest n",
        "GET /verify": "verifyAnchored over the live chain and anchors, with the pinned log key and this witness's key",
        "GET /events?since=<n>": "anchored, anchor-failed, anchor-conflict, chain-broken",
        "GET /healthz": "liveness",
        "GET /readyz": "200 only when the last tick verified within the lag window and the head is anchored",
      },
      verifyWith: `s=0; : > chain.jsonl; while :; do n=$(curl -s "<this url>/chain?format=jsonl&since=$s&limit=500" | tee -a chain.jsonl | wc -l); [ "$n" -lt 500 ] && break; s=$((s+500)); done; npx receipt-verify chain.jsonl --anchors <this url> --log-key ${cfg.rekor.logKey.origin}=<base64 DER from Sigstore's trust root> --witness-key ${s.publicKey} --stream ${s.stream}`,
    };
  };
  const nonNegative = (v: string | null): number | null => {
    if (v == null || v === "") return -1;
    const n = Number(v);
    return Number.isInteger(n) && n >= -1 && n <= Number.MAX_SAFE_INTEGER ? n : null;
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
          const tail = url.searchParams.get("tail");
          if (tail != null) {
            const n = Number(tail);
            if (!Number.isInteger(n) || n <= 0) return send(res, 400, { error: "tail must be a positive integer" });
            const allAnchors = await w.anchors(-1);
            const sliced = allAnchors.slice(Math.max(0, allAnchors.length - Math.min(n, 500)));
            return send(res, 200, { stream: cfg.stream, anchors: sliced });
          }
          const since = nonNegative(url.searchParams.get("since"));
          if (since === null) return send(res, 400, { error: "since must be a non-negative integer seq" });
          return send(res, 200, { stream: cfg.stream, anchors: await w.anchors(since) });
        }
        case "/events": {
          const since = nonNegative(url.searchParams.get("since"));
          if (since === null) return send(res, 400, { error: "since must be a non-negative integer" });
          return send(res, 200, { stream: cfg.stream, events: await w.events(Math.max(0, since)) });
        }
        case "/chain": {
          const since = nonNegative(url.searchParams.get("since"));
          if (since === null) return send(res, 400, { error: "since must be a non-negative integer seq" });
          const limitRaw = url.searchParams.get("limit");
          const limit = limitRaw == null || limitRaw === "" ? 100 : Number(limitRaw);
          if (!Number.isInteger(limit) || limit < 1) return send(res, 400, { error: "limit must be a positive integer" });
          const format = url.searchParams.get("format") || "json";
          if (format !== "json" && format !== "jsonl") return send(res, 400, { error: "format must be json or jsonl" });
          const c = await w.chain(Math.max(0, since), limit);
          if (format === "jsonl") {
            const text = c.records.map((r) => JSON.stringify(r) + "\n").join("");
            const headers: Record<string, string | number> = { "content-type": "application/x-ndjson", "content-length": Buffer.byteLength(text) };
            if (c.next !== null) headers["x-next-since"] = String(c.next);
            res.writeHead(200, headers);
            return res.end(text);
          }
          return send(res, 200, { stream: cfg.stream, total: c.total, head: c.head, since: c.since, count: c.records.length, next: c.next, records: c.records });
        }
        case "/verify": return send(res, 200, await w.verify());
        default: return send(res, 404, { error: "not found" });
      }
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: (e as Error).message });
    }
  });
}
