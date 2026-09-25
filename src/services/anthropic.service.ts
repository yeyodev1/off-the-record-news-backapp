import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";
import {
  ArticleSource,
  Infographic,
  ScoreBreakdown,
  Section,
  SECTIONS,
  SECTION_NAMES,
} from "../models/article.model";
import { Edition } from "../models/subscriber.model";
import { truncate } from "../utils/text";

/**
 * Claude es la mesa de redacción: Haiku valora en lote (barato y rápido) y
 * Sonnet redacta. Toda salida va con structured outputs (`output_config.format`)
 * para que el JSON siempre valide contra el esquema y no haya que "limpiar" texto.
 */

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new CustomError(
      "La IA no está configurada en el servidor (falta ANTHROPIC_API_KEY)",
      503,
    );
  }
  if (!client) {
    // Timeout corto y un solo reintento: el ciclo completo tiene que caber en ~250 s.
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 120_000, maxRetries: 1 });
  }
  return client;
}

export function isAiConfigured(): boolean {
  return !!env.ANTHROPIC_API_KEY;
}

const EDITORIAL_SYSTEM = `Eres la mesa de redacción de Off the Record, un medio digital de noticias de Ecuador con el estilo "smart brevity" de Axios.

Reglas editoriales, sin excepción:
- Español ecuatoriano neutro. Frases cortas. Voz activa.
- Sin adjetivos valorativos, sin opinión, sin especulación, sin clickbait.
- Nunca inventes datos, cifras, fechas, nombres ni citas. Todo lo que escribes debe estar en el material que recibes.
- Si falta información, se omite. Nunca rellenes. Un campo opcional sin sustento va vacío ("") o null.
- Las citas textuales solo si aparecen literalmente en la fuente, con atribución.
- Atribuye los hechos a su fuente ("según Primicias", "informó la Presidencia").
- Prioriza lo que le importa a una persona en Ecuador: su bolsillo, su seguridad, sus derechos, quién decide.

Formato de cada nota:
- title: titular directo, máximo 70 caracteres, sin punto final.
- lede: UNA oración que cuenta el hecho principal.
- whyItMatters: "Por qué importa", 1 o 2 oraciones sobre la consecuencia para el lector.
- keyPoints: "Los detalles", de 2 a 4 viñetas breves con datos concretos.
- body: "Profundiza", de 2 a 5 párrafos cortos (máximo 3 oraciones cada uno) con contexto verificable.
- bigPicture: "El panorama", 1 oración de contexto, o "" si no hay sustento.
- whatsNext: "Qué sigue", 1 oración con el próximo paso conocido, o "" si no se sabe.
- section: una de ${SECTIONS.map((s) => `${s} (${SECTION_NAMES[s]})`).join(", ")}.
- tags: de 2 a 5 etiquetas cortas en minúsculas (personas, instituciones, temas).
- infographic: SOLO si la fuente trae al menos 2 cifras reales comparables; si no, null. Los valores son números, sin inventar.
- sources: los medios o instituciones citados, con su URL si la tienes.
- isBreaking: true solo si es un hecho de última hora de alto impacto nacional.`;

const SCORING_SYSTEM = `Eres el editor jefe de Off the Record, medio de noticias de Ecuador. Valoras hechos noticiosos para decidir cuáles merecen nota.

Criterios, cada uno de 0 a 10 (enteros o con un decimal):
- cercania: qué tan cerca está de la audiencia ecuatoriana (10 = pasa en Ecuador y afecta a ecuatorianos; noticias internacionales sin vínculo con Ecuador, 0–3).
- inmediatez: qué tan reciente es (10 = ocurrió en las últimas horas; más de 3 días, 0–3).
- personaje: si involucra a un personaje público relevante (Presidente, ministros, asambleístas, jueces, alcaldes, figuras nacionales).
- relevancia: interés público; lo que un ciudadano necesita saber.
- impacto: efecto económico o social (bolsillo, empleo, seguridad, servicios, derechos).

Sé exigente: farándula, deportes sin impacto, sucesos aislados, notas de servicio y publicidad puntúan bajo en relevancia e impacto.
reasoning: una sola oración en español explicando la valoración.
duplicate: true si el hecho ya está cubierto por alguno de los titulares recientes que se te dan (mismo hecho, aunque cambie la redacción). Si dos o más hechos de la lista son el mismo, marca duplicate:true en todos menos en el más completo.
section: la sección que mejor le corresponde.`;

