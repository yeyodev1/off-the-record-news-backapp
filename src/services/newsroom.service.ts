import { Types } from "mongoose";
import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";
import { Article, ArticleImage, ArticleSource } from "../models/article.model";
import { PipelineRun } from "../models/pipelineRun.model";
import { Signal } from "../models/signal.model";
import { Source } from "../models/source.model";
import { Story } from "../models/story.model";
import { paginate } from "../utils/paginate";
import {
  errorMessage,
  mapLimit,
  normalizeTitle,
  normalizeUrl,
  sha1,
  titleSimilarity,
} from "../utils/text";
import * as anthropicService from "./anthropic.service";
import * as gatewayService from "./gateway.service";
import * as jevService from "./jev.service";
import * as articleService from "./article.service";
import * as perplexityService from "./perplexity.service";
import * as rssService from "./rss.service";
import * as storyService from "./story.service";
import * as telegramService from "./telegram.service";
import * as verifierService from "./verifier.service";

/**
 * El editor general. Cada ciclo: recoge señales de las fuentes, descarta lo
 * repetido, valora en lote, agrupa las señales en hechos, redacta los hechos
 * que pasan el umbral y propone actualizaciones a las notas ya publicadas.
 * Todo cabe en ~250 s porque Vercel corta a los 300: cada fase revisa el reloj
 * antes de empezar.
 */

const CYCLE_BUDGET_MS = 240_000;
// Redactar una nota (investigación + Sonnet) tarda hasta ~100 s; sin ese margen no se empieza.
const DRAFT_MIN_REMAINING_MS = 100_000;
const FETCH_CONCURRENCY = 6;
// Perplexity limita peticiones por minuto; con 2 en paralelo y reintento no se dispara el 429.
const PERPLEXITY_CONCURRENCY = 2;
// La recolección no puede comerse el tiempo de valorar y redactar.
const COLLECT_BUDGET_MS = 90_000;
const RSS_ITEMS_PER_FEED = 15;
const MAX_ITEM_AGE_MS = 48 * 3600_000;
// Inmediatez 5 = "ayer" en la escala 0–10: lo más viejo que se redacta.
const MIN_INMEDIATEZ = 5;
const SCORE_BATCH_SIZE = 20;
const MAX_TO_SCORE = 80;
const MAX_TO_CLUSTER = 80;
const CLUSTER_BUDGET_MS = 45_000;
// Un bloque de actualización es una llamada corta; sin este margen se deja para el próximo ciclo.
const UPDATE_MIN_REMAINING_MS = 40_000;
// Piezas por hecho que ve el redactor: las mejor valoradas.
const MAX_SIGNALS_PER_DRAFT = 6;
const SIMILAR_TITLE = 0.45;

interface Collected {
  sourceId: Types.ObjectId;
  sourceName: string;
  title: string;
  url: string;
  summary: string;
  imageUrl: string;
  publishedAt: Date | null;
  weight: number;
}

export function ecuadorHour(date = new Date()): number {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Guayaquil",
    hour: "numeric",
    hourCycle: "h23",
  }).format(date);
  return Number(hour);
}

export function isWithinSchedule(date = new Date()): boolean {
  const hour = ecuadorHour(date);
  return hour >= env.NEWSROOM_START_HOUR && hour < env.NEWSROOM_END_HOUR;
}

async function collectFromSource(
  source: any,
  errors: string[],
  phaseDeadline: number,
): Promise<Collected[]> {
  if (Date.now() > phaseDeadline) {
    errors.push(`Fuente "${source.name}": sin tiempo en este ciclo`);
    return [];
  }
  const base = { sourceId: source._id, weight: source.weight ?? 1 };
  try {
    let items: Collected[] = [];
    if (source.kind === "rss") {
      const feed = await rssService.fetchFeed(source.url, RSS_ITEMS_PER_FEED);
      items = feed.map((i) => ({ ...base, ...i, sourceName: source.name }));
    } else if (source.kind === "perplexity") {
      const { items: found, error } = await perplexityService.discover(source.query || source.name);
      if (error) throw new Error(error);
      items = found.map((i) => ({
        ...base,
        ...i,
        imageUrl: "",
        sourceName: i.sourceName || source.name,
      }));
    }
    await Source.updateOne({ _id: source._id }, { lastCheckedAt: new Date(), lastError: "" });
    return items.filter(isRecent);
  } catch (error) {
    const message = errorMessage(error).slice(0, 300);
    errors.push(`Fuente "${source.name}": ${message}`);
    await Source.updateOne({ _id: source._id }, { lastCheckedAt: new Date(), lastError: message });
    return [];
  }
}

