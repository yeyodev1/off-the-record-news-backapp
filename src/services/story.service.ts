import { isValidObjectId, Types } from "mongoose";
import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";
import { Article } from "../models/article.model";
import { Signal } from "../models/signal.model";
import { Source } from "../models/source.model";
import { Story, STORY_STATUSES, StoryStatus } from "../models/story.model";
import { paginate } from "../utils/paginate";
import { errorMessage, mapLimit, titleSimilarity } from "../utils/text";
import * as gatewayService from "./gateway.service";
import * as jevService from "./jev.service";

/**
 * Agrupador: convierte señales sueltas en hechos. Cada señal nueva se compara
 * con los hechos de las últimas 72 horas; si es el mismo acontecimiento se une,
 * si no abre uno nuevo. La mesa decide sobre el hecho: cuántos medios lo
 * cuentan pesa en el puntaje y en las reglas de acusación.
 */

export const STORY_WINDOW_MS = 72 * 3600_000;
// Con este parecido de titulares no hace falta preguntarle a Jev.
const LEXICAL_MATCH = 0.45;
const MAX_CANDIDATES = 40;
const TITLES_KEPT = 5;
const CLUSTER_CONCURRENCY = 6;

const round1 = (n: number) => Math.round(n * 10) / 10;

async function sourceCategories(): Promise<Map<string, string>> {
  const sources = await Source.find().select("category");
  return new Map(sources.map((s: any) => [String(s._id), s.category]));
}

function bestLexical(title: string, stories: any[]): { story: any; similarity: number } | null {
  let best: { story: any; similarity: number } | null = null;
  for (const story of stories) {
    const titles: string[] = story.titles?.length ? story.titles : [story.title];
    const similarity = Math.max(...titles.map((t) => titleSimilarity(title, t)));
    if (!best || similarity > best.similarity) best = { story, similarity };
  }
  return best;
}

/** Candidatos para Jev: primero los que más se parecen, luego los más recientes. */
function rankCandidates(title: string, stories: any[]): any[] {
  return [...stories]
    .map((story) => ({
      story,
      similarity: Math.max(
        ...(story.titles?.length ? story.titles : [story.title]).map((t: string) =>
          titleSimilarity(title, t),
        ),
      ),
    }))
    .sort(
      (a, b) =>
        b.similarity - a.similarity ||
        new Date(b.story.lastSignalAt).getTime() - new Date(a.story.lastSignalAt).getTime(),
    )
    .slice(0, MAX_CANDIDATES)
    .map((c) => c.story);
}

async function findStoryFor(signal: any, stories: any[], errors: string[]): Promise<any | null> {
  const lexical = bestLexical(signal.title, stories);
  if (lexical && lexical.similarity >= LEXICAL_MATCH) return lexical.story;
  if (!stories.length || !gatewayService.isGatewayConfigured()) return null;
  const ranked = rankCandidates(signal.title, stories);
  try {
    const ref = await jevService.matchStory(
      { title: signal.title, summary: signal.summary },
      ranked.map((s, i) => ({ ref: `h${i}`, title: s.title })),
    );
    return ref ? (ranked[Number(ref.slice(1))] ?? null) : null;
  } catch (error) {
    errors.push(`Agrupador (Jev): ${errorMessage(error)}`);
    return null;
  }
}

/**
 * Las notas creadas antes del agrupador no tienen hecho. Sin uno, lo nuevo
 * sobre ellas abriría un hecho aparte y se redactaría dos veces.
 */