// ——— Esquemas JSON (structured outputs exige additionalProperties:false y todo requerido)

const infographicSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        title: { type: "string" },
        unit: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { label: { type: "string" }, value: { type: "number" } },
            required: ["label", "value"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "unit", "items"],
      additionalProperties: false,
    },
    { type: "null" },
  ],
};

const articleSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    lede: { type: "string" },
    whyItMatters: { type: "string" },
    keyPoints: { type: "array", items: { type: "string" } },
    body: { type: "array", items: { type: "string" } },
    bigPicture: { type: "string" },
    whatsNext: { type: "string" },
    section: { type: "string", enum: [...SECTIONS] },
    tags: { type: "array", items: { type: "string" } },
    infographic: infographicSchema,
    sources: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, url: { type: "string" } },
        required: ["name", "url"],
        additionalProperties: false,
      },
    },
    isBreaking: { type: "boolean" },
  },
  required: [
    "title",
    "lede",
    "whyItMatters",
    "keyPoints",
    "body",
    "bigPicture",
    "whatsNext",
    "section",
    "tags",
    "infographic",
    "sources",
    "isBreaking",
  ],
  additionalProperties: false,
};

const scoresSchema = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ref: { type: "string" },
          cercania: { type: "number" },
          inmediatez: { type: "number" },
          personaje: { type: "number" },
          relevancia: { type: "number" },
          impacto: { type: "number" },
          reasoning: { type: "string" },
          duplicate: { type: "boolean" },
          section: { type: "string", enum: [...SECTIONS] },
        },
        required: [
          "ref",
          "cercania",
          "inmediatez",
          "personaje",
          "relevancia",
          "impacto",
          "reasoning",
          "duplicate",
          "section",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

const introSchema = {
  type: "object",
  properties: { subject: { type: "string" }, intro: { type: "string" } },
  required: ["subject", "intro"],
  additionalProperties: false,
};

// ——— Tipos públicos

export interface SignalForScoring {
  ref: string;
  title: string;
  summary: string;
  sourceName: string;
  publishedAt: Date | null;
}

export interface SignalScore {
  ref: string;
  score: ScoreBreakdown;
  duplicate: boolean;
  section: Section;
}

export interface ArticleDraft {
  title: string;
  lede: string;
  whyItMatters: string;
  keyPoints: string[];
  body: string[];
  bigPicture: string;
  whatsNext: string;
  section: Section;
  tags: string[];
  infographic: Infographic | null;
  sources: ArticleSource[];
  isBreaking: boolean;
}

export interface Research {
  context: string;
  citations: string[];
}

// ——— Llamada base

async function callJson<T>(opts: {
  model: string;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  maxTokens: number;
}): Promise<T> {
  const anthropic = getClient();
  // Haiku 4.5 no acepta `effort` ni thinking adaptativo; Sonnet 5 sí y redacta mejor con él.
  const isHaiku = opts.model.includes("haiku");

  let response: Anthropic.Message;
  try {
    response = await anthropic.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens,
      system: opts.system,
      messages: [{ role: "user", content: opts.prompt }],
      ...(isHaiku ? {} : { thinking: { type: "adaptive" as const } }),
      output_config: {
        format: { type: "json_schema", schema: opts.schema },
        ...(isHaiku ? {} : { effort: "medium" as const }),
      },
    });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      throw new CustomError("La IA está saturada, intenta en unos minutos", 503);
    }
    if (error instanceof Anthropic.AuthenticationError) {
      throw new CustomError("La llave de la IA no es válida", 503);
    }
    // Llaves de organización sin workspace: es un problema de configuración, no del contenido.
    if (error instanceof Anthropic.BadRequestError && /workspace/i.test(error.message)) {
      throw new CustomError(
        "La llave de la IA no está asociada a un workspace de Anthropic; usa una llave de workspace",
        503,
      );
    }
    if (error instanceof Anthropic.APIError) {
      throw new CustomError(`La IA respondió con error (${error.status}): ${error.message}`, 502);
    }
    throw error;
  }

  if (response.stop_reason === "refusal") {
    throw new CustomError("La IA se negó a procesar este contenido", 422);
  }
  if (response.stop_reason === "max_tokens") {
    throw new CustomError("La respuesta de la IA quedó incompleta", 502);
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CustomError("La IA devolvió un formato inválido", 502);
  }
}

