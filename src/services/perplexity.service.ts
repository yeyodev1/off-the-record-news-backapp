import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";

/**
 * Perplexity es el reportero con acceso a la web en tiempo real: descubre
 * noticias que no llegan por RSS y aporta contexto verificable para redactar.
 */

const ENDPOINT = "https://api.perplexity.ai/chat/completions";
const TIMEOUT_MS = 45_000;

export interface DiscoveredItem {
  title: string;
  url: string;
  summary: string;
  publishedAt: Date | null;
  sourceName: string;
}

export interface ResearchResult {
  context: string;
  citations: string[];
}

interface PerplexityResponse {
  choices?: Array<{ message?: { content?: string } }>;
  citations?: string[];
  search_results?: Array<{ title?: string; url?: string; date?: string }>;
}

export function isPerplexityConfigured(): boolean {
  return !!env.PERPLEXITY_API_KEY;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function chat(body: Record<string, unknown>, attempt = 1): Promise<PerplexityResponse> {
  if (!env.PERPLEXITY_API_KEY) {
    throw new CustomError("Perplexity no está configurado (falta PERPLEXITY_API_KEY)", 503);
  }
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.PERPLEXITY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: env.PERPLEXITY_MODEL, ...body }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // El plan tiene un tope de peticiones por minuto: se reintenta con espera creciente.
  if (response.status === 429 && attempt < 3) {
    await sleep(2000 * attempt);
    return chat(body, attempt + 1);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new CustomError(`Perplexity respondió ${response.status}: ${detail}`, 502);
  }
  return (await response.json()) as PerplexityResponse;
}

/**
 * Respaldo de redacción: Perplexity con la búsqueda apagada, para que trabaje
 * solo con el material que le damos (igual que Claude) y devuelva JSON validado.
 */
export async function chatJson<T>(opts: {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  maxTokens: number;
}): Promise<T> {
  const data = await chat({
    model: env.PERPLEXITY_WRITING_MODEL,
    max_tokens: opts.maxTokens,
    disable_search: true,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.prompt },
    ],
    response_format: { type: "json_schema", json_schema: { schema: opts.schema } },
  });
  const raw = data.choices?.[0]?.message?.content ?? "";
  // Algunos modelos anteponen razonamiento o envuelven el JSON en un bloque de código.
  const text = raw
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CustomError("La IA de respaldo devolvió un formato inválido", 502);
  }
}

function hostName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function parseDate(value: unknown): Date | null {
  if (!value || typeof value !== "string") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  // Perplexity a veces confunde la zona horaria y devuelve fechas "del futuro";
  // unas horas se toleran, más que eso es una fecha inventada.
  const ahead = date.getTime() - Date.now();
  if (ahead > 24 * 3600_000) return null;
  return ahead > 0 ? new Date() : date;
}

function urlKey(url: string): string {
  return url
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/[?#].*$/, "")
    .replace(/\/$/, "");
}

function todayInEcuador(): string {
  return new Date().toLocaleDateString("es-EC", {
    timeZone: "America/Guayaquil",
    dateStyle: "full",
  });
}

const discoverSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          summary: { type: "string" },
          publishedAt: { type: "string" },
          sourceName: { type: "string" },
        },
        required: ["title", "url", "summary", "publishedAt", "sourceName"],
      },
    },
  },
  required: ["items"],
};

/**
 * Busca noticias de Ecuador recientes sobre `query`. Nunca lanza: un fallo de
 * Perplexity no debe tumbar el ciclo; devuelve [] y el error va en `error`.
 */
const NOT_NEWS =
  /no (se )?(registra|encontr|hay (informaci|evidencia|registro|noticias))|sin (informaci|resultados|noticias)|archivo institucional/i;

export async function discover(
  query: string,
  recency: "hour" | "day" = "day",
): Promise<{ items: DiscoveredItem[]; error: string }> {
  try {
    const data = await chat({
      messages: [
        {
          role: "system",
          content:
            "Eres un buscador de noticias para un medio de Ecuador. Devuelve solo noticias reales publicadas por medios o instituciones, con su URL exacta. No inventes URLs ni fechas: la fecha es la de publicación que muestra la nota. Resúmenes de 1 a 2 oraciones en español, sin opinión. Cada resultado debe ser un hecho concreto y nuevo (algo que pasó, se anunció, se aprobó o se denunció) en las últimas 24 horas. No devuelvas hechos de semanas, meses o años anteriores aunque la página aparezca en la búsqueda, ni páginas de archivo, listados, portadas, agendas, ni resultados que digan que no se encontró información: si no hay noticias, devuelve una lista vacía.",
        },
        {
          role: "user",
          content: `Hoy es ${todayInEcuador()}. Noticias de Ecuador de las últimas 24 horas sobre: ${query}. Devuelve hasta 6 hechos distintos, cada uno con titular, URL de la nota original, resumen, fecha de publicación (ISO 8601) y nombre del medio.`,
        },
      ],
      search_recency_filter: recency,
      response_format: { type: "json_schema", json_schema: { schema: discoverSchema } },
      temperature: 0.1,
    });

    const content = data.choices?.[0]?.message?.content ?? "";
    let parsed: { items?: Array<Record<string, unknown>> } = {};
    try {
      parsed = JSON.parse(content);
    } catch {
      // Algunos modelos envuelven el JSON en ```; se rescata lo que haya entre llaves.
      const match = content.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : {};
    }

    // La fecha de los resultados de búsqueda viene del índice, no del modelo: manda sobre la suya.
    const indexedDates = new Map(
      (data.search_results ?? [])
        .filter((r) => r.url && r.date)
        .map((r) => [urlKey(r.url!), parseDate(r.date)]),
    );

    const items = (parsed.items ?? [])
      .map((item) => {
        const url = String(item.url ?? "").trim();
        return {
          title: String(item.title ?? "").trim(),
          url,
          summary: String(item.summary ?? "").trim(),
          publishedAt: indexedDates.get(urlKey(url)) ?? parseDate(item.publishedAt),
          sourceName: String(item.sourceName ?? "").trim() || hostName(url),
        };
      })
      .filter((item) => item.title && /^https?:\/\//.test(item.url))
      // Resultados de búsqueda vacíos disfrazados de noticia.
      .filter((item) => !NOT_NEWS.test(`${item.title} ${item.summary}`));

    return { items, error: "" };
  } catch (error) {
    return { items: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** Contexto verificable para enriquecer la redacción. Devuelve null si falla. */
export async function research(topic: string): Promise<ResearchResult | null> {
  if (!isPerplexityConfigured()) return null;
  try {
    const data = await chat({
      messages: [
        {
          role: "system",
          content:
            "Eres un investigador de un medio de Ecuador. Da contexto factual y verificable: antecedentes, cifras oficiales, actores involucrados y próximos pasos conocidos. Sin opinión. Si no hay información confiable sobre algo, no lo menciones. Español.",
        },
        {
          role: "user",
          content: `Contexto y datos verificados sobre este hecho reciente en Ecuador: ${topic}`,
        },
      ],
      search_recency_filter: "week",
      temperature: 0.1,
    });
    const context = data.choices?.[0]?.message?.content?.trim() ?? "";
    const citations =
      data.citations ?? (data.search_results ?? []).map((r) => r.url ?? "").filter(Boolean);
    return context ? { context, citations: citations.slice(0, 8) } : null;
  } catch (error) {
    console.warn("[perplexity] research falló:", error instanceof Error ? error.message : error);
    return null;
  }
}