export async function ensureStoriesForRecentArticles(): Promise<number> {
  const since = new Date(Date.now() - STORY_WINDOW_MS);
  const articles = await Article.find({
    storyId: null,
    status: { $in: ["pending", "published"] },
    createdAt: { $gte: since },
  }).select("title lede section score signalId sources createdAt");
  for (const article of articles as any[]) {
    const story = await Story.create({
      title: article.title,
      summary: article.lede,
      titles: [article.title],
      status: "covered",
      reason: "Ya tiene nota",
      score: article.score?.total ?? 0,
      bestScore: article.score ?? null,
      section: article.section,
      signalCount: article.signalId ? 1 : 0,
      sourceNames: [...new Set<string>(article.sources.map((s: any) => s.name))],
      firstSignalAt: article.createdAt,
      lastSignalAt: article.createdAt,
      articleId: article._id,
    });
    article.storyId = story._id;
    await article.save();
    if (article.signalId) await Signal.updateOne({ _id: article.signalId }, { storyId: story._id });
  }
  return articles.length;
}

function decideStatus(story: any): { status: StoryStatus; reason: string } {
  if (story.status === "discarded") return { status: "discarded", reason: story.reason };
  if (story.articleId) return { status: "covered", reason: "Ya tiene nota" };
  if (story.familyVeto) {
    return {
      status: "blocked",
      reason: "Familia vetada: toca a un familiar del presidente, un expresidente o los alcaldes de Quito y Guayaquil. Solo un humano lo levanta.",
    };
  }
  if (story.score < env.WATCHLIST_MIN) {
    return { status: "archived", reason: `Puntaje ${story.score}, bajo ${env.WATCHLIST_MIN}` };
  }
  if (story.score < env.PUBLISH_THRESHOLD) {
    return {
      status: "watchlist",
      reason: `Puntaje ${story.score}: espera más fuentes para llegar a ${env.PUBLISH_THRESHOLD}`,
    };
  }
  if (story.accusation && story.sourceNames.length < 2 && !story.hasOfficialSource) {
    return {
      status: "watchlist",
      reason: "Acusación contra alguien con nombre y una sola fuente: falta un segundo medio o una fuente oficial",
    };
  }
  if (story.signalCount <= story.holdUntilCount) {
    return { status: "watchlist", reason: "La Mesa pidió esperar más fuentes" };
  }
  return { status: "ready", reason: "Lista para redactar" };
}

/** Recalcula conteos, puntaje y estado del hecho desde sus señales. */
export async function refreshStory(story: any, categories?: Map<string, string>) {
  const cats = categories ?? (await sourceCategories());
  const signals = await Signal.find({ storyId: story._id })
    .sort({ "score.total": -1, createdAt: 1 })
    .limit(80)
    .select(
      "title summary sourceName sourceId score accusation familyVeto section publishedAt createdAt",
    );
  if (!signals.length) return story;

  const best: any = signals[0];
  const sourceNames = [...new Set(signals.map((s: any) => s.sourceName).filter(Boolean))];
  // Corroboración: dos medios suman medio punto, tres o más suman uno.
  const bonus = sourceNames.length >= 3 ? 1 : sourceNames.length === 2 ? 0.5 : 0;
  const times = signals.map((s: any) => new Date(s.publishedAt ?? s.createdAt).getTime());

  story.signalCount = signals.length;
  story.sourceNames = sourceNames;
  story.hasOfficialSource = signals.some(
    (s: any) => cats.get(String(s.sourceId)) === "institucion",
  );
  story.accusation = signals.some((s: any) => s.accusation);
  story.familyVeto = signals.some((s: any) => s.familyVeto);
  if (best.score) {
    story.bestScore = best.score;
    story.score = round1(Math.min(10, best.score.total + bonus));
  }
  if (!story.articleId) {
    story.title = best.title;
    story.summary = best.summary;
  }
  if (best.section) story.section = best.section;
  story.firstSignalAt = new Date(Math.min(...times));
  story.lastSignalAt = new Date(Math.max(...times, new Date(story.lastSignalAt).getTime()));
  const { status, reason } = decideStatus(story);
  story.status = status;
  story.reason = reason;
  await story.save();
  return story;
}

export interface Attachment {
  signal: any;
  story: any;
}

/**
 * Agrupa señales ya valoradas. Va en tandas: lo que abre una tanda queda
 * visible para la siguiente, así dos medios con la misma noticia nueva en el
 * mismo ciclo caen en un solo hecho.
 */
