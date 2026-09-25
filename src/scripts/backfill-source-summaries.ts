/**
 * Completa lo que les falta a las notas que ya existían: el resumen de cada
 * fuente y, si no tienen foto, la de alguna fuente citada. Idempotente.
 *
 *   pnpm backfill:sources
 */
import "dotenv/config";
import mongoose from "mongoose";
import { dbConnect } from "../config/mongo";
import { Article } from "../models/article.model";
import { Signal } from "../models/signal.model";
import { enrichSources, imageFromSources } from "../services/article.service";
import { isGenericImage } from "../services/rss.service";

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

    const plain = article.sources.map((s: any) => ({
      name: s.name,
      url: s.url,
      summary: s.summary ?? "",
    }));
    const enriched = await enrichSources(plain, known);
    const gained = enriched.filter((s, i) => s.summary && !plain[i].summary).length;
    filled += gained;
    article.set("sources", enriched);
    await article.save();
    console.log(`  ${gained}/${enriched.length}  ${article.title}`);
  }

  console.log(`Listo: ${filled} fuentes con resumen nuevo.`);

  // Notas sin foto, o con el logo del medio como foto: se busca la de alguna fuente citada.
  const candidates = await Article.find({ status: { $in: ["published", "pending"] } });
  const noImage = candidates.filter((a: any) => !a.image?.url || isGenericImage(a.image.url));
  for (const article of noImage) {
    const image = await imageFromSources(article.sources as any);
    // Sin foto real en ninguna fuente: mejor la portada de marca que un logo ajeno.
    if (image || article.image) {
      article.set("image", image);
      await article.save();
    }
    console.log(
      `  foto ${image ? "✓ " + image.credit : "✗ ninguna fuente tiene"}  ${article.title}`,
    );
  }
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
