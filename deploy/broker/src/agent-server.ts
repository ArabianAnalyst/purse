import { createServer, type Server } from "node:http";
import type { Broker, AuthorizeRequest } from "@olurabian/purse";
import { readJson, send, errorStatus } from "./http.js";
import { handleMcp } from "./mcp.js";

export interface Listening { server: Server; url: string; close(): Promise<void> }

export function createAgentServer(broker: Broker): Server {
  return createServer(async (req, res) => {
    try {
      const path = (req.url ?? "/").split("?")[0];
      if (req.method === "GET" && path === "/healthz") return send(res, 200, { ok: true });
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
      if (!res.headersSent) send(res, errorStatus(e), { error: (e as Error).message });
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