export async function clusterSignals(
  signals: any[],
  { deadline, errors }: { deadline: number; errors: string[] },
): Promise<{ clustered: number; attachments: Attachment[] }> {
  if (!signals.length) return { clustered: 0, attachments: [] };
  const categories = await sourceCategories();
  const stories: any[] = await Story.find({
    status: { $ne: "discarded" },
    lastSignalAt: { $gte: new Date(Date.now() - STORY_WINDOW_MS) },
  })
    .sort({ lastSignalAt: -1 })
    .limit(300);

  const touched = new Map<string, any>();
  const attachments: Attachment[] = [];
  let clustered = 0;

  for (let i = 0; i < signals.length; i += CLUSTER_CONCURRENCY) {
    if (Date.now() > deadline) {
      errors.push("Sin tiempo para agrupar todas las señales; siguen en el próximo ciclo");
      break;
    }
    const batch = signals.slice(i, i + CLUSTER_CONCURRENCY);
    const matches = await mapLimit(batch, CLUSTER_CONCURRENCY, (signal) =>
      findStoryFor(signal, stories, errors),
    );

    for (const [index, signal] of batch.entries()) {
      let story = matches[index];
      // Lo abierto en esta misma tanda no lo vio Jev: se compara por titular.
      if (!story) {
        const fresh = stories.filter((s) => touched.has(String(s._id)) && !s.articleId);
        const lexical = bestLexical(signal.title, fresh);
        if (lexical && lexical.similarity >= LEXICAL_MATCH) story = lexical.story;
      }
      if (!story) {
        story = await Story.create({
          title: signal.title,
          summary: signal.summary,
          titles: [signal.title],
          section: signal.section ?? "politica",
          firstSignalAt: signal.publishedAt ?? signal.createdAt,
          lastSignalAt: signal.publishedAt ?? signal.createdAt,
        });
        stories.unshift(story);
      } else {
        story.titles = [...(story.titles ?? []), signal.title].slice(-TITLES_KEPT);
        if (story.articleId) attachments.push({ signal, story });
      }
      signal.storyId = story._id;
      await signal.save();
      touched.set(String(story._id), story);
      clustered++;
    }
  }

  for (const story of touched.values()) await refreshStory(story, categories);
  return { clustered, attachments };
}

// ——— Admin

export async function list(query: { status?: string; page?: unknown; limit?: unknown }) {
  const filter: Record<string, unknown> = {
    lastSignalAt: { $gte: new Date(Date.now() - 7 * 24 * 3600_000) },
  };
  if (query.status) {
    if (!STORY_STATUSES.includes(query.status as StoryStatus))
      throw new CustomError("Estado inválido", 400);
    filter.status = query.status;
  }
  return paginate(Story, filter, {
    page: query.page,
    limit: query.limit,
    sort: { score: -1, lastSignalAt: -1 },
  });
}

async function getDoc(id: string) {
  if (!isValidObjectId(id)) throw new CustomError("Hecho no encontrado", 404);
  const story = await Story.findById(id);
  if (!story) throw new CustomError("Hecho no encontrado", 404);
  return story;
}

export async function signalsOf(id: string) {
  const story = await getDoc(id);
  const signals = await Signal.find({ storyId: story._id }).sort({ "score.total": -1 }).limit(50);
  return { story: story.toJSON(), signals: signals.map((s: any) => s.toJSON()) };
}

export async function discard(id: string) {
  const story = await getDoc(id);
  story.status = "discarded";
  story.reason = "Descartado por la Mesa";
  await story.save();
  return story.toJSON();
}

/** "Esperar más fuentes": vuelve a la watchlist hasta que entre otra señal. */
export async function hold(storyId: Types.ObjectId | string) {
  const story = await Story.findById(storyId);
  if (!story) return null;
  story.articleId = null;
  story.holdUntilCount = story.signalCount;
  story.status = "watchlist";
  story.reason = "La Mesa pidió esperar más fuentes";
  await story.save();
  return story;
}
