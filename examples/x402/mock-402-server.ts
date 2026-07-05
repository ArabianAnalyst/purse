// mock-402-server.ts — a deterministic local stand-in for an x402 resource server.
// Unpaid GET -> 402 + PaymentRequirements. GET carrying an X-PAYMENT header -> 200 + a
// settlement ref. No chain, no wallet, no funds. Loopback only.
import { createServer } from "node:http";

export interface Mock402Options {
  amount: string;    // atomic units (USD-cents in the mock), as a string
  asset?: string;    // default "USD-cents"
  network?: string;  // default "mock"
  payTo?: string;    // default "mock-vendor"
}

export async function startMock402(opts: Mock402Options): Promise<{ url: string; close(): Promise<void> }> {
  let counter = 0;
  const server = createServer((req, res) => {
    const paid = typeof req.headers["x-payment"] === "string" && req.headers["x-payment"].length > 0;
    if (!paid) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({
        x402Version: 1,
        accepts: [{
          scheme: "exact",
          network: opts.network ?? "mock",
          maxAmountRequired: opts.amount,
          payTo: opts.payTo ?? "mock-vendor",
          asset: opts.asset ?? "USD-cents",
          resource: req.url ?? "/",
        }],
      }));
      return;
    }
    counter += 1;
    const ref = `mock_tx_${counter}`;
    res.writeHead(200, { "content-type": "application/json", "x-payment-response": JSON.stringify({ ref }) });
    res.end(JSON.stringify({ ok: true, ref }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
