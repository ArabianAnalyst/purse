import { loadMonitorConfig, MonitorConfigError } from "./monitor-config.js";
import { createMonitorApp } from "./monitor-app.js";
import { createMonitorServer } from "./monitor-server.js";
import { listen } from "./agent-server.js";
import { startOtel } from "./otel.js";

try {
  const cfg = loadMonitorConfig();
  const stopOtel = cfg.otel ? startOtel("purse-monitor") : null;
  const app = await createMonitorApp(cfg);
  const server = await listen(createMonitorServer(app, cfg), cfg.port, cfg.bind);
  const s0 = app.state();
  const where = s0.sink === "deadlatch" ? `${cfg.deadlatch.url} (key ${s0.keyPrefix}…)` : cfg.flagsFile;
  console.log(`purse-monitor up. ${server.url} (flags, events, readyz) | stream ${cfg.stream} | window ${cfg.window.count} receipts or ${cfg.window.ms} ms | every ${cfg.intervalMs} ms | flags to ${where}`);
  const run = async () => {
    await app.tick();
    const s = app.state();
    if (!s.lastTickOk) console.error(`purse-monitor: tick failed, ${s.lastError}`);
    else if (!s.lastPushOk) console.error(`purse-monitor: push failed, ${s.queued} flags held, ${s.lastError}`);
  };
  await run();
  const timer = setInterval(() => { void run(); }, cfg.intervalMs);
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`purse-monitor: ${signal}, stopping`);
    clearInterval(timer);
    try {
      await server.close();
      await app.close();
      if (stopOtel) await stopOtel();
      process.exit(0);
    } catch (e) {
      console.error(`purse-monitor: shutdown error: ${(e as Error).message}`);
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
} catch (e) {
  console.error(e instanceof MonitorConfigError ? e.message : `purse-monitor failed to start: ${(e as Error).message}`);
  process.exit(1);
}