/**
 * Descarta notas viejas: por la fecha de publicación y, como la búsqueda a veces
 * trae notas de hace años con fecha de hoy, por el año que traiga la URL.
 */
function isRecent(item: { url: string; publishedAt: Date | null }): boolean {
  if (item.publishedAt && item.publishedAt.getTime() < Date.now() - MAX_ITEM_AGE_MS) return false;
  const years = item.url.match(/(?<!\d)20\d{2}(?!\d)/g) ?? [];
  const currentYear = new Date().getFullYear();
  // Enero todavía publica notas fechadas en diciembre.
  return !years.some((y) => Number(y) < currentYear - (new Date().getMonth() === 0 ? 1 : 0));
}

/** Guarda solo las señales que no existen (por URL normalizada o por título). */
async function saveNewSignals(items: Collected[]) {
  const seen = new Set<string>();
  const unique = items
    .map((item) => ({
      ...item,
      hash: sha1(normalizeUrl(item.url)),
      titleHash: sha1(normalizeTitle(item.title)),
    }))
    .filter((item) => {
      if (seen.has(item.hash) || seen.has(item.titleHash)) return false;
      seen.add(item.hash);
      seen.add(item.titleHash);
      return true;
    });
  if (!unique.length) return [];

  const existing = await Signal.find({
    $or: [
      { hash: { $in: unique.map((u) => u.hash) } },
      { titleHash: { $in: unique.map((u) => u.titleHash) } },
    ],
  }).select("hash titleHash");
  const known = new Set(existing.flatMap((e: any) => [e.hash, e.titleHash]));
  const fresh = unique.filter((u) => !known.has(u.hash) && !known.has(u.titleHash));
  if (!fresh.length) return [];

  try {
    return await Signal.insertMany(
      fresh.map(({ weight: _weight, ...rest }) => ({ ...rest, status: "new" })),
      { ordered: false },
    );
  } catch (error: any) {
    // Una carrera con otro ciclo puede chocar con el índice único; lo insertado igual vale.
    return (error?.insertedDocs as any[]) ?? [];
  }
}

async function recentHeadlines(): Promise<string[]> {
  const since = new Date(Date.now() - 3 * 24 * 3600_000);
  const docs = await Article.find({
    status: { $in: ["published", "pending"] },
    createdAt: { $gte: since },
  })
    .sort({ createdAt: -1 })
    .limit(60)
    .select("title");
  return docs.map((d: any) => d.title);
}

/** Valora en lotes. Devuelve cuántas señales quedaron valoradas. */
async function scorePending(signals: any[], errors: string[]): Promise<number> {
  if (!signals.length) return 0;
  const headlines = await recentHeadlines();
  const batches: any[][] = [];
  for (let i = 0; i < signals.length; i += SCORE_BATCH_SIZE)
    batches.push(signals.slice(i, i + SCORE_BATCH_SIZE));

  const counts = await mapLimit(batches, 3, async (batch) => {
    try {
      // Jev decide cuando hay AI Gateway; si no, valora Claude.
      const scorer = gatewayService.isGatewayConfigured() ? jevService : anthropicService;
      const scores = await scorer.scoreSignals(
        batch.map((s) => ({
          ref: String(s._id),
          title: s.title,
          summary: s.summary,
          sourceName: s.sourceName,
          publishedAt: s.publishedAt,
        })),
        headlines,
      );
      await Promise.all(
        scores.map((r) =>
          Signal.updateOne(
            { _id: r.ref },
            {
              score: r.score,
              accusation: !!r.accusation,
              familyVeto: !!r.familyVeto,
              section: r.section,
              // Un hecho de días atrás no es noticia del día aunque la nota sea nueva.
              // Lo repetido no se descarta: el agrupador lo une a su hecho y puede
              // volverse una actualización.
              status: r.notNews || r.score.inmediatez < MIN_INMEDIATEZ ? "discarded" : "scored",
            },
          ),
        ),
      );
      return scores.length;
    } catch (error) {
      errors.push(`Valoración: ${errorMessage(error)}`);
      return 0;
    }
  });
  return counts.reduce((a, b) => a + b, 0);
}

/** Evita redactar dos notas del mismo hecho cuando el agrupador no los unió. */
const similar = (a: string, b: string) => titleSimilarity(a, b) >= SIMILAR_TITLE;

async function imageForSignal(
  signal: any,
  sources: ArticleSource[] = [],
): Promise<ArticleImage | null> {
  if (signal.imageUrl && !rssService.isGenericImage(signal.imageUrl)) {
    return photoCredit(signal.imageUrl, signal.sourceName, signal.url);
  }
  if (signal.url) {
    const url = await rssService.fetchOgImage(signal.url);
    if (url) return photoCredit(url, signal.sourceName, signal.url);
  }
  // El medio original no trae foto: se usa la de otra fuente citada, con su crédito.
  return articleService.imageFromSources(sources);
}

