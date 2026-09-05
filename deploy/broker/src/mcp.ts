import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Broker } from "@olurabian/purse";

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

export function createMcpServer(broker: Broker): McpServer {
  const server = new McpServer({ name: "purse-broker", version: "0.1.0" });
  server.registerTool(
    "request_spend",
    {
      description: "Ask Purse to authorize a spend. Returns the decision and, when allowed, a single-use grantId. Call this before any payment.",
      inputSchema: { amount: z.string().describe('e.g. "$12.50"'), payee: z.string(), intent: z.string().optional(), category: z.string().optional() },
    },
    async (args) => text(broker.request(args)),
  );
  server.registerTool(
    "execute_spend",
    { description: "Redeem an allowed grant. The broker performs the payment and returns the outcome and a scrubbed receipt.", inputSchema: { grantId: z.string() } },
    async ({ grantId }) => text(await broker.execute(grantId)),
  );
  server.registerTool(
    "spend_status",
    { description: "Check whether a spend that needed approval has been approved or denied by the principal.", inputSchema: { pendingId: z.string() } },
    async ({ pendingId }) => text(broker.status(pendingId)),
  );
  return server;
}

/** Stateless streamable HTTP: one server and transport per request, closed with the response. */
export async function handleMcp(broker: Broker, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  const server = createMcpServer(broker);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
