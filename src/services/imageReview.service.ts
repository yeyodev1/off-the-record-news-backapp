import { env } from "../config/env";
import { Article, ArticleImage, IMAGE_EDITORIAL, ImageEditorial } from "../models/article.model";
import { truncate } from "../utils/text";
import { callJson } from "./anthropic.service";
import * as agentConfig from "./agentConfig.service";

/**
 * Valoración de la foto (Andersson, 13/10: "una foto de la Asamblea, salvo que
 * sea noticiosa, no hace sentido"). La IA mira la imagen junto al titular y la
 * clasifica en un lenguaje visual. La genérica no se muestra: la nota cae a la
 * ficha tipográfica o a sus cifras. La IA nunca genera ni altera la imagen.
 */

const REVIEW_SYSTEM = `Eres editor de fotografía de Off the Record, medio de noticias de Ecuador. Valoras si la imagen que trae el medio aporta información a la nota. No describes de más ni opinas sobre las personas.`;

const reviewSchema = {
  type: "object",
  properties: {
    tipo: { type: "string", enum: [...IMAGE_EDITORIAL] },
    descripcion: { type: "string" },
  },
  required: ["tipo", "descripcion"],
  additionalProperties: false,
};

interface Reviewable {
  title: string;
  lede: string;
  image: ArticleImage | null;
}

export async function review(
  article: Reviewable,
): Promise<{ editorial: ImageEditorial; caption: string } | null> {
  if (!article.image?.url) return null;
  const [documental, archivo, grafico, generica] = await Promise.all(
    ["documental", "archivo", "grafico", "generica"].map((k) => agentConfig.bullets("fotos", k)),
  );
  const prompt = `Titular: ${article.title}
Entrada: ${truncate(article.lede, 400)}

Clasifica la imagen adjunta:
- documental:
${documental}
- archivo:
${archivo}
- grafico:
${grafico}
- generica:
${generica}

descripcion: una oración factual de lo que se ve, sin nombres que no estén escritos en la imagen o en el titular.`;
  const result = await callJson<{ tipo: ImageEditorial; descripcion: string }>({
    model: env.AI_SCORING_MODEL,
    system: REVIEW_SYSTEM,
    area: "fotos",
    prompt,
    schema: reviewSchema,
    maxTokens: 400,
    imageUrl: article.image.url,
  });
  if (!IMAGE_EDITORIAL.includes(result.tipo)) return null;
  return { editorial: result.tipo, caption: truncate(result.descripcion.trim(), 220) };
}

/** Nunca lanza: si la IA no puede abrir la foto (hotlink), queda sin revisar y se ve como antes. */
export async function reviewDoc(doc: any): Promise<boolean> {
  try {
    const result = await review(doc);
    if (!result) return false;
    doc.image.editorial = result.editorial;
    doc.image.caption = result.caption;
    doc.markModified("image");
    return true;
  } catch (error) {
    console.warn(`[foto] "${doc.title}": ${(error as Error).message}`);
    return false;
  }
}

/** Para el cron: fotos de notas recientes sin revisar. */
export async function backfill(limit = 6, deadline = Date.now() + 60_000): Promise<number> {
  const since = new Date(Date.now() - 4 * 24 * 3600_000);
  const docs = await Article.find({
    status: "published",
    publishedAt: { $gte: since },
    "image.url": { $exists: true },
    "image.editorial": null,
    "image.reviewFailedAt": null,
  })
    .sort({ publishedAt: -1 })
    .limit(limit);
  let done = 0;
  for (const doc of docs) {
    if (Date.now() > deadline) break;
    if (await reviewDoc(doc)) done++;
    else {
      // Una foto que la IA no puede abrir no se reintenta en cada ciclo.
      await Article.updateOne({ _id: doc._id }, { "image.reviewFailedAt": new Date() });
      continue;
    }
    await doc.save();
  }
  return done;
}