// ——— Valoración

const clamp = (n: number) => Math.max(0, Math.min(10, Number(n) || 0));

/** Relevancia e impacto pesan el doble que el resto. */
export function weightedTotal(s: Omit<ScoreBreakdown, "total" | "reasoning">): number {
  const total = (s.cercania + s.inmediatez + s.personaje + 2 * s.relevancia + 2 * s.impacto) / 7;
  return Math.round(total * 10) / 10;
}

function nowInEcuador(): string {
  return new Date().toLocaleString("es-EC", { timeZone: "America/Guayaquil" });
}

/** Valora varias señales en un solo request. Las que la IA omita no vienen en el resultado. */
export async function scoreSignals(
  signals: SignalForScoring[],
  recentHeadlines: string[] = [],
): Promise<SignalScore[]> {
  if (!signals.length) return [];

  const list = signals
    .map((s) => {
      const date = s.publishedAt ? s.publishedAt.toISOString() : "sin fecha";
      return `[${s.ref}] (${s.sourceName}, ${date}) ${truncate(s.title, 200)}\n${truncate(s.summary, 400)}`;
    })
    .join("\n\n");

  const headlines = recentHeadlines.length
    ? recentHeadlines.map((h) => `- ${h}`).join("\n")
    : "(ninguno)";

  const prompt = `Fecha y hora actual en Ecuador: ${nowInEcuador()}.

Titulares ya publicados por Off the Record en los últimos días:
${headlines}

Valora cada uno de estos hechos. Devuelve un resultado por cada [ref], usando exactamente el mismo ref:

${list}`;

  const result = await callJson<{
    results: Array<{
      ref: string;
      cercania: number;
      inmediatez: number;
      personaje: number;
      relevancia: number;
      impacto: number;
      reasoning: string;
      duplicate: boolean;
      section: Section;
    }>;
  }>({
    model: env.AI_SCORING_MODEL,
    system: SCORING_SYSTEM,
    prompt,
    schema: scoresSchema,
    maxTokens: Math.min(16000, 400 + signals.length * 180),
  });

  const refs = new Set(signals.map((s) => s.ref));
  return result.results
    .filter((r) => refs.has(r.ref))
    .map((r) => {
      const parts = {
        cercania: clamp(r.cercania),
        inmediatez: clamp(r.inmediatez),
        personaje: clamp(r.personaje),
        relevancia: clamp(r.relevancia),
        impacto: clamp(r.impacto),
      };
      return {
        ref: r.ref,
        duplicate: !!r.duplicate,
        section: SECTIONS.includes(r.section) ? r.section : "politica",
        score: { ...parts, total: weightedTotal(parts), reasoning: r.reasoning },
      };
    });
}

// ——— Redacción

function cleanDraft(draft: ArticleDraft): ArticleDraft {
  const infographic =
    draft.infographic && draft.infographic.items?.length >= 2
      ? {
          ...draft.infographic,
          items: draft.infographic.items.filter((i) => Number.isFinite(i.value)),
        }
      : null;
  return {
    ...draft,
    title: truncate(draft.title.trim().replace(/\.$/, ""), 90),
    keyPoints: draft.keyPoints.filter(Boolean).slice(0, 4),
    body: draft.body.filter(Boolean),
    tags: [...new Set(draft.tags.map((t) => t.toLowerCase().trim()).filter(Boolean))].slice(0, 5),
    section: SECTIONS.includes(draft.section) ? draft.section : "politica",
    sources: draft.sources.filter((s) => s.name),
    infographic,
  };
}

