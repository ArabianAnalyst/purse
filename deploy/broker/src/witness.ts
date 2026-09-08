import { P256Signer } from "@olurabian/receipt/anchor";
import { loadWitnessConfig, WitnessConfigError } from "./witness-config.js";
import { createWitness } from "./witness-app.js";
import { createWitnessServer } from "./witness-server.js";
import { listen } from "./agent-server.js";
import { startOtel } from "./otel.js";

if (process.argv[2] === "keygen") {
  const s = P256Signer.generate();
  process.stdout.write(s.toPem());
  process.stderr.write(`purse-witness: public key ${s.publicKeyDer()}\n`);
  process.exit(0);
}

try {
  const cfg = loadWitnessConfig();
  const stopOtel = cfg.otel ? startOtel("purse-witness") : null;
  const witness = await createWitness(cfg);
  const server = await listen(createWitnessServer(witness, cfg), cfg.port, cfg.bind);
  console.log(`purse-witness up. ${server.url} (anchors, verify, events) | stream ${cfg.stream} | log ${cfg.rekor.url} | every ${cfg.intervalMs} ms | public key ${witness.publicKey}`);
  const run = async () => {
    await witness.tick();
    const s = witness.state();
    if (!s.lastTickOk) console.error(`purse-witness: tick failed, ${s.lastError}`);
    else if (s.lag === 0 && s.head) console.log(`purse-witness: head seq ${s.head.seq} anchored at log index ${s.lastAnchor?.logIndex}`);
  };
  await run();
  const timer = setInterval(() => { void run(); }, cfg.intervalMs);
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`purse-witness: ${signal}, stopping`);
    clearInterval(timer);
    try {
      await server.close();
      await witness.close();
      if (stopOtel) await stopOtel();
      process.exit(0);
    } catch (e) {
      console.error(`purse-witness: shutdown error: ${(e as Error).message}`);
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
} catch (e) {
  console.error(e instanceof WitnessConfigError ? e.message : `purse-witness failed to start: ${(e as Error).message}`);
  process.exit(1);
}
