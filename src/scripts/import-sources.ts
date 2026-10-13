/**
 * Importa un CSV de fuentes con el mismo formato del Google Sheet.
 * Uso: pnpm sources:import docs/fuentes-otr.csv
 * Sirve para la carga inicial; después manda el Sheet (cron /api/cron/sources).
 */
import "dotenv/config";
import { readFileSync } from "fs";
import mongoose from "mongoose";
import { env } from "../config/env";
import { syncFromCsv } from "../services/sourceSheet.service";

async function main() {
  const file = process.argv[2] ?? "docs/fuentes-otr.csv";
  await mongoose.connect(env.DB_URI);
  const result = await syncFromCsv(readFileSync(file, "utf8"));
  console.log(
    `✔ ${result.rows} filas: ${result.created} nuevas, ${result.updated} actualizadas, ${result.deactivated} apagadas.`,
  );
  for (const error of result.errors) console.log(`  ✖ ${error}`);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error("✖ Falló la importación de fuentes:", error);
  process.exit(1);
});
