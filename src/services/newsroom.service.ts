import { Types } from "mongoose";
import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";
import { Article, ArticleImage } from "../models/article.model";
import { PipelineRun } from "../models/pipelineRun.model";
import { Signal } from "../models/signal.model";
import { Source } from "../models/source.model";
import { paginate } from "../utils/paginate";
import { errorMessage, mapLimit, normalizeTitle, normalizeUrl, sha1 } from "../utils/text";
import * as anthropicService from "./anthropic.service";
import * as gatewayService from "./gateway.service";
import * as jevService from "./jev.service";
import * as articleService from "./article.service";
import * as perplexityService from "./perplexity.service";
import * as rssService from "./rss.service";

/**
 * El editor general. Cada ciclo: recoge señales de las fuentes, descarta lo
 * repetido, valora en lote con Haiku, y lo que pasa el umbral lo investiga con
 * Perplexity y lo redacta con Sonnet. Todo cabe en ~250 s porque Vercel corta
 * a los 300: cada fase revisa el reloj antes de empezar.
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
const SCORE_BATCH_SIZE = 20;
const MAX_TO_SCORE = 80;

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
      const cutoff = Date.now() - MAX_ITEM_AGE_MS;
      items = feed
        .filter((i) => !i.publishedAt || i.publishedAt.getTime() >= cutoff)
        .map((i) => ({ ...base, ...i, sourceName: source.name }));
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
    return items;
  } catch (error) {
    const message = errorMessage(error).slice(0, 300);
    errors.push(`Fuente "${source.name}": ${message}`);
    await Source.updateOne({ _id: source._id }, { lastCheckedAt: new Date(), lastError: message });
    return [];
  }
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
              status: r.notNews ? "discarded" : r.duplicate ? "duplicate" : "scored",
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

function wordSet(title: string): Set<string> {
  return new Set(
    normalizeTitle(title)
      .split(" ")
      .filter((w) => w.length > 3),
  );
}

/** Parecido de titulares (Jaccard). Evita redactar dos notas del mismo hecho. */
function similar(a: string, b: string): boolean {
  const wa = wordSet(a);
  const wb = wordSet(b);
  if (!wa.size || !wb.size) return false;
  const inter = [...wa].filter((w) => wb.has(w)).length;
  return inter / (wa.size + wb.size - inter) >= 0.45;
}

async function imageForSignal(signal: any): Promise<ArticleImage | null> {
  let url = signal.imageUrl as string;
  if (!url && signal.url) url = await rssService.fetchOgImage(signal.url);
  if (!url) return null;
  return {
    url,
    credit: `Foto: ${signal.sourceName}`,
    sourceName: signal.sourceName,
    sourceUrl: signal.url,
    kind: "photo",
  };
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

/**
 * Investiga y redacta una señal. Lanza si la IA falla. Con `dedupe`, Jev compara
 * el titular ya redactado con lo publicado y descarta la nota si es el mismo hecho
 * (el titular crudo de cada medio casi nunca coincide; el redactado sí se parece).
 */
export async function draftSignal(signal: any, { dedupe = false } = {}) {
  const research = await perplexityService.research(
    `${signal.title}. ${signal.summary}`.slice(0, 800),
  );
  const draft = await anthropicService.writeArticle(
    {
      title: signal.title,
      summary: signal.summary,
      url: signal.url,
      sourceName: signal.sourceName,
      publishedAt: signal.publishedAt,
    },
    research,
  );
  const image = await imageForSignal(signal);
  // Fuera de la fila: leer las páginas de las fuentes es lo lento. Si el medio
  // original bloquea la lectura, su resumen del RSS sirve de respaldo.
  draft.sources = await articleService.enrichSources(draft.sources, {
    [signal.url]: signal.summary ?? "",
  });
  return oneAtATime(async () => {
    if (dedupe && gatewayService.isGatewayConfigured()) {
      const headlines = await recentHeadlines();
      const same = await jevService.isSameStory(
        { title: draft.title, summary: draft.lede },
        headlines,
      );
      if (same) {
        signal.status = "duplicate";
        await signal.save();
        return null;
      }
    }
    return saveDraft(signal, draft, image);
  });
}

async function saveDraft(signal: any, draft: any, image: ArticleImage | null) {
  const article = await articleService.createFromDraft(draft, {
    origin: "ai",
    status: env.AUTO_PUBLISH ? "published" : "pending",
    score: signal.score ?? null,
    image,
    signalId: signal._id,
  });
  signal.status = "drafted";
  signal.articleId = article._id;
  if (!signal.imageUrl && image) signal.imageUrl = image.url;
  await signal.save();
  return article;
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

  // 4. Redacción de las mejores
  const weights = new Map(sources.map((s: any) => [String(s._id), s.weight ?? 1]));
  const candidates = await Signal.find({
    status: "scored",
    "score.total": { $gte: env.PUBLISH_THRESHOLD },
    createdAt: { $gte: new Date(Date.now() - 24 * 3600_000) },
  })
    .sort({ "score.total": -1 })
    .limit(30);

  const headlines = await recentHeadlines();
  const picked: any[] = [];
  const ranked = candidates.sort(
    (a: any, b: any) =>
      b.score.total * (weights.get(String(b.sourceId)) ?? 1) -
      a.score.total * (weights.get(String(a.sourceId)) ?? 1),
  );
  for (const c of ranked) {
    if (picked.length >= env.MAX_DRAFTS_PER_RUN) break;
    const others = [...headlines, ...picked.map((p) => p.title)];
    let clash = others.some((t) => similar(t, c.title));
    if (!clash && gatewayService.isGatewayConfigured()) {
      clash = await jevService.isSameStory(c, others).catch((error) => {
        errors.push(`Jev (repetidas): ${errorMessage(error)}`);
        return false;
      });
    }
    if (clash) {
      c.status = "duplicate";
      await c.save();
      continue;
    }
    picked.push(c);
  }

  const results = await mapLimit(picked, 3, async (signal) => {
    if (deadline - Date.now() < DRAFT_MIN_REMAINING_MS) {
      errors.push(`Sin tiempo para redactar "${signal.title}"; queda para el próximo ciclo`);
      return false;
    }
    try {
      const article = await draftSignal(signal, { dedupe: true });
      if (!article) errors.push(`Descartada por repetida tras redactar: "${signal.title}"`);
      return Boolean(article);
    } catch (error) {
      errors.push(`Redacción "${signal.title}": ${errorMessage(error)}`);
      return false;
    }
  });
  run.drafted = results.filter(Boolean).length;

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

export async function draftSignalById(id: string) {
  if (!Types.ObjectId.isValid(id)) throw new CustomError("Señal no encontrada", 404);
  const signal = await Signal.findById(id);
  if (!signal) throw new CustomError("Señal no encontrada", 404);
  if (signal.articleId) {
    const existing = await Article.findById(signal.articleId);
    if (existing) throw new CustomError("Esta señal ya tiene una nota redactada", 409);
  }
  const article = await draftSignal(signal);
  return article.toJSON();
}
