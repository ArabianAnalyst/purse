// mcp.ts
// Exposes Purse as an MCP server so any MCP-capable agent can authorize a spend
// before it executes one. Register this server, and make the rule simple in your
// agent's system prompt: "call authorize_spend before any payment tool; if the
// result is not 'allowed', do not pay."
//
// Requires the optional deps:  npm i @modelcontextprotocol/sdk zod
// Run:  npm run mcp   (configure policy via the PURSE_* env vars below)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Purse } from "./policy";
import { format } from "./money";

// Policy from environment so the server is config-only, no code edit required.
const purse = new Purse({
  currency: process.env.PURSE_CURRENCY ?? "USD",
  maxPerAction: process.env.PURSE_MAX_PER_ACTION,
  maxPerDay: process.env.PURSE_MAX_PER_DAY,
  requireApprovalOver: process.env.PURSE_REQUIRE_APPROVAL_OVER,
  allow: process.env.PURSE_ALLOW?.split(",").map((s) => s.trim()).filter(Boolean),
  deny: process.env.PURSE_DENY?.split(",").map((s) => s.trim()).filter(Boolean),
  auditFile: process.env.PURSE_AUDIT_FILE ?? "./purse-audit.jsonl",
});

const server = new McpServer({ name: "purse", version: "0.1.0" });

server.tool(
  "authorize_spend",
  "Authorize a payment BEFORE executing it. Returns allowed | denied | needs_approval. " +
    "If the status is not 'allowed', do not make the payment.",
  {
    amount: z.string().describe('Amount to spend, e.g. "$5.00" or "12.50 USD".'),
    payee: z.string().describe("Who is being paid, e.g. a domain or vendor id."),
    intent: z.string().optional().describe("Why the agent wants to spend this."),
    category: z.string().optional().describe("Spend category, if your policy uses categories."),
  },
  async ({ amount, payee, intent, category }) => {
    const d = purse.authorize({ amount, payee, intent, category });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              status: d.status,
              reason: d.reason,
              amount: format(d.request.amount),
              payee: d.request.payee,
              recordId: d.recordId,
              approvalId: d.approvalId,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