function photoCredit(url: string, sourceName: string, sourceUrl: string): ArticleImage {
  return { url, credit: `Foto: ${sourceName}`, sourceName, sourceUrl, kind: "photo" };
}

/**
 * Revisar-y-guardar va de a uno: la redacción corre en paralelo, pero si dos
 * notas del mismo hecho terminan a la vez, la segunda tiene que ver a la primera.
 */
let saveQueue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const next = saveQueue.then(task, task);
  saveQueue = next.catch(() => undefined);
  return next;
}

function toInput(signal: any): anthropicService.SignalInput {
  return {
    title: signal.title,
    summary: signal.summary,
    url: signal.url,
    sourceName: signal.sourceName,
    publishedAt: signal.publishedAt,
  };
}

/**
 * Investiga y redacta un hecho con todas sus piezas. Lanza si la IA falla. Con
 * `dedupe`, Jev compara el titular ya redactado con lo publicado y descarta la
 * nota si es el mismo hecho (el titular crudo de cada medio casi nunca coincide;
 * el redactado sí se parece).
 */
export async function draftStory(story: any, { dedupe = false } = {}) {
  const signals: any[] = await Signal.find({ storyId: story._id })
    .sort({ "score.total": -1, createdAt: 1 })
    .limit(MAX_SIGNALS_PER_DRAFT);
  if (!signals.length) throw new CustomError("El hecho no tiene señales", 409);
  const primary = signals[0];
  const inputs = signals.map(toInput);

  const research = await perplexityService.research(
    `${primary.title}. ${primary.summary}`.slice(0, 800),
  );
  const draft = await anthropicService.writeArticle(inputs, research);
  // El corpus es exactamente lo que vio el redactor: contra eso se verifica.
  const evidence = verifierService.buildEvidence(
    [anthropicService.signalsBlock(inputs), anthropicService.researchBlock(research)],
    [...signals.map((s) => s.url), ...(research?.citations ?? [])],
  );
  const image = await imageForSignal(primary, draft.sources);
  // Fuera de la fila: leer las páginas de las fuentes es lo lento. Si el medio
  // bloquea la lectura, su resumen del RSS sirve de respaldo.
  draft.sources = await articleService.enrichSources(
    draft.sources,
    Object.fromEntries(signals.map((s) => [s.url, s.summary ?? ""])),
  );
  return oneAtATime(async () => {
    if (dedupe && gatewayService.isGatewayConfigured()) {
      const headlines = await recentHeadlines();
      const same = await jevService.isSameStory(
        { title: draft.title, summary: draft.lede },
        headlines,
      );
      if (same) {
        await discardAsRepeated(story);
        return null;
      }
    }
    return saveDraft(story, signals, draft, image, evidence);
  });
}

async function discardAsRepeated(story: any) {
  story.status = "discarded";
  story.reason = "Repetido con una nota ya publicada";
  await story.save();
  await Signal.updateMany({ storyId: story._id, status: "scored" }, { status: "duplicate" });
}

async function saveDraft(
  story: any,
  signals: any[],
  draft: anthropicService.ArticleDraft,
  image: ArticleImage | null,
  evidence: ReturnType<typeof verifierService.buildEvidence>,
) {
  const primary = signals[0];
  const baseScore = story.bestScore?.toObject?.() ?? story.bestScore ?? primary.score ?? null;
  const article = await articleService.createFromDraft(draft, {
    origin: "ai",
    // Con AUTO_PUBLISH solo sale sola si el verificador no encontró errores.
    publishIfClean: env.AUTO_PUBLISH,
    score: baseScore ? { ...baseScore, total: story.score } : null,
    image,
    signalId: primary._id,
    storyId: story._id,
    evidence,
  });
  await Signal.updateMany(
    { _id: { $in: signals.map((s) => s._id) } },
    { status: "drafted", articleId: article._id },
  );
  if (!primary.imageUrl && image) await Signal.updateOne({ _id: primary._id }, { imageUrl: image.url });
  story.articleId = article._id;
  story.status = "covered";
  story.reason = article.status === "published" ? "Publicada" : "Nota por aprobar";
  await story.save();
  if (article.status === "pending") await telegramService.notifyArticle(article);
  return article;
}

/**
 * Lo nuevo sobre una nota publicada se vuelve un bloque "Actualización HH:MM"
 * en la misma URL. Una por nota y por ciclo, y nunca dos pendientes a la vez:
 * la Mesa revisa una antes de que llegue la siguiente.
 */
