import { isValidObjectId, Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import {
  ArticleSource,
  Article,
  ArticleImage,
  ArticleOrigin,
  ArticleStatus,
  ARTICLE_STATUSES,
  IArticle,
  ScoreBreakdown,
  Section,
  SECTIONS,
} from "../models/article.model";
import { escapeRegex, paginate } from "../utils/paginate";
import { slugify } from "../utils/slugify";
import * as anthropicService from "./anthropic.service";
import { ArticleDraft } from "./anthropic.service";
import * as cloudinaryService from "./cloudinary.service";
import * as rssService from "./rss.service";
import { mapLimit, stripHtml, truncate } from "../utils/text";

type ArticleJSON = Record<string, unknown> & { id: string };

/** Tarjeta pública: sin body, score ni status. */
export function toCard(doc: any): ArticleJSON {
  const json = doc.toJSON();
  delete json.body;
  delete json.score;
  delete json.status;
  return json;
}

function assertId(id: string) {
  if (!isValidObjectId(id)) throw new CustomError("Nota no encontrada", 404);
}

async function uniqueSlug(title: string, excludeId?: string): Promise<string> {
  const base = slugify(title).slice(0, 80).replace(/-+$/, "") || "nota";
  let slug = base;
  for (let i = 2; ; i++) {
    const clash = await Article.exists({ slug, ...(excludeId ? { _id: { $ne: excludeId } } : {}) });
    if (!clash) return slug;
    slug = `${base}-${i}`;
  }
}

// Campos que el admin puede escribir directo. El resto (views, score, slug…) lo maneja el sistema.
const EDITABLE = [
  "title",
  "lede",
  "whyItMatters",
  "keyPoints",
  "body",
  "bigPicture",
  "whatsNext",
  "section",
  "tags",
  "image",
  "infographic",
  "sources",
  "author",
  "isPro",
  "isBreaking",
] as const;

function pickEditable(body: Record<string, unknown>): Partial<IArticle> {
  const out: Record<string, unknown> = {};
  for (const key of EDITABLE) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  if (out.section !== undefined && !SECTIONS.includes(out.section as Section)) {
    throw new CustomError("Sección inválida", 400);
  }
  for (const key of ["keyPoints", "body", "tags"] as const) {
    if (out[key] !== undefined && !Array.isArray(out[key])) {
      throw new CustomError(`El campo ${key} debe ser una lista`, 400);
    }
  }
  return out as Partial<IArticle>;
}

// ——— Público

export async function listPublished(query: {
  section?: string;
  tag?: string;
  page?: unknown;
  limit?: unknown;
}) {
  const filter: Record<string, unknown> = { status: "published" };
  if (query.section) filter.section = query.section;
  if (query.tag) filter.tags = String(query.tag).toLowerCase();
  return paginate(
    Article,
    filter,
    { page: query.page, limit: query.limit, sort: { publishedAt: -1 }, select: "-body -score" },
    toCard,
  );
}

export async function getTop() {
  const now = Date.now();
  const since24h = new Date(now - 24 * 3600_000);
  const since6h = new Date(now - 6 * 3600_000);
  const cardFields = "-body -score";

  const [leadByScore, breaking, latest] = await Promise.all([
    Article.findOne({ status: "published", publishedAt: { $gte: since24h } })
      .sort({ "score.total": -1, publishedAt: -1 })
      .select(cardFields),
    Article.find({ status: "published", isBreaking: true, publishedAt: { $gte: since6h } })
      .sort({ publishedAt: -1 })
      .limit(5)
      .select(cardFields),
    Article.find({ status: "published" }).sort({ publishedAt: -1 }).limit(12).select(cardFields),
  ]);

  const lead = leadByScore ?? latest[0] ?? null;

  const bySection = (
    await Promise.all(
      SECTIONS.map(async (section) => ({
        section,
        items: (
          await Article.find({ status: "published", section })
            .sort({ publishedAt: -1 })
            .limit(4)
            .select(cardFields)
        ).map(toCard),
      })),
    )
  ).filter((group) => group.items.length > 0);

  return {
    lead: lead ? toCard(lead) : null,
    breaking: breaking.map(toCard),
    latest: latest.map(toCard),
    bySection,
  };
}

export async function getPublicBySlug(slug: string) {
  const doc = await Article.findOneAndUpdate(
    { slug, status: "published" },
    { $inc: { views: 1 } },
    { new: true },
  );
  if (!doc) throw new CustomError("Nota no encontrada", 404);
  const json = doc.toJSON();
  delete json.score;
  if (json.isPro) {
    json.body = [];
    json.locked = true;
  }
  return json;
}

// ——— Admin

export async function adminList(query: {
  status?: string;
  section?: string;
  q?: string;
  page?: unknown;
  limit?: unknown;
}) {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  if (query.section) filter.section = query.section;
  if (query.q) {
    const rx = new RegExp(escapeRegex(String(query.q)), "i");
    filter.$or = [{ title: rx }, { lede: rx }, { tags: rx }];
  }
  return paginate(Article, filter, {
    page: query.page,
    limit: query.limit,
    sort: { createdAt: -1 },
  });
}

export async function getDoc(id: string) {
  assertId(id);
  const doc = await Article.findById(id);
  if (!doc) throw new CustomError("Nota no encontrada", 404);
  return doc;
}

export async function getById(id: string) {
  return (await getDoc(id)).toJSON();
}

const SOURCE_SUMMARY_MAX = 240;

/**
 * Completa `summary` de cada fuente con la descripción que el medio publica en
 * su nota, para que el lector sepa qué dice sin salir. Nunca lanza: una fuente
 * que bloquea la lectura simplemente queda sin resumen.
 */
export async function enrichSources(
  sources: ArticleSource[],
  known: Record<string, string> = {},
): Promise<ArticleSource[]> {
  return mapLimit(sources, 4, async (source) => {
    if (source.summary || !source.url) return source;
    const summary = (await rssService.fetchPageSummary(source.url)) || known[source.url] || "";
    return { ...source, summary: truncate(stripHtml(summary), SOURCE_SUMMARY_MAX) };
  });
}

/** Primera foto que encuentre entre las fuentes citadas, con el crédito de ese medio. */
export async function imageFromSources(sources: ArticleSource[]): Promise<ArticleImage | null> {
  for (const source of sources.slice(0, 5)) {
    if (!source.url) continue;
    const url = await rssService.fetchOgImage(source.url);
    if (url) {
      return {
        url,
        credit: `Foto: ${source.name}`,
        sourceName: source.name,
        sourceUrl: source.url,
        kind: "photo",
      };
    }
  }
  return null;
}

export async function createFromDraft(
  draft: ArticleDraft,
  opts: {
    origin: ArticleOrigin;
    status?: ArticleStatus;
    score?: ScoreBreakdown | null;
    image?: ArticleImage | null;
    signalId?: Types.ObjectId | string | null;
    author?: string;
  },
) {
  const status = opts.status ?? "pending";
  const doc = await Article.create({
    ...draft,
    sources: await enrichSources(draft.sources),
    slug: await uniqueSlug(draft.title),
    origin: opts.origin,
    status,
    score: opts.score ?? null,
    image: opts.image ?? null,
    signalId: opts.signalId ?? null,
    author: opts.author ?? "Mesa Off the Record",
    publishedAt: status === "published" ? new Date() : null,
  });
  return doc;
}

export async function createManual(body: Record<string, unknown>) {
  const data = pickEditable(body);
  if (!data.title || !String(data.title).trim()) {
    throw new CustomError("El titular es obligatorio", 400);
  }
  const status: ArticleStatus = body.status === "published" ? "published" : "pending";
  const doc = await Article.create({
    author: "Redacción Off the Record",
    ...data,
    slug: await uniqueSlug(String(data.title)),
    origin: "manual",
    status,
    publishedAt: status === "published" ? new Date() : null,
  });
  return doc.toJSON();
}

export async function update(id: string, body: Record<string, unknown>) {
  const doc = await getDoc(id);
  const data = pickEditable(body);
  if (data.title !== undefined && !String(data.title).trim()) {
    throw new CustomError("El titular no puede quedar vacío", 400);
  }
  doc.set(data);
  if (body.status !== undefined) {
    if (!ARTICLE_STATUSES.includes(body.status as ArticleStatus))
      throw new CustomError("Estado inválido", 400);
    if (body.status === "published" && !doc.publishedAt) doc.publishedAt = new Date();
    doc.status = body.status;
  }
  await doc.save();
  return doc.toJSON();
}

export async function publish(id: string) {
  const doc = await getDoc(id);
  doc.status = "published";
  doc.publishedAt = new Date();
  await doc.save();
  return doc.toJSON();
}

export async function reject(id: string) {
  const doc = await getDoc(id);
  doc.status = "rejected";
  await doc.save();
  return doc.toJSON();
}

export async function remove(id: string) {
  assertId(id);
  const result = await Article.findByIdAndDelete(id);
  if (!result) throw new CustomError("Nota no encontrada", 404);
  return { ok: true };
}

export async function rewrite(id: string, instructions: string) {
  if (!instructions?.trim())
    throw new CustomError("Escribe las instrucciones para la reescritura", 400);
  const doc = await getDoc(id);
  const draft = await anthropicService.rewriteArticle(doc.toObject(), instructions.trim());
  // La reescritura no toca imagen, estado ni slug: la URL pública no debe cambiar.
  doc.set({
    title: draft.title,
    lede: draft.lede,
    whyItMatters: draft.whyItMatters,
    keyPoints: draft.keyPoints,
    body: draft.body,
    bigPicture: draft.bigPicture,
    whatsNext: draft.whatsNext,
    section: draft.section,
    tags: draft.tags,
    infographic: draft.infographic,
    sources: draft.sources.length ? draft.sources : doc.sources,
  });
  await doc.save();
  return doc.toJSON();
}

export async function setImage(id: string, file: Express.Multer.File | undefined, credit = "") {
  if (!file) throw new CustomError("Adjunta una imagen en el campo 'image'", 400);
  if (!file.mimetype.startsWith("image/"))
    throw new CustomError("El archivo debe ser una imagen", 400);
  const doc = await getDoc(id);
  const { url } = await cloudinaryService.uploadBuffer(file.buffer, "off-the-record/articles");
  doc.image = {
    url,
    credit: credit.trim(),
    sourceName: "",
    sourceUrl: "",
    kind: "photo",
  };
  await doc.save();
  return doc.toJSON();
}

export async function fromText(text: string, sourceUrl = "") {
  if (!text || text.trim().length < 20) {
    throw new CustomError("El texto es muy corto para armar una nota (mínimo 20 caracteres)", 400);
  }
  const draft = await anthropicService.articleFromText(text.trim(), sourceUrl.trim());
  const doc = await createFromDraft(draft, { origin: "manual", status: "pending" });
  return doc.toJSON();
}
