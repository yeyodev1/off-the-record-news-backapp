/**
 * Completa el resumen de cada fuente en las notas que ya existían antes de que
 * se guardara. Idempotente: las fuentes que ya tienen resumen no se tocan.
 *
 *   pnpm backfill:sources
 */
import "dotenv/config";
import mongoose from "mongoose";
import { dbConnect } from "../config/mongo";
import { Article } from "../models/article.model";
import { Signal } from "../models/signal.model";
import { enrichSources } from "../services/article.service";

async function main() {
  await dbConnect();
  const articles = await Article.find({
    status: { $in: ["published", "pending"] },
    sources: { $elemMatch: { $or: [{ summary: { $exists: false } }, { summary: "" }] } },
  });
  console.log(`Notas con fuentes sin resumen: ${articles.length}`);

  let filled = 0;
  for (const article of articles) {
    const urls = article.sources.map((s: any) => s.url).filter(Boolean);
    const signals = await Signal.find({ url: { $in: urls } }).select("url summary");
    const known = Object.fromEntries(signals.map((s: any) => [s.url, s.summary ?? ""]));

    const plain = article.sources.map((s: any) => ({ name: s.name, url: s.url, summary: s.summary ?? "" }));
    const enriched = await enrichSources(plain, known);
    const gained = enriched.filter((s, i) => s.summary && !plain[i].summary).length;
    filled += gained;
    article.set("sources", enriched);
    await article.save();
    console.log(`  ${gained}/${enriched.length}  ${article.title}`);
  }

  console.log(`Listo: ${filled} fuentes con resumen nuevo.`);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