async function draftFrom(prompt: string): Promise<ArticleDraft> {
  const draft = await callJson<ArticleDraft>({
    model: env.AI_WRITING_MODEL,
    system: EDITORIAL_SYSTEM,
    prompt,
    schema: articleSchema,
    maxTokens: 16000,
  });
  return cleanDraft(draft);
}

export async function writeArticle(
  signal: {
    title: string;
    summary: string;
    url: string;
    sourceName: string;
    publishedAt: Date | null;
  },
  research: Research | null,
): Promise<ArticleDraft> {
  const researchBlock = research?.context
    ? `\n\nInvestigación adicional (búsqueda web en tiempo real):\n${truncate(research.context, 6000)}\n\nFuentes de la investigación:\n${research.citations.map((c) => `- ${c}`).join("\n")}`
    : "";

  const prompt = `Fecha y hora actual en Ecuador: ${nowInEcuador()}.

Redacta una nota smart brevity sobre este hecho. Usa solo la información de abajo.

Fuente original: ${signal.sourceName}
URL: ${signal.url}
Fecha: ${signal.publishedAt ? signal.publishedAt.toISOString() : "sin fecha"}
Titular original: ${signal.title}
Resumen: ${signal.summary}${researchBlock}

Incluye en sources al medio original (${signal.sourceName}, ${signal.url}) y las fuentes de la investigación que hayas usado.`;

  return draftFrom(prompt);
}

export async function rewriteArticle(
  article: Omit<ArticleDraft, "isBreaking"> & { isBreaking?: boolean },
  instructions: string,
): Promise<ArticleDraft> {
  const current = JSON.stringify(
    {
      title: article.title,
      lede: article.lede,
      whyItMatters: article.whyItMatters,
      keyPoints: article.keyPoints,
      body: article.body,
      bigPicture: article.bigPicture,
      whatsNext: article.whatsNext,
      section: article.section,
      tags: article.tags,
      infographic: article.infographic,
      sources: article.sources,
      isBreaking: !!article.isBreaking,
    },
    null,
    2,
  );

  const prompt = `Reescribe esta nota siguiendo las instrucciones del editor. No agregues hechos que no estén en la nota actual.

Instrucciones del editor:
${instructions}

Nota actual (JSON):
${current}`;

  return draftFrom(prompt);
}

/** Para Telegram, denuncias y carga manual: texto libre → nota. */
export async function articleFromText(text: string, sourceUrl = ""): Promise<ArticleDraft> {
  const prompt = `Fecha y hora actual en Ecuador: ${nowInEcuador()}.

Convierte este material en una nota smart brevity. Usa solo lo que dice el texto; si no alcanza para un campo, déjalo vacío.
${sourceUrl ? `\nURL de referencia: ${sourceUrl}\n` : ""}
Material:
"""
${truncate(text, 12000)}
"""`;

  return draftFrom(prompt);
}

const EDITION_LABEL: Record<Edition, string> = {
  manana: "edición de la mañana",
  noche: "edición de la noche",
  economia: "boletín semanal de economía",
  legislativo: "boletín semanal de la Asamblea",
};

export async function newsletterIntro(
  articles: Array<{ title: string; lede: string; section: string }>,
  edition: Edition,
): Promise<{ subject: string; intro: string }> {
  const list = articles.map((a, i) => `${i + 1}. [${a.section}] ${a.title} — ${a.lede}`).join("\n");

  const prompt = `Escribe la apertura del newsletter de Off the Record, ${EDITION_LABEL[edition]}, fecha ${nowInEcuador()}.

- subject: asunto del correo, máximo 60 caracteres, que nombre el hecho principal.
- intro: sección "La historia del día": 2 a 3 oraciones sobre el hecho más importante de la lista y por qué importa. Sin saludos ni despedidas, sin datos que no estén en la lista.

Notas incluidas:
${list}`;

  return callJson<{ subject: string; intro: string }>({
    model: env.AI_WRITING_MODEL,
    system: EDITORIAL_SYSTEM,
    prompt,
    schema: introSchema,
    maxTokens: 4000,
  });
}
