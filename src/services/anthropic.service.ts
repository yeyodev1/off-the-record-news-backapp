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
import { chatJson as perplexityJson, isPerplexityConfigured } from "./perplexity.service";
import { chatJson as gatewayJson, isGatewayConfigured } from "./gateway.service";

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
    client = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      timeout: 120_000,
      maxRetries: 1,
      // Las llaves de organización sin workspace exigen este header en cada request.
      defaultHeaders: env.ANTHROPIC_WORKSPACE_ID
        ? { "anthropic-workspace-id": env.ANTHROPIC_WORKSPACE_ID }
        : undefined,
    });
  }
  return client;
}

export function isAiConfigured(): boolean {
  return isGatewayConfigured() || !!env.ANTHROPIC_API_KEY || isPerplexityConfigured();
}

/**
 * Si la llave de Claude falla por configuración (sin workspace, inválida), no
 * tiene sentido reintentarla en cada llamada: se usa Perplexity un rato y se
 * vuelve a probar Claude después.
 */
const CLAUDE_RETRY_MS = 10 * 60 * 1000;
let claudeDownUntil = 0;

function isConfigError(error: unknown): boolean {
  return error instanceof CustomError && error.status === 503 && !/saturada/.test(error.message);
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
- Voz de Boscán y La Moni en plural cuando hables como medio ("leímos", "vimos"). Frases cortas; la lapidaria después de la larga; las cifras traducidas a algo que se entienda. Léxico ecuatoriano real.

Línea editorial (ley de contenido):
1. Sin banderas políticas: ni a favor ni en contra del Gobierno. La conclusión la pone el lector.
2. Ningún político es leyenda: nadie, vivo o muerto, es héroe, mártir, prócer ni villano. Hechos, cargos, fechas, consecuencias.
3. Cero camioneta: sin linchamientos, sin catalogar a nadie de bueno o malo, sin sumarse a la indignación del día.
4. Equilibrio de orillas: si el tema es político y el material trae versiones de ambos lados, cuéntalas con el medio nombrado (oficialistas de referencia: Radiocentro, La Posta; opositores: Radio Pichincha, Expreso; correístas: Ecuadorinmediato, Pichincha Comunicaciones). Sin arbitrar.
5. La familia es territorio vetado: cero cobertura de familiares (madre, padre, hijos, parejas, hermanos, primos, tíos) del presidente, de los expresidentes y de los alcaldes de Quito y Guayaquil. Única excepción: el familiar que es el actor directo del hecho (firmó el contrato) se cubre por su acto, sin extender el foco a la familia.
6. Presunción de inocencia: "presunto", "según la Fiscalía", estado procesal explícito. Si falta la versión del aludido, dilo.
7. Humor solo hacia arriba. Opinión etiquetada o ausente.
8. Fechas exactas: la fecha de cada pieza es la única verdad temporal. Nunca deduzcas el día de la semana ("el martes") ni "ayer" si la fuente no lo dice.

Reglas de redacción (ley de forma, adaptada de "Signs of AI writing"):
- Prohibido el guion largo (— o –) en cualquier forma: usa punto, coma, dos puntos o paréntesis.
- Prohibido el paralelismo negativo y toda su familia: "no es X, es Y", "no es X, sino Y", "no solo X, sino también Y", "más que X, Y", "lejos de X", ni partido en dos frases ("No fue un error. Fue una decisión."). Di lo que es.
- Prohibido inflar el legado o la importancia: "marca un hito", "histórico", "sin precedentes", "punto de inflexión", "un antes y un después".
- Prohibido el gerundio analítico colgado al final ("…, evidenciando la crisis", "…, reflejando el malestar").
- Prohibida la atribución vaga: "expertos señalan", "analistas creen", "muchos consideran", "se dice que". Nombra quién o no lo digas.
- Prohibido el vocabulario de IA: "cabe destacar", "es importante señalar", "en el marco de", "en un contexto de", "panorama" (fuera de la sección), "abordar", "fomentar", "potenciar", "crucial", "fundamental", "sinergia", "ecosistema", "navegar", "desafíos".
- Prohibidos los rodeos del verbo ser: "se erige como", "se posiciona como", "constituye", "representa un". Usa "es".
- Prohibidas las muletillas y cierres de ensayo: "en resumen", "en conclusión", "en definitiva", "sin duda", "queda claro que", "solo el tiempo dirá", y las aperturas de humo ("En un mundo donde…").
- Prohibida la regla de tres decorativa (tres adjetivos o sustantivos en fila por ritmo), el hedging doble ("podría eventualmente") y el tono de comunicado ("reafirma su compromiso", "en aras de").
- Sin negrillas ni mayúsculas de título.
- Cada cifra, nombre y enlace tiene que estar escrito en el material. Un verificador automático lo comprueba.

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
- cercania: qué tan cerca está de la audiencia ecuatoriana (10 = pasa en Ecuador y afecta a ecuatorianos; noticias internacionales sin vínculo con Ecuador, 0–3; moda, farándula y deportes extranjeros sin ecuatorianos, 0–2).
- inmediatez: qué tan reciente es el hecho mismo, no la nota (10 = ocurrió en las últimas horas; ayer, 5; más de 2 días, 0–3). Un suceso de meses o años atrás publicado hoy vale 0.
- personaje: si involucra a un personaje público relevante (Presidente, ministros, asambleístas, jueces, alcaldes, figuras nacionales).
- relevancia: interés público; lo que un ciudadano necesita saber.
- impacto: efecto económico o social (bolsillo, empleo, seguridad, servicios, derechos).

Sé exigente: farándula, deportes sin impacto, sucesos aislados, notas de servicio y publicidad puntúan bajo en relevancia e impacto.
reasoning: una sola oración en español explicando la valoración.
duplicate: true si el hecho ya está cubierto por alguno de los titulares recientes que se te dan (mismo hecho, aunque cambie la redacción). Si dos o más hechos de la lista son el mismo, marca duplicate:true en todos menos en el más completo.
accusation: true si el hecho acusa a una persona o empresa nombrada de un delito o una irregularidad.
familyVeto: true si el hecho trata sobre un familiar (madre, padre, hijos, pareja, hermanos, primos, tíos) del presidente, de un expresidente o de los alcaldes de Quito o Guayaquil, salvo que ese familiar sea el actor directo del hecho (por ejemplo, firmó el contrato).
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
          accusation: { type: "boolean" },
          familyVeto: { type: "boolean" },
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
          "accusation",
          "familyVeto",
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
  /** Opinión, cartas, portadas: no es un hecho que se pueda reportar. */
  notNews?: boolean;
  /** Acusa a alguien con nombre: el hecho necesita corroboración antes de redactarse. */
  accusation?: boolean;
  /** Familia vetada (presidente, expresidentes, alcaldes de Quito y Guayaquil): solo un humano lo levanta. */
  familyVeto?: boolean;
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

interface CallOptions {
  model: string;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  maxTokens: number;
}

/**
 * Orden de preferencia: Claude por el Vercel AI Gateway (sin llave de proveedor
 * que mantener), Claude con llave directa y, si nada de eso responde, Perplexity.
 */
async function callJson<T>(opts: CallOptions): Promise<T> {
  if (isGatewayConfigured()) {
    try {
      const model = opts.model.includes("haiku")
        ? env.GATEWAY_FAST_MODEL
        : env.GATEWAY_WRITING_MODEL;
      return await gatewayJson<T>({ ...opts, model });
    } catch (error) {
      console.warn(`[ia] AI Gateway falló (${(error as Error).message}); pruebo el respaldo`);
    }
  }
  const claudeUsable = !!env.ANTHROPIC_API_KEY && Date.now() >= claudeDownUntil;
  if (claudeUsable) {
    try {
      return await callClaude<T>(opts);
    } catch (error) {
      if (!isConfigError(error) || !isPerplexityConfigured()) throw error;
      console.warn(`[ia] Claude no disponible (${(error as Error).message}); uso Perplexity`);
      claudeDownUntil = Date.now() + CLAUDE_RETRY_MS;
    }
  }
  if (!isPerplexityConfigured()) getClient();
  return perplexityJson<T>(opts);
}

async function callClaude<T>(opts: CallOptions): Promise<T> {
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

/**
 * Relevancia e impacto pesan el doble que el resto. Off the Record es un medio
 * de Ecuador: lo que no toca al país no puede llegar al umbral de publicación
 * por más famoso o reciente que sea (moda en Milán, farándula extranjera).
 */
const MAX_TOTAL_FAR_FROM_ECUADOR = 6;

export function weightedTotal(s: Omit<ScoreBreakdown, "total" | "reasoning">): number {
  let total = (s.cercania + s.inmediatez + s.personaje + 2 * s.relevancia + 2 * s.impacto) / 7;
  if (s.cercania < 5) total = Math.min(total, MAX_TOTAL_FAR_FROM_ECUADOR);
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
      accusation: boolean;
      familyVeto: boolean;
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
        accusation: !!r.accusation,
        familyVeto: !!r.familyVeto,
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
    sources: uniqueSources(draft.sources),
    infographic,
  };
}

/** Una fuente por URL: la IA a veces cita dos veces la misma nota. */
function uniqueSources(sources: ArticleSource[]): ArticleSource[] {
  const seen = new Set<string>();
  return sources
    .map((s) => ({ name: s.name.trim(), url: s.url.trim() }))
    .filter((s) => {
      if (!s.name) return false;
      const key = (s.url || s.name)
        .toLowerCase()
        .replace(/[?#].*$/, "")
        .replace(/\/$/, "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 6);
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

export interface SignalInput {
  title: string;
  summary: string;
  url: string;
  sourceName: string;
  publishedAt: Date | null;
}

export function formatDate(date: Date | null): string {
  if (!date) return "sin fecha";
  return date.toLocaleString("es-EC", { timeZone: "America/Guayaquil", dateStyle: "long", timeStyle: "short" });
}

/** Las piezas de un hecho tal como las ve el redactor. También son el corpus del verificador. */
export function signalsBlock(signals: SignalInput[]): string {
  return signals
    .map(
      (s, i) => `Pieza ${i + 1}
Medio: ${s.sourceName}
URL: ${s.url}
Fecha: ${formatDate(s.publishedAt)}
Titular: ${s.title}
Resumen: ${s.summary}`,
    )
    .join("\n\n");
}

export function researchBlock(research: Research | null): string {
  if (!research?.context) return "";
  return `Investigación adicional (búsqueda web en tiempo real):
${truncate(research.context, 6000)}

Fuentes de la investigación:
${research.citations.map((c) => `- ${c}`).join("\n")}`;
}

/** Redacta un hecho a partir de todas sus piezas: varios medios cuentan más que uno. */
export async function writeArticle(
  signals: SignalInput[],
  research: Research | null,
): Promise<ArticleDraft> {
  const extra = researchBlock(research);
  const prompt = `Fecha y hora actual en Ecuador: ${nowInEcuador()}.

Redacta una nota smart brevity sobre este hecho. Usa solo la información de abajo. ${signals.length > 1 ? `Son ${signals.length} piezas de medios distintos sobre el mismo hecho: cruza lo que dicen y atribuye cada dato a su medio.` : ""}

${signalsBlock(signals)}${extra ? `\n\n${extra}` : ""}

Incluye en sources a los medios de arriba que hayas usado, con su URL exacta${extra ? ", y las fuentes de la investigación que hayas usado" : ""}. No escribas URLs que no aparezcan arriba.`;

  return draftFrom(prompt);
}

const updateSchema = {
  type: "object",
  properties: { nuevo: { type: "boolean" }, texto: { type: "string" } },
  required: ["nuevo", "texto"],
  additionalProperties: false,
};

/**
 * Bloque "Actualización HH:MM" de una nota publicada. Solo con lo que trae la
 * pieza nueva; si no aporta nada que la nota no tenga, `nuevo` va en false.
 */
export async function writeUpdate(
  article: { title: string; lede: string; keyPoints: string[]; body: string[]; updates: string[] },
  signal: SignalInput,
): Promise<{ nuevo: boolean; texto: string }> {
  const prompt = `Fecha y hora actual en Ecuador: ${nowInEcuador()}.

Esta nota ya está publicada:
Titular: ${article.title}
Entrada: ${article.lede}
Detalles: ${article.keyPoints.join(" | ")}
Cuerpo: ${truncate(article.body.join(" "), 3000)}
Actualizaciones previas: ${article.updates.length ? article.updates.join(" | ") : "(ninguna)"}

Llegó esta pieza nueva sobre el mismo hecho:
${signalsBlock([signal])}

Si la pieza aporta un dato nuevo y verificable que la nota no tiene (una respuesta del aludido, una cifra oficial, una decisión, un desarrollo), escribe en "texto" el bloque de actualización: de 1 a 3 oraciones, atribuido al medio ("según ${signal.sourceName}"), solo con lo que dice la pieza. No repitas lo que la nota ya cuenta y no empieces con "Actualización".
Si no aporta nada nuevo, "nuevo" va en false y "texto" vacío.`;

  const result = await callJson<{ nuevo: boolean; texto: string }>({
    model: env.AI_WRITING_MODEL,
    system: EDITORIAL_SYSTEM,
    prompt,
    schema: updateSchema,
    maxTokens: 4000,
  });
  return { nuevo: !!result.nuevo && !!result.texto.trim(), texto: result.texto.trim() };
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
