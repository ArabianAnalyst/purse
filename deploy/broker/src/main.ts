import { loadConfig, ConfigError } from "./config.js";
import { createApp } from "./app.js";

try {
  const cfg = loadConfig();
  const app = await createApp(cfg);
  const { agentUrl, adminUrl } = await app.start();
  console.log(`purse-broker up. agent ${agentUrl} (request, execute, status, mcp) | admin ${adminUrl} (token) | store ${cfg.store.kind} | executor ${cfg.executor.kind}${app.signerAddress ? ` | signer ${app.signerAddress}` : ""}`);
  const shutdown = async (signal: string) => {
    console.log(`purse-broker: ${signal}, flushing and stopping`);
    await app.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
} catch (e) {
  console.error(e instanceof ConfigError ? e.message : `purse-broker failed to start: ${(e as Error).message}`);
  process.exit(1);
}
