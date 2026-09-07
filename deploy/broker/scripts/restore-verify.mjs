#!/usr/bin/env node
// Restore a receipts dump into an embedded Postgres and verify the chain.
//
//   node scripts/restore-verify.mjs <dump.sql> [stream] [table]
//
// The dump is plain pg_dump output taken with --inserts (see the README, "Backups and restore").
// Nothing here touches the live database. The proof is the same one /verify gives, run over the
// restored rows in a fresh database, so a backup that cannot pass this is not a backup.
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { verifyChain } from "@olurabian/receipt";

const [file, stream = "purse", table = "receipts"] = process.argv.slice(2);
if (!file) {
  console.error("usage: restore-verify <dump.sql> [stream] [table]");
  process.exit(2);
}
if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
  console.error(`table name "${table}" is not a plain identifier`);
  process.exit(2);
}

// Split the dump into statements. pg_dump ends every statement with ";" at the end of a line,
// and --inserts keeps each INSERT on one line, so a statement is the lines up to one ending in ";".
const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
const statements = [];
let buf = [];
for (const line of lines) {
  if (line.startsWith("\\")) continue; // psql meta-commands (\restrict, \unrestrict, \.)
  if (!line.trim() || line.startsWith("--")) continue;
  buf.push(line);
  if (line.trimEnd().endsWith(";")) { statements.push(buf.join("\n")); buf = []; }
}
if (buf.length) statements.push(buf.join("\n"));

// Session settings are skipped if the embedded engine does not know them. Anything else must run.
const skippable = /^(SET |SELECT pg_catalog\.set_config)/;
const db = new PGlite();
let ran = 0;
const skipped = [];
for (const stmt of statements) {
  if (skippable.test(stmt)) { skipped.push(stmt.split("\n")[0]); continue; }
  try { await db.exec(stmt); ran++; }
  catch (e) {
    console.error(`failed: ${stmt.slice(0, 160)}\n${e.message}`);
    process.exit(1);
  }
}

const { rows } = await db.query(`SELECT record FROM public.${table} WHERE stream = $1 ORDER BY seq`, [stream]);
const records = rows.map((r) => JSON.parse(r.record));
const verify = verifyChain(records);
const head = records.length ? records[records.length - 1].hash : null;
console.log(JSON.stringify({ file, stream, table, statementsRun: ran, settingsSkipped: skipped.length, records: records.length, head, verify }, null, 2));
await db.close();
process.exit(verify.ok && records.length > 0 ? 0 : 1);
