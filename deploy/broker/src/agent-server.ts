import { createServer, type Server } from "node:http";
import type { Broker, AuthorizeRequest } from "@olurabian/purse";
import { readJson, send, errorStatus, publicError } from "./http.js";
import { VERSION } from "./version.js";
import { handleMcp } from "./mcp.js";

/** What a browser or a curious agent sees at the root. Read-only, no secrets, no principal methods. */
const INDEX = {
  service: "purse-broker",
  version: VERSION,
  what: "Purse enforcement mode. An agent asks for a spend, the broker decides against policy, pays, and writes a hash-chained receipt anyone can verify.",
  agent: {
    "POST /request": "{ amount, payee, intent?, category? } gives a decision with a grantId or a pendingId",
    "POST /execute": "{ grantId } redeems the grant, the broker pays and returns a scrubbed receipt",
    "POST /status": "{ pendingId } tells an agent whether a held spend was approved",
    "POST /mcp": "MCP over streamable HTTP with the tools request_spend, execute_spend, spend_status",
    "GET /healthz": "liveness",
  },
  admin: "on a separate port with a bearer token, not reachable from here",
  docs: "https://github.com/ArabianAnalyst/purse/tree/main/deploy/broker",
  image: "ghcr.io/arabiananalyst/purse-broker",
};

export interface Listening { server: Server; url: string; close(): Promise<void> }

export function createAgentServer(broker: Broker): Server {
  return createServer(async (req, res) => {
    try {
      const path = (req.url ?? "/").split("?")[0];
      if (req.method === "GET" && path === "/") return send(res, 200, INDEX);
      if (req.method === "GET" && path === "/healthz") return send(res, 200, { ok: true });
      if (path === "/mcp" && (req.method === "GET" || req.method === "DELETE")) {
        res.writeHead(405, { allow: "POST" });
        return res.end();
      }
      if (req.method !== "POST") return send(res, 404, { error: "not found" });
      const body = await readJson(req);
      switch (path) {
        case "/request": return send(res, 200, broker.request(body as AuthorizeRequest));
        case "/execute": return send(res, 200, await broker.execute(String((body as { grantId?: unknown }).grantId ?? "")));
        case "/status": return send(res, 200, broker.status(String((body as { pendingId?: unknown }).pendingId ?? "")));
        case "/mcp": return await handleMcp(broker, req, res, body);
        default: return send(res, 404, { error: "not found" });
      }
    } catch (e) {
      if (!res.headersSent) send(res, errorStatus(e), { error: publicError(e) });
    }
  });
}

export function listen(server: Server, port: number, host: string): Promise<Listening> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const a = server.address();
      const p = typeof a === "object" && a ? a.port : port;
      resolve({ server, url: `http://${host}:${p}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
