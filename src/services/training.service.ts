import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";
import { Article, COVERED_SECTIONS, SECTION_NAMES } from "../models/article.model";
import { PipelineRun } from "../models/pipelineRun.model";
import { Signal } from "../models/signal.model";
import { Source } from "../models/source.model";
import { Story } from "../models/story.model";
import { truncate } from "../utils/text";
import * as anthropicService from "./anthropic.service";
import * as gatewayService from "./gateway.service";
import * as jevService from "./jev.service";
import * as lessonService from "./lesson.service";
import * as newsroomService from "./newsroom.service";
import * as perplexityService from "./perplexity.service";

/**
 * "La mesa por dentro": lo que hizo cada agente en las últimas horas, contado
 * para un editor. Nada de esto sale al público.
 */

const MAX_HOURS = 72;
const SIGNALS_SHOWN = 80;
const RUNS_SHOWN = 12;

const STORY_TEXT: Record<string, string> = {
  ready: "Hecho listo: se redacta en el próximo ciclo",
  watchlist: "En observación: le falta puntaje o una segunda fuente",
  covered: "Ya tiene nota",
  archived: "Archivado: no llegó al puntaje",
  blocked: "Bloqueado: toca a la familia de una autoridad, decide un editor",
  discarded: "Descartado",
};

function sectionName(section: string | null): string {
  return section ? ((SECTION_NAMES as Record<string, string>)[section] ?? section) : "sin sección";
}

/** El porqué de cada señal en una frase. */
function decisionFor(signal: any, story: any, article: any): string {
  if (signal.status === "new") return "Entró en este ciclo, espera valoración";
  if (signal.status === "duplicate") return "Repetida: ya había entrado por otro enlace o titular";
  if (article)
    return `Entró a nota (${article.status === "published" ? "publicada" : "por aprobar"})`;
  const score = signal.score;
  if (signal.status === "discarded") {
    if (!score) return "Descartada a mano";
    if (/La Mesa indicó que esto no se cubre/.test(score.reasoning ?? ""))
      return "Descartada por una instrucción de la Mesa";
    if (score.inmediatez < newsroomService.MIN_INMEDIATEZ)
      return "Descartada: el hecho no es reciente";
    if (signal.section && !COVERED_SECTIONS.includes(signal.section))
      return `Descartada: es de ${sectionName(signal.section)}, OTR no cubre esa sección`;
    return "Descartada: no es un hecho noticioso para OTR";
  }
  if (story) {
    const base = STORY_TEXT[story.status] ?? story.status;
    return story.reason ? `${base}. ${story.reason}` : base;
  }
  if (score) return `Valorada con ${score.total}; espera agruparse en un hecho`;
  return "Valorada";
}

function aiHealth(runs: any[]) {
  const recent = runs
    .slice(0, 3)
    .flatMap((r) => r.errors ?? [])
    .join(" ");
  if (/402|credit balance|insufficient/i.test(recent))
    return {
      ok: false,
      message: "Sin saldo en el AI Gateway de Vercel: la mesa no puede valorar ni redactar.",
    };
  if (/Valoración:|AI Gateway respondió/.test(recent))
    return { ok: false, message: "La IA está fallando en los últimos ciclos. Revisa los errores." };
  if (!anthropicService.isAiConfigured())
    return { ok: false, message: "La IA no está configurada." };
  return { ok: true, message: "La IA responde: valora, redacta y encuadra." };
}

function searchHealth(runs: any[]) {
  if (!perplexityService.isPerplexityConfigured())
    return { ok: false, message: "Búsqueda web sin configurar: solo se leen los RSS." };
  const recent = runs
    .slice(0, 3)
    .flatMap((r) => r.errors ?? [])
    .filter((e: string) => e.startsWith("Búsqueda"))
    .join(" ");
  if (/quota|401|402|credits/i.test(recent))
    return {
      ok: false,
      message:
        "Perplexity sin cuota: las fuentes sin RSS (cuentas, personas, ministerios) no se están buscando.",
    };
  if (recent)
    return { ok: false, message: "Algunas búsquedas web fallaron en los últimos ciclos." };
  return { ok: true, message: "La búsqueda web revisa las fuentes sin RSS." };
}