async function proposeUpdates(
  attachments: storyService.Attachment[],
  errors: string[],
  deadline: number,
): Promise<number> {
  const latestByArticle = new Map<string, storyService.Attachment>();
  for (const a of attachments) latestByArticle.set(String(a.story.articleId), a);

  let proposed = 0;
  for (const { signal, story } of latestByArticle.values()) {
    if (proposed >= env.MAX_UPDATES_PER_RUN) break;
    if (deadline - Date.now() < UPDATE_MIN_REMAINING_MS) {
      errors.push("Sin tiempo para proponer actualizaciones; quedan para el próximo ciclo");
      break;
    }
    const article: any = await Article.findById(story.articleId);
    if (!article || article.status !== "published") continue;
    if (article.updates.some((u: any) => u.status === "pending")) continue;
    const cited = new Set(article.sources.map((s: ArticleSource) => normalizeUrl(s.url || "")));
    if (signal.url && cited.has(normalizeUrl(signal.url))) continue;

    const known = {
      title: article.title,
      lede: article.lede,
      keyPoints: article.keyPoints,
      body: article.body,
      updates: article.updates
        .filter((u: any) => u.status !== "rejected")
        .map((u: any) => u.text),
    };
    try {
      if (gatewayService.isGatewayConfigured() && !(await jevService.bringsNewFacts(known, signal))) {
        signal.status = "duplicate";
        await signal.save();
        continue;
      }
      const input = toInput(signal);
      const { nuevo, texto } = await anthropicService.writeUpdate(known, input);
      if (!nuevo) {
        signal.status = "duplicate";
        await signal.save();
        continue;
      }
      const update = await articleService.addUpdate(article, {
        text: texto,
        sources: [{ name: signal.sourceName, url: signal.url, summary: signal.summary ?? "" }],
        evidence: verifierService.buildEvidence([anthropicService.signalsBlock([input])], [signal.url]),
        signalId: signal._id,
      });
      signal.status = "drafted";
      signal.articleId = article._id;
      await signal.save();
      if (update.status === "pending") await telegramService.notifyUpdate(article, update);
      proposed++;
    } catch (error) {
      errors.push(`Actualización de "${article.title}": ${errorMessage(error)}`);
    }
  }
  return proposed;
}

