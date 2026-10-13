import { isValidObjectId, Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import {
  ArticleSource,
  Article,
  ArticleImage,
  ArticleOrigin,
  ArticleStatus,
  ARTICLE_STATUSES,
  Evidence,
  IArticle,
  ScoreBreakdown,
  Section,
  SECTIONS,
  VerificationFlag,
} from "../models/article.model";
import { Story } from "../models/story.model";
import { env } from "../config/env";
import * as verifierService from "./verifier.service";
import { escapeRegex, pageParams, paginate } from "../utils/paginate";
import { slugify } from "../utils/slugify";
import * as anthropicService from "./anthropic.service";
import { ArticleDraft } from "./anthropic.service";
import * as cloudinaryService from "./cloudinary.service";
import * as rssService from "./rss.service";
import { mapLimit, normalizeUrl, stripHtml, truncate } from "../utils/text";
import {
  DECAY_PER_HOUR,
  isWeighted,
  oppositeOf,
  ReadingMode,
  Stance,
  STANCES,
} from "../config/modes";
import * as lensService from "./lens.service";
import * as framingService from "./framing.service";

type ArticleJSON = Record<string, unknown> & { id: string };

// Lo que nunca sale en el API público: datos de la mesa, no del lector.
const PRIVATE_FIELDS = [
  "score",
  "verification",
  "history",
  "storyId",
  "lens",
  "modeRelevance",
  "modeRelevanceAuto",
  "modeRelevanceEditedBy",
  "viewsByMode",
  "framing",
  "followUps",
] as const;
const CARD_SELECT = "-body -score -verification -history -updates -viewsByMode -followUps";

/** Tarjeta pública: sin body, score ni status, con el encuadre del modo del lector. */
export function toCard(doc: any, mode: ReadingMode | null = null): ArticleJSON {
  const json = framingService.applyFraming(doc.toJSON(), mode) as ArticleJSON;
  delete json.body;
  delete json.status;
  for (const key of PRIVATE_FIELDS) delete json[key];
  return json;
}

/**
 * Descargo de generación asistida. Lo arma el sistema, no la IA: así no hay
 * forma de que una nota salga sin él ni con el texto alterado.
 */
export function disclaimerFor(doc: {
  origin: ArticleOrigin;
  reviewedBy?: string;
  author?: string;
  history?: unknown[];
}): string {
  const reviewed = doc.reviewedBy?.trim();
  if (doc.origin === "ai") {
    const base =
      "Nota redactada con asistencia de inteligencia artificial a partir de las fuentes citadas.";
    if (reviewed) return `${base} La revisó ${reviewed} antes de publicarse.`;
    // Las notas anteriores al historial no registran quién las aprobó: no se afirma nada.
    if (!doc.history?.length) return base;
    return `${base} Se publicó sin revisión humana previa.`;
  }
  return `Información de ${doc.author || "la redacción de Off the Record"}. La inteligencia artificial ayudó solo con el formato${reviewed ? ` y la revisó ${reviewed}` : ""}.`;
}

function historyEntry(action: string, by: string, note = "") {
  return { action, by: by || "Sistema", at: new Date(), note };
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
  if (out.sources !== undefined) {
    if (!Array.isArray(out.sources))
      throw new CustomError("El campo sources debe ser una lista", 400);
    // Una postura desconocida queda "sin valorar" en vez de tumbar el guardado.
    out.sources = (out.sources as ArticleSource[]).map((source) => ({
      ...source,
      stance: STANCES.includes(source.stance as Stance) ? source.stance : "",
    }));
  }
  return out as Partial<IArticle>;
}

// ——— Público

/**
 * Orden por modo: la relevancia del modo menos lo que pierde por antigüedad.
 * Reordena lo reciente; lo viejo vuelve a quedar casi cronológico. Las notas
 * sin lente usan el valor general.
 */
function rankStages(mode: ReadingMode) {
  return [
    {
      $addFields: {
        _rank: {
          $subtract: [
            {
              $ifNull: [
                `$modeRelevance.${mode}`,
                { $multiply: [{ $ifNull: ["$score.total", 5] }, 10] },
              ],
            },
            {
              $multiply: [
                DECAY_PER_HOUR,
                { $divide: [{ $subtract: ["$$NOW", "$publishedAt"] }, 3_600_000] },
              ],
            },
          ],
        },
      },
    },
    { $sort: { _rank: -1 as const, publishedAt: -1 as const } },
  ];
}

const CARD_PROJECT = {
  body: 0,
  score: 0,
  verification: 0,
  history: 0,
  updates: 0,
  viewsByMode: 0,
  evidence: 0,
  followUps: 0,
  _rank: 0,
};

async function rankedCards(
  filter: Record<string, unknown>,
  mode: ReadingMode,
  opts: { skip?: number; limit: number; frameMode?: ReadingMode },
) {
  const docs = await Article.aggregate([
    { $match: filter },
    ...rankStages(mode),
    { $skip: opts.skip ?? 0 },
    { $limit: opts.limit },
    { $project: CARD_PROJECT },
  ]);
  return docs.map((raw) => toCard(Article.hydrate(raw), opts.frameMode ?? mode));
}

/**
 * Orden del stream de la portada: "principales" es el orden editorial del modo
 * (relevancia menos antigüedad, también en independiente), "leidas" lo más visto
 * de los últimos tres días y "ultimo" la cronología pura, igual para todos.
 */
export const STREAM_ORDERS = ["principales", "leidas", "ultimo"] as const;
export type StreamOrder = (typeof STREAM_ORDERS)[number];
const POPULAR_WINDOW_MS = 72 * 3600_000;

export async function listPublished(query: {
  section?: string;
  tag?: string;
  page?: unknown;
  limit?: unknown;
  mode?: ReadingMode | null;
  order?: string;
}) {
  const mode = query.mode ?? null;
  const filter: Record<string, unknown> = { status: "published" };
  if (query.section) filter.section = query.section;
  if (query.tag) filter.tags = String(query.tag).toLowerCase();
  const order = STREAM_ORDERS.includes(query.order as StreamOrder)
    ? (query.order as StreamOrder)
    : null;

  if (order === "principales" || (!order && isWeighted(mode))) {
    const { page, limit, skip } = pageParams(query.page, query.limit, 20);
    const [items, total] = await Promise.all([
      rankedCards(filter, mode ?? "independiente", { skip, limit }),
      Article.countDocuments(filter),
    ]);
    return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
  }
  if (order === "leidas") {
    filter.publishedAt = { $gte: new Date(Date.now() - POPULAR_WINDOW_MS) };
  }
  return paginate(
    Article,
    filter,
    {
      page: query.page,
      limit: query.limit,
      sort: order === "leidas" ? { views: -1, publishedAt: -1 } : { publishedAt: -1 },
      select: CARD_SELECT,
    },
    (doc: any) => toCard(doc, mode),
  );
}

export async function getTop(mode: ReadingMode | null = null) {
  const now = Date.now();
  const since24h = new Date(now - 24 * 3600_000);
  const since6h = new Date(now - 6 * 3600_000);
  const cardFields = CARD_SELECT;

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
  const card = (doc: any) => toCard(doc, mode);

  // "Las 5 cosas que tienes que saber": la historia del día va primera en todos
  // los modos (es la plaza pública); las otras cuatro salen del orden del modo.
  const rest = await rankedCards(
    {
      status: "published",
      publishedAt: { $gte: new Date(now - TOP_FIVE_WINDOW_MS) },
      ...(lead ? { _id: { $ne: lead._id } } : {}),
    },
    mode ?? "independiente",
    { limit: 4 },
  );

  return {
    modo: mode ?? "independiente",
    lead: lead ? card(lead) : null,
    topFive: [...(lead ? [card(lead)] : []), ...rest],
    breaking: breaking.map(card),
    latest: latest.map(card),
    ...(await modeBlocks(mode, lead?._id ?? null)),
  };
}

const TOP_FIVE_WINDOW_MS = 36 * 3600_000;

const MODE_WINDOW_MS = 48 * 3600_000;

/**
 * "Lo que tu orilla no está mirando". Nada se oculta: son notas que también
 * están en su sección. El encuadre es el del modo del lector, no el de la otra orilla.
 */
async function modeBlocks(mode: ReadingMode | null, leadId: unknown) {
  if (!isWeighted(mode)) return { otherSide: [] };
  const recent: Record<string, unknown> = {
    status: "published",
    publishedAt: { $gte: new Date(Date.now() - MODE_WINDOW_MS) },
    ...(leadId ? { _id: { $ne: leadId } } : {}),
  };

  // Alta en la orilla contraria y baja en la propia.
  const opposite = oppositeOf(mode);
  const otherSide = opposite
    ? await rankedCards(
        {
          ...recent,
          [`modeRelevance.${opposite}`]: { $gte: 70 },
          $expr: {
            $gte: [{ $subtract: [`$modeRelevance.${opposite}`, `$modeRelevance.${mode}`] }, 15],
          },
        },
        opposite,
        { limit: 4, frameMode: mode },
      )
    : [];

  return { otherSide };
}

export async function getPublicBySlug(slug: string, mode: ReadingMode | null = null) {
  // El modo solo suma a un contador agregado: no se guarda nada del lector.
  const inc: Record<string, number> = { views: 1 };
  if (mode) inc[`viewsByMode.${mode}`] = 1;
  const doc = await Article.findOneAndUpdate(
    { slug, status: { $in: ["published", "retracted"] } },
    { $inc: inc },
    { new: true },
  );
  if (!doc) throw new CustomError("Nota no encontrada", 404);
  // Una nota retirada conserva su URL con el aviso, sin el contenido.
  if (doc.status === "retracted") {
    return {
      id: String(doc._id),
      slug: doc.slug,
      title: doc.title,
      section: doc.section,
      status: doc.status,
      publishedAt: doc.publishedAt,
      retraction: { at: doc.retraction?.at ?? null, reason: doc.retraction?.reason ?? "" },
    };
  }
  const json = framingService.applyFraming(doc.toJSON(), mode);
  for (const key of PRIVATE_FIELDS) delete json[key];
  json.updates = (json.updates ?? [])
    .filter((u: any) => u.status === "published")
    .map((u: any) => ({ id: u.id, text: u.text, sources: u.sources, publishedAt: u.publishedAt }));
  json.disclaimer = disclaimerFor(doc);
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

export async function getDoc(id: string, { withEvidence = false } = {}) {
  assertId(id);
  const query = Article.findById(id);
  if (withEvidence) query.select("+evidence");
  const doc = await query;
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

/**
 * Crea la nota y la pasa por el verificador. Con `publishIfClean`, se publica
 * sola solo si no hay errores; si los hay, queda por aprobar con sus flags.
 */
export async function createFromDraft(
  draft: ArticleDraft,
  opts: {
    origin: ArticleOrigin;
    status?: ArticleStatus;
    publishIfClean?: boolean;
    score?: ScoreBreakdown | null;
    image?: ArticleImage | null;
    signalId?: Types.ObjectId | string | null;
    storyId?: Types.ObjectId | string | null;
    author?: string;
    evidence?: Evidence | null;
    /** Quién la crea, para el historial. */
    by?: string;
    /** Quién la revisó, si se publica en el acto (un editor que la manda por Telegram). */
    reviewedBy?: string;
  },
) {
  let sources = draft.sources;
  let urlFlags: VerificationFlag[] = [];
  if (opts.evidence) {
    ({ sources, flags: urlFlags } = verifierService.keepKnownUrls(sources, opts.evidence));
  }
  sources = await enrichSources(sources);
  const verification = verifierService.verifyArticle(
    { ...draft, sources },
    opts.evidence ?? null,
    urlFlags,
  );
  const status: ArticleStatus = opts.publishIfClean
    ? verification.errors === 0
      ? "published"
      : "pending"
    : (opts.status ?? "pending");

  const doc = new Article({
    ...draft,
    sources,
    slug: await uniqueSlug(draft.title),
    origin: opts.origin,
    status,
    score: opts.score ?? null,
    image: opts.image ?? null,
    signalId: opts.signalId ?? null,
    storyId: opts.storyId ?? null,
    author: opts.author ?? "Mesa Off the Record",
    evidence: opts.evidence ?? null,
    verification,
    reviewedBy: status === "published" ? (opts.reviewedBy ?? "") : "",
    history: [historyEntry("crear", opts.by ?? "Mesa automática", status)],
    publishedAt: status === "published" ? new Date() : null,
  });
  await lensService.assessDoc(doc);
  // Las que quedan por aprobar se encuadran al publicarse (cron), para no
  // gastar en notas que la Mesa puede rechazar.
  if (status === "published") await framingService.frameDoc(doc);
  await doc.save();
  return doc;
}

/** Vuelve a pasar la nota por el verificador con su corpus guardado. */
/** Vuelve a pasar la nota por el verificador. `doc` tiene que venir con `+evidence`. */
function reverify(doc: any) {
  doc.verification = verifierService.verifyArticle(doc, doc.evidence ?? null);
}

export async function createManual(body: Record<string, unknown>, by = "") {
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
    reviewedBy: status === "published" ? by : "",
    history: [historyEntry("crear", by, status)],
    publishedAt: status === "published" ? new Date() : null,
  });
  return doc.toJSON();
}

export async function update(id: string, body: Record<string, unknown>, by = "") {
  const doc = await getDoc(id, { withEvidence: true });
  const data = pickEditable(body);
  if (data.title !== undefined && !String(data.title).trim()) {
    throw new CustomError("El titular no puede quedar vacío", 400);
  }
  const reframe = ["title", "lede", "whyItMatters", "keyPoints", "body"].some(
    (k) => (data as Record<string, unknown>)[k] !== undefined,
  );
  doc.set(data);
  // El encuadre se armó con el texto anterior: el cron lo rehace con el nuevo.
  if (reframe) doc.framing = null;
  if (body.followUps !== undefined && Array.isArray(body.followUps)) {
    doc.followUps = (body.followUps as unknown[]).map(String).filter(Boolean).slice(0, 5);
  }
  if (body.modeRelevance !== undefined) lensService.setManualRelevance(doc, body.modeRelevance, by);
  if (body.status !== undefined) {
    if (!ARTICLE_STATUSES.includes(body.status as ArticleStatus))
      throw new CustomError("Estado inválido", 400);
    if (body.status === "published" && !doc.publishedAt) doc.publishedAt = new Date();
    if (body.status === "published" && doc.status !== "published") doc.reviewedBy = by;
    doc.status = body.status;
  }
  reverify(doc);
  doc.history.push(historyEntry("editar", by, Object.keys(data).join(", ")));
  await doc.save();
  return doc.toJSON();
}

export async function publish(id: string, by = "") {
  const doc = await getDoc(id);
  if (doc.status === "retracted") {
    throw new CustomError(
      "La nota fue retirada; edítala y vuelve a publicarla desde el editor",
      409,
    );
  }
  doc.status = "published";
  doc.publishedAt = doc.publishedAt ?? new Date();
  doc.reviewedBy = by;
  doc.history.push(historyEntry("publicar", by));
  await doc.save();
  return doc.toJSON();
}

export async function reject(id: string, by = "") {
  const doc = await getDoc(id);
  doc.status = "rejected";
  doc.history.push(historyEntry("rechazar", by));
  await doc.save();
  if (doc.storyId)
    await Story.updateOne({ _id: doc.storyId }, { reason: "Nota rechazada por la Mesa" });
  return doc.toJSON();
}

/**
 * Kill switch. Una nota publicada queda retirada con aviso público en su
 * misma URL; una que no salió todavía simplemente se rechaza.
 */
export async function retract(id: string, by = "", reason = "") {
  const doc = await getDoc(id);
  if (doc.status === "published") {
    doc.status = "retracted";
    doc.retraction = { at: new Date(), by, reason: reason.trim() };
    doc.history.push(historyEntry("retirar", by, reason));
  } else if (doc.status === "pending") {
    doc.status = "rejected";
    doc.history.push(historyEntry("matar", by, reason));
  } else {
    throw new CustomError("La nota no está publicada ni por aprobar", 409);
  }
  await doc.save();
  return doc.toJSON();
}

/** "Esperar más fuentes": la nota no sale y el hecho vuelve a la watchlist. */
export async function wait(id: string, by = "") {
  const doc = await getDoc(id);
  if (doc.status !== "pending")
    throw new CustomError("Solo se puede esperar una nota por aprobar", 409);
  doc.status = "rejected";
  doc.history.push(historyEntry("esperar", by));
  await doc.save();
  if (doc.storyId) {
    await Story.updateOne({ _id: doc.storyId }, [
      {
        $set: {
          articleId: null,
          status: "watchlist",
          holdUntilCount: "$signalCount",
          reason: "La Mesa pidió esperar más fuentes",
        },
      },
    ]);
  }
  return doc.toJSON();
}

// ——— Actualizaciones ("Actualización HH:MM" en la misma URL)

export async function addUpdate(
  doc: any,
  data: {
    text: string;
    sources: ArticleSource[];
    evidence: Evidence;
    signalId?: Types.ObjectId | null;
  },
) {
  const verification = verifierService.verifyText(data.text, data.evidence);
  const publishNow = env.AUTO_PUBLISH_UPDATES && verification.errors === 0;
  doc.updates.push({
    text: data.text,
    sources: data.sources,
    status: publishNow ? "published" : "pending",
    verification,
    evidence: data.evidence.text,
    signalId: data.signalId ?? null,
    createdAt: new Date(),
    publishedAt: publishNow ? new Date() : null,
  });
  const update = doc.updates[doc.updates.length - 1];
  if (publishNow) applyPublishedUpdate(doc, update);
  doc.history.push(
    historyEntry("proponer_actualizacion", "Mesa automática", truncate(data.text, 120)),
  );
  await doc.save();
  return update;
}

/** Al publicar una actualización, sus fuentes pasan a la lista de la nota. */
function applyPublishedUpdate(doc: any, update: any) {
  doc.lastUpdatedAt = update.publishedAt;
  const known = new Set(doc.sources.map((s: ArticleSource) => normalizeUrl(s.url || s.name)));
  for (const source of update.sources as ArticleSource[]) {
    if (!known.has(normalizeUrl(source.url || source.name))) doc.sources.push(source);
  }
}

function findUpdate(doc: any, updateId: string) {
  const update = doc.updates.id(updateId);
  if (!update) throw new CustomError("Actualización no encontrada", 404);
  return update;
}

export async function publishUpdate(id: string, updateId: string, by = "") {
  const doc = await getDoc(id);
  if (doc.status !== "published") throw new CustomError("La nota no está publicada", 409);
  const update = findUpdate(doc, updateId);
  update.status = "published";
  update.publishedAt = new Date();
  applyPublishedUpdate(doc, update);
  doc.history.push(historyEntry("publicar_actualizacion", by, truncate(update.text, 120)));
  await doc.save();
  return doc.toJSON();
}

export async function rejectUpdate(id: string, updateId: string, by = "") {
  const doc = await getDoc(id);
  const update = findUpdate(doc, updateId);
  update.status = "rejected";
  doc.history.push(historyEntry("rechazar_actualizacion", by, truncate(update.text, 120)));
  await doc.save();
  return doc.toJSON();
}

/** Para Telegram: acepta id, slug o la URL pública de la nota. */
export async function resolve(ref: string) {
  const clean = ref
    .trim()
    .replace(/^.*\/nota\//, "")
    .replace(/[?#].*$/, "");
  if (isValidObjectId(clean)) {
    const byId = await Article.findById(clean);
    if (byId) return byId;
  }
  const bySlug = await Article.findOne({ slug: clean });
  if (!bySlug) throw new CustomError(`No encontré la nota "${truncate(ref, 60)}"`, 404);
  return bySlug;
}

export async function remove(id: string) {
  assertId(id);
  const result = await Article.findByIdAndDelete(id);
  if (!result) throw new CustomError("Nota no encontrada", 404);
  return { ok: true };
}

export async function rewrite(id: string, instructions: string, by = "") {
  if (!instructions?.trim())
    throw new CustomError("Escribe las instrucciones para la reescritura", 400);
  const doc = await getDoc(id, { withEvidence: true });
  const draft = await anthropicService.rewriteArticle(doc.toObject(), instructions.trim());
  if (draft.sinHecho)
    throw new CustomError(
      "La reescritura quedó sin un hecho concreto; ajusta las instrucciones",
      422,
    );
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
    followUps: draft.followUps?.length ? draft.followUps : doc.followUps,
  });
  // La instrucción del editor es material humano: si trae una cifra nueva, vale como fuente.
  if (doc.evidence) {
    doc.evidence = {
      text: `${doc.evidence.text}\n\nInstrucción de la Mesa: ${instructions.trim()}`,
      urls: doc.evidence.urls,
    };
  }
  reverify(doc);
  await lensService.assessDoc(doc);
  doc.framing = null;
  if (doc.status === "published") await framingService.frameDoc(doc);
  doc.history.push(historyEntry("regenerar", by, instructions.trim()));
  await doc.save();
  return doc.toJSON();
}

/** La Mesa pide recalcular la lente (por ejemplo, después de editar a mano). */
export async function relens(id: string, by = "") {
  const doc = await getDoc(id);
  const ok = await lensService.assessDoc(doc);
  if (!ok) throw new CustomError("La IA no pudo leer el hecho; intenta en unos minutos", 502);
  doc.history.push(historyEntry("recalcular_lente", by));
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

export async function fromText(text: string, sourceUrl = "", by = "") {
  if (!text || text.trim().length < 20) {
    throw new CustomError("El texto es muy corto para armar una nota (mínimo 20 caracteres)", 400);
  }
  const draft = await anthropicService.articleFromText(text.trim(), sourceUrl.trim());
  if (draft.sinHecho) {
    throw new CustomError("El texto no trae un hecho concreto para armar una nota", 422);
  }
  const doc = await createFromDraft(draft, {
    origin: "manual",
    status: "pending",
    evidence: verifierService.buildEvidence([text.trim()], [sourceUrl.trim()]),
    by,
  });
  return doc.toJSON();
}