export async function live(query: { hours?: unknown }) {
  const hours = Math.min(MAX_HOURS, Math.max(1, Number(query.hours) || 12));
  const since = new Date(Date.now() - hours * 3600_000);
  const day = new Date(Date.now() - 24 * 3600_000);

  const [runs, signals, sourceStats, withErrors, collected, discarded, scored, drafted, published] =
    await Promise.all([
      PipelineRun.find().sort({ startedAt: -1 }).limit(RUNS_SHOWN).lean(),
      Signal.find({ createdAt: { $gte: since } })
        .sort({ createdAt: -1 })
        .limit(SIGNALS_SHOWN)
        .select("title url sourceName createdAt status section score storyId articleId")
        .lean(),
      Source.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            active: { $sum: { $cond: ["$isActive", 1, 0] } },
            rss: { $sum: { $cond: [{ $and: ["$isActive", { $eq: ["$kind", "rss"] }] }, 1, 0] } },
            search: {
              $sum: { $cond: [{ $and: ["$isActive", { $eq: ["$kind", "perplexity"] }] }, 1, 0] },
            },
            checked24h: { $sum: { $cond: [{ $gte: ["$lastCheckedAt", day] }, 1, 0] } },
          },
        },
      ]),
      Source.find({ isActive: true, lastError: { $ne: "" } })
        .sort({ lastCheckedAt: -1 })
        .limit(10)
        .select("name lastError")
        .lean(),
      Signal.countDocuments({ createdAt: { $gte: since } }),
      Signal.countDocuments({ createdAt: { $gte: since }, status: "discarded" }),
      Signal.countDocuments({ createdAt: { $gte: since }, status: { $in: ["scored", "drafted"] } }),
      Article.countDocuments({ createdAt: { $gte: since }, origin: "ai" }),
      Article.countDocuments({ publishedAt: { $gte: since }, status: "published" }),
    ]);

  const storyIds = [
    ...new Set(
      signals
        .map((s: any) => s.storyId)
        .filter(Boolean)
        .map(String),
    ),
  ];
  const stories = await Story.find({ _id: { $in: storyIds } })
    .select("title status reason articleId")
    .lean();
  const storyById = new Map(stories.map((s: any) => [String(s._id), s]));
  const articleIds = [
    ...signals.map((s: any) => s.articleId),
    ...stories.map((s: any) => s.articleId),
  ]
    .filter(Boolean)
    .map(String);
  const articles = await Article.find({ _id: { $in: articleIds } })
    .select("slug title status")
    .lean();
  const articleById = new Map(articles.map((a: any) => [String(a._id), a]));

  const stats = sourceStats[0] ?? { total: 0, active: 0, rss: 0, search: 0, checked24h: 0 };
  const lastRun = runs[0] ?? null;

  return {
    health: {
      ai: aiHealth(runs),
      search: searchHealth(runs),
      lastRunAt: lastRun?.startedAt ?? null,
      withinSchedule: newsroomService.isWithinSchedule(),
    },
    sources: {
      total: stats.total,
      active: stats.active,
      rss: stats.rss,
      search: stats.search,
      checked24h: stats.checked24h,
      withErrors: withErrors.map((s: any) => ({ name: s.name, lastError: s.lastError })),
    },
    runs: runs.map((r: any) => ({
      id: String(r._id),
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      trigger: r.trigger,
      signalsFound: r.signalsFound,
      signalsNew: r.signalsNew,
      scored: r.scored,
      drafted: r.drafted,
      clustered: r.clustered,
      updates: r.updates,
      skippedReason: r.skippedReason,
      errors: (r.errors ?? []).slice(0, 20),
    })),
    funnel: { collected, discarded, scored, stories: storyIds.length, drafted, published },
    signals: signals.map((s: any) => {
      const story = s.storyId ? storyById.get(String(s.storyId)) : null;
      const articleId = s.articleId ?? story?.articleId ?? null;
      const article = articleId ? articleById.get(String(articleId)) : null;
      return {
        id: String(s._id),
        title: s.title,
        url: s.url,
        sourceName: s.sourceName,
        createdAt: s.createdAt,
        status: s.status,
        section: s.section,
        score: s.score ? { total: s.score.total, reasoning: s.score.reasoning ?? "" } : null,
        decision: decisionFor(s, story, article),
        story: story
          ? {
              id: String(story._id),
              title: story.title,
              status: story.status,
              reason: story.reason,
            }
          : null,
        article: article
          ? {
              id: String(article._id),
              slug: article.slug,
              title: article.title,
              status: article.status,
            }
          : null,
      };
    }),
  };
}

/** Valora un titular como lo haría el ciclo, con las instrucciones vigentes. No guarda nada. */
export async function tryHeadline(body: any) {
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (title.length < 8) throw new CustomError("Escribe un titular para probar", 400);
  const signal = {
    ref: "prueba",
    title: truncate(title, 300),
    summary: truncate(String(body?.summary ?? ""), 1200),
    sourceName: truncate(String(body?.sourceName || "Prueba de la Mesa"), 80),
    publishedAt: new Date(),
  };
  const headlines = await newsroomService.recentHeadlines();
  const result = gatewayService.isGatewayConfigured()
    ? await jevService.scoreOne(signal, headlines)
    : (await anthropicService.scoreSignals([signal], headlines))[0];
  if (!result) throw new CustomError("La IA no devolvió una valoración", 502);

  const wouldDraft =
    !result.notNews &&
    !result.duplicate &&
    !result.familyVeto &&
    COVERED_SECTIONS.includes(result.section) &&
    result.score.inmediatez >= newsroomService.MIN_INMEDIATEZ &&
    result.score.total >= env.PUBLISH_THRESHOLD;

  return {
    score: result.score,
    section: result.section,
    notNews: !!result.notNews,
    duplicate: result.duplicate,
    accusation: !!result.accusation,
    familyVeto: !!result.familyVeto,
    wouldDraft,
    threshold: env.PUBLISH_THRESHOLD,
    lessonsUsed: (await lessonService.linesFor("valoracion")).length,
  };
}
