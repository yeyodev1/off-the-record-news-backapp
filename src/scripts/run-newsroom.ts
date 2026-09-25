/**
 * Corre un ciclo de la mesa de redacción ignorando el horario y muestra el resumen.
 * Uso: pnpm newsroom:run
 */
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env";
import { Article } from "../models/article.model";
import { Signal } from "../models/signal.model";
import { runCycle } from "../services/newsroom.service";

async function main() {
  console.log("Conectando a MongoDB...");
  await mongoose.connect(env.DB_URI);

  const started = Date.now();
  console.log(
    `Corriendo ciclo (umbral ${env.PUBLISH_THRESHOLD}, máx. ${env.MAX_DRAFTS_PER_RUN} notas, auto-publicar: ${env.AUTO_PUBLISH})...`,
  );
  const run: any = await runCycle({ trigger: "manual", force: true });
  const seconds = Math.round((Date.now() - started) / 1000);

  console.log(`\nCiclo terminado en ${seconds} s`);
  console.log(`  Señales encontradas: ${run.signalsFound}`);
  console.log(`  Señales nuevas:      ${run.signalsNew}`);
  console.log(`  Valoradas:           ${run.scored}`);
  console.log(`  Redactadas:          ${run.drafted}`);
  if (run.skippedReason) console.log(`  Omitido:             ${run.skippedReason}`);
  if (run.errors.length) {
    console.log(`  Errores (${run.errors.length}):`);
    for (const e of run.errors) console.log(`    - ${e}`);
  }

  const top = await Signal.find({
    "score.total": { $ne: null },
    updatedAt: { $gte: new Date(started) },
  })
    .sort({ "score.total": -1 })
    .limit(15);
  if (top.length) {
    console.log("\nMejores puntajes del ciclo:");
    for (const s of top as any[]) {
      console.log(
        `  ${s.score.total.toFixed(1)} [${s.status}] ${s.sourceName}: ${s.title.slice(0, 90)}`,
      );
    }
  }

  const drafted = await Article.find({ createdAt: { $gte: new Date(started) } }).select(
    "slug status title score",
  );
  if (drafted.length) {
    console.log("\nNotas creadas:");
    for (const a of drafted as any[])
      console.log(`  [${a.status}] ${a.slug} (${a.score?.total ?? "-"})`);
  }

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error("✖ Falló el ciclo:", error);
  process.exit(1);
});
