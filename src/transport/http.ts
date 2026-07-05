// http.ts — loopback HTTP transport. Binds 127.0.0.1 only. Same narrow interface as the
// IPC transport; this is the seam a hosted broker (Purse Cloud) grows from. Zero deps (node:http).
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import type { Broker, RequestResult, ExecuteResult, StatusResult } from "./../broker";
import type { AuthorizeRequest } from "./../types";

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

export async function serveHttp(broker: Broker, opts: { host?: string; port?: number } = {}): Promise<{ url: string; close(): Promise<void> }> {
  const host = opts.host ?? "127.0.0.1";
  const server = createServer(async (req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    try {
      const params = await readJson(req);
      switch (`${req.method} ${req.url}`) {
        case "POST /request": return send(200, broker.request(params as AuthorizeRequest));
        case "POST /execute": return send(200, await broker.execute((params as { grantId: string }).grantId));
        case "POST /status": return send(200, broker.status((params as { pendingId: string }).pendingId));
        default: return send(404, { error: "not found" });
      }
    } catch (e) { send(400, { error: (e as Error).message }); }
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  return {
    url: `http://${host}:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function post(url: string, path: string, body: unknown): Promise<{ ok: boolean; result?: unknown }> {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const u = new URL(path, url);
    const req = httpRequest({ hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => { try { resolve({ ok: (res.statusCode ?? 500) < 400, result: out ? JSON.parse(out) : undefined }); } catch { resolve({ ok: false }); } });
    });
    req.on("error", () => resolve({ ok: false }));
    req.write(data);
    req.end();
  });
}

export class HttpPurseClient {
  constructor(private baseUrl: string) {}
  async request(spend: AuthorizeRequest): Promise<RequestResult> {
    const r = await post(this.baseUrl, "/request", spend);
    if (!r.ok) return { decision: "denied", reason: "denied: broker unavailable", explain: { rule: "eval-error", policyVersion: "", evaluated: { amount: { amount: 0, currency: "USD" }, payee: String(spend.payee) } } };
    return r.result as RequestResult;
  }
  async execute(grantId: string): Promise<ExecuteResult> {
    const r = await post(this.baseUrl, "/execute", { grantId });
    if (!r.ok) return { status: "rejected", reason: "rejected: broker unavailable" };
    return r.result as ExecuteResult;
  }
  async status(pendingId: string): Promise<StatusResult> {
    const r = await post(this.baseUrl, "/status", { pendingId });
    if (!r.ok) return { state: "unknown" };
    return r.result as StatusResult;
  }
}
