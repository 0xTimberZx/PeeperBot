// Minimal migration runner -- runs .sql files in migrations/ in filename
// order. Applied migrations are recorded in schema_migrations and skipped on
// later runs -- this bookkeeping arrived with the second migration file,
// exactly when the original "no tracking table yet" note here said it should
// (re-running 001_init.sql unconditionally stopped being safe).

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, withTransaction, closePool } from "./client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "migrations");

async function main() {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log("No migration files found in", migrationsDir);
    return;
  }

  const pool = getPool();
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
  const appliedRows = await pool.query<{ filename: string }>(`SELECT filename FROM schema_migrations`);
  const applied = new Set(appliedRows.rows.map((r) => r.filename));

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`Skipping (already applied): ${file}`);
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    console.log(`Running migration: ${file}`);
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [file]);
    });
    ran++;
  }
  console.log(`Done. Ran ${ran} of ${files.length} migration file(s).`);
}

main()
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