export async function runCycle({
  trigger,
  force = false,
}: {
  trigger: "cron" | "manual";
  force?: boolean;
}) {
  const startedAt = Date.now();
  const deadline = startedAt + CYCLE_BUDGET_MS;
  const run = await PipelineRun.create({ trigger, startedAt: new Date(startedAt) });
  const errors: string[] = [];

  const finish = async (skippedReason = "") => {
    run.errors = errors.slice(0, 50);
    run.skippedReason = skippedReason;
    run.finishedAt = new Date();
    await run.save();
    return run.toJSON();
  };

  if (!force && !isWithinSchedule()) {
    return finish(
      `fuera de horario (${env.NEWSROOM_START_HOUR}:00–${env.NEWSROOM_END_HOUR}:00 Ecuador)`,
    );
  }
  if (!anthropicService.isAiConfigured()) {
    return finish("IA sin configurar (falta AI Gateway, ANTHROPIC_API_KEY o PERPLEXITY_API_KEY)");
  }

  // 1. Recolección
  const sources = await Source.find({ isActive: true, kind: { $in: ["rss", "perplexity"] } });
  if (!sources.length) return finish("no hay fuentes activas");

  const collectDeadline = Date.now() + COLLECT_BUDGET_MS;
  const rssSources = sources.filter((s: any) => s.kind === "rss");
  const aiSources = sources.filter((s: any) => s.kind === "perplexity");
  const [fromRss, fromAi] = await Promise.all([
    mapLimit(rssSources, FETCH_CONCURRENCY, (s) => collectFromSource(s, errors, collectDeadline)),
    mapLimit(aiSources, PERPLEXITY_CONCURRENCY, (s) =>
      collectFromSource(s, errors, collectDeadline),
    ),
  ]);
  const collected = [...fromRss, ...fromAi].flat();
  run.signalsFound = collected.length;

  // 2. Deduplicación y guardado
  const inserted = await saveNewSignals(collected);
  run.signalsNew = inserted.length;
  await run.save();

  // 3. Valoración (incluye señales que quedaron sin valorar en ciclos anteriores)
  const toScore = await Signal.find({
    status: "new",
    createdAt: { $gte: new Date(Date.now() - MAX_ITEM_AGE_MS) },
  })
    .sort({ publishedAt: -1, createdAt: -1 })
    .limit(MAX_TO_SCORE);
  if (Date.now() < deadline - 30_000) {
    run.scored = await scorePending(toScore, errors);
    await run.save();
  } else {
    errors.push("Sin tiempo para valorar en este ciclo");
  }

  // 4. Agrupación en hechos
  await storyService.ensureStoriesForRecentArticles();
  const toCluster = await Signal.find({
    status: "scored",
    storyId: null,
    createdAt: { $gte: new Date(Date.now() - MAX_ITEM_AGE_MS) },
  })
    .sort({ "score.total": -1 })
    .limit(MAX_TO_CLUSTER);
  const { clustered, attachments } = await storyService.clusterSignals(toCluster, {
    deadline: Math.min(Date.now() + CLUSTER_BUDGET_MS, deadline - DRAFT_MIN_REMAINING_MS),
    errors,
  });
  run.clustered = clustered;
  await run.save();

  // 5. Redacción de los hechos listos
  const weights = new Map(sources.map((s: any) => [s.name, s.weight ?? 1]));
  const weightOf = (story: any) =>
    Math.max(1, ...story.sourceNames.map((n: string) => weights.get(n) ?? 1));
  const candidates = await Story.find({
    status: "ready",
    articleId: null,
    lastSignalAt: { $gte: new Date(Date.now() - 24 * 3600_000) },
  })
    .sort({ score: -1 })
    .limit(30);

  const headlines = await recentHeadlines();
  const picked: any[] = [];
  const ranked = candidates.sort((a: any, b: any) => b.score * weightOf(b) - a.score * weightOf(a));
  for (const story of ranked) {
    if (picked.length >= env.MAX_DRAFTS_PER_RUN) break;
    const others = [...headlines, ...picked.map((p) => p.title)];
    let clash = others.some((t) => similar(t, story.title));
    if (!clash && gatewayService.isGatewayConfigured()) {
      clash = await jevService.isSameStory(story, others).catch((error) => {
        errors.push(`Jev (repetidas): ${errorMessage(error)}`);
        return false;
      });
    }
    if (clash) {
      await discardAsRepeated(story);
      continue;
    }
    picked.push(story);
  }

  const results = await mapLimit(picked, 3, async (story) => {
    if (deadline - Date.now() < DRAFT_MIN_REMAINING_MS) {
      errors.push(`Sin tiempo para redactar "${story.title}"; queda para el próximo ciclo`);
      return false;
    }
    try {
      const article = await draftStory(story, { dedupe: true });
      if (!article) errors.push(`Descartada por repetida tras redactar: "${story.title}"`);
      return Boolean(article);
    } catch (error) {
      errors.push(`Redacción "${story.title}": ${errorMessage(error)}`);
      return false;
    }
  });
  run.drafted = results.filter(Boolean).length;

  // 6. Actualizaciones de notas publicadas
  run.updates = await proposeUpdates(attachments, errors, deadline);

  return finish();
}

// ——— Admin

export async function listRuns(query: { page?: unknown; limit?: unknown }) {
  return paginate(
    PipelineRun,
    {},
    { page: query.page, limit: query.limit, sort: { startedAt: -1 } },
  );
}

export async function lastRun() {
  const run = await PipelineRun.findOne().sort({ startedAt: -1 });
  return run ? run.toJSON() : null;
}

/** Redacción a pedido desde el panel: la señal se redacta con todo su hecho. */
export async function draftSignalById(id: string) {
  if (!Types.ObjectId.isValid(id)) throw new CustomError("Señal no encontrada", 404);
  const signal: any = await Signal.findById(id);
  if (!signal) throw new CustomError("Señal no encontrada", 404);
  if (signal.articleId) {
    const existing = await Article.findById(signal.articleId);
    if (existing) throw new CustomError("Esta señal ya tiene una nota redactada", 409);
  }
  if (!signal.storyId) {
    await storyService.clusterSignals([signal], { deadline: Date.now() + 60_000, errors: [] });
  }
  return draftStoryById(String(signal.storyId));
}

export async function draftStoryById(id: string) {
  if (!Types.ObjectId.isValid(id)) throw new CustomError("Hecho no encontrado", 404);
  const story: any = await Story.findById(id);
  if (!story) throw new CustomError("Hecho no encontrado", 404);
  if (story.articleId && (await Article.exists({ _id: story.articleId }))) {
    throw new CustomError("Este hecho ya tiene una nota redactada", 409);
  }
  const article = await draftStory(story);
  if (!article) throw new CustomError("El hecho ya estaba cubierto por otra nota", 409);
  return article.toJSON();
}
