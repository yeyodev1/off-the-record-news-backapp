import { env } from "../config/env";
import { computeRelevance, Lens, ModeRelevance, Stance, STANCES } from "../config/modes";
import { Article, ArticleSource } from "../models/article.model";
import { truncate } from "../utils/text";
import { callJson } from "./anthropic.service";

/**
 * Lente por orillas (M2 postura por pieza + M5 relevancia por modo). La IA solo
 * clasifica: nunca escribe texto para el lector. La relevancia de cada modo la
 * calcula `computeRelevance` con los pesos de config/modes.ts.
 */

const LENS_SYSTEM = `Eres analista de la Mesa de Off the Record, medio de noticias de Ecuador. No redactas: clasificas un hecho ya publicado para ordenar la portada según el modo de lectura de cada persona. El texto de la nota no cambia nunca.

Contexto político de Ecuador:
- Oficialismo: el Ejecutivo (Presidencia de Daniel Noboa, ministerios, gobernaciones) y su bloque en la Asamblea (ADN y aliados que votan con el gobierno).
- Correísmo: la Revolución Ciudadana (RC5), Rafael Correa, Luisa González y sus asambleístas, alcaldes y prefectos.
- Oposición no correísta: PSC, Pachakutik, Construye, Izquierda Democrática y otros que se oponen al gobierno sin ser correístas.
- Institucional y de control: Fiscalía, Corte Constitucional, Corte Nacional, Contraloría, CNE, TCE, CPCCS, Defensoría, Superintendencias, Banco Central.

Devuelve:
- oficialismo, correismo, oposicion, institucional: de 0 a 10, cuánto protagoniza el hecho cada uno (10 = actor central; 0 = no aparece). Un hecho de economía doméstica sin actores políticos puede tener todo en 0 o casi.
- solidez: 1 si descansa en un solo medio o una sola declaración; 2 si lo cuentan varias fuentes independientes; 3 si hay documento, resolución, cifra oficial o dato verificable.
- documentosPrimarios: true si la nota cita un documento primario (decreto, resolución, informe, sentencia, contrato, registro oficial, datos oficiales).
- contradiccion: true solo si el material muestra una contradicción concreta entre lo dicho y lo hecho, o una promesa incumplida, de cualquier orilla.
- nota: una oración interna para la Mesa explicando la clasificación. No es para el lector.
- stances: una por cada fuente, con su índice, la postura de ESA pieza frente a ESTE hecho: ${STANCES.join(", ")}. "oficialista" si la pieza recoge o defiende la versión del gobierno; "correista" si la recoge o defiende la del correísmo; "opositora" si es la de otra oposición; "institucional" si es un órgano del Estado o de control hablando por sí mismo; "neutral" si solo informa sin tomar una versión; "no_aplica" si el hecho no tiene orillas. Juzga por lo que dice la pieza, no por la fama del medio.`;

const lensSchema = {
  type: "object",
  properties: {
    oficialismo: { type: "number" },
    correismo: { type: "number" },
    oposicion: { type: "number" },
    institucional: { type: "number" },
    solidez: { type: "integer" },
    documentosPrimarios: { type: "boolean" },
    contradiccion: { type: "boolean" },
    nota: { type: "string" },
    stances: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          stance: { type: "string", enum: [...STANCES] },
        },
        required: ["index", "stance"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "oficialismo",
    "correismo",
    "oposicion",
    "institucional",
    "solidez",
    "documentosPrimarios",
    "contradiccion",
    "nota",
    "stances",
  ],
  additionalProperties: false,
};

interface LensInput {
  title: string;
  lede: string;
  keyPoints: string[];
  body: string[];
  sources: ArticleSource[];
}

const clamp10 = (n: unknown) => Math.max(0, Math.min(10, Number(n) || 0));

export async function assess(article: LensInput): Promise<{ lens: Lens; stances: Stance[] }> {
  const sources = article.sources
    .map((s, i) => `[${i}] ${s.name}${s.summary ? `: ${truncate(s.summary, 300)}` : ""}`)
    .join("\n");
  const prompt = `Titular: ${article.title}
Entrada: ${article.lede}
Detalles: ${article.keyPoints.join(" | ")}
Cuerpo: ${truncate(article.body.join(" "), 2500)}

Fuentes:
${sources || "(sin fuentes)"}`;

  const result = await callJson<{
    oficialismo: number;
    correismo: number;
    oposicion: number;
    institucional: number;
    solidez: number;
    documentosPrimarios: boolean;
    contradiccion: boolean;
    nota: string;
    stances: { index: number; stance: Stance }[];
  }>({
    model: env.AI_SCORING_MODEL,
    system: LENS_SYSTEM,
    prompt,
    schema: lensSchema,
    maxTokens: 1500,
  });

  const stances: Stance[] = article.sources.map(() => "neutral");
  for (const { index, stance } of result.stances ?? []) {
    if (index >= 0 && index < stances.length && STANCES.includes(stance)) stances[index] = stance;
  }
  const solidez = [1, 2, 3].includes(result.solidez) ? (result.solidez as 1 | 2 | 3) : 1;
  return {
    lens: {
      oficialismo: clamp10(result.oficialismo),
      correismo: clamp10(result.correismo),
      oposicion: clamp10(result.oposicion),
      institucional: clamp10(result.institucional),
      solidez,
      documentosPrimarios: !!result.documentosPrimarios,
      contradiccion: !!result.contradiccion,
      nota: truncate(String(result.nota ?? ""), 300),
      assessedAt: new Date(),
    },
    stances,
  };
}

/** Score total de la Mesa (0–10) → valor general 0–100. Sin score, valor medio. */
export function generalValue(doc: { score?: { total?: number } | null }): number {
  const total = doc.score?.total;
  return typeof total === "number" && total > 0 ? total * 10 : 50;
}

/**
 * Aplica la lente al documento (sin guardar). Las posturas que la Mesa puso a
 * mano no se pisan. Si la Mesa corrigió la relevancia, se conserva su versión y
 * solo se actualiza la propuesta automática.
 */
export function applyLens(doc: any, lens: Lens, stances: Stance[]) {
  doc.lens = lens;
  doc.sources.forEach((source: any, i: number) => {
    if (!source.stance && stances[i]) source.stance = stances[i];
  });
  const auto = computeRelevance(generalValue(doc), lens);
  doc.modeRelevanceAuto = auto;
  if (!doc.modeRelevanceEditedBy) doc.modeRelevance = auto;
}

/** Nunca lanza: si la IA falla, la nota queda con el valor general en todos los modos. */
export async function assessDoc(doc: any): Promise<boolean> {
  try {
    const { lens, stances } = await assess(doc);
    applyLens(doc, lens, stances);
    return true;
  } catch (error) {
    console.warn(`[lente] "${doc.title}": ${(error as Error).message}`);
    if (!doc.modeRelevance) doc.modeRelevance = computeRelevance(generalValue(doc), null);
    return false;
  }
}

/** Para el cron: notas publicadas sin lente (las anteriores a los modos, o las que fallaron). */
export async function backfill(limit = 6, deadline = Date.now() + 60_000): Promise<number> {
  const docs = await Article.find({ status: "published", lens: null })
    .sort({ publishedAt: -1 })
    .limit(limit);
  let done = 0;
  for (const doc of docs) {
    if (Date.now() > deadline) break;
    if (await assessDoc(doc)) done++;
    await doc.save();
  }
  return done;
}

/** Corrección humana: guarda los cuatro números y quién los puso. */
export function setManualRelevance(doc: any, value: unknown, by: string) {
  if (!value || typeof value !== "object") return;
  const input = value as Record<string, unknown>;
  const auto: ModeRelevance = doc.modeRelevanceAuto?.toObject?.() ??
    doc.modeRelevance?.toObject?.() ?? computeRelevance(generalValue(doc), null);
  const next = { ...auto };
  for (const mode of Object.keys(next) as (keyof ModeRelevance)[]) {
    if (input[mode] !== undefined) {
      next[mode] = Math.max(0, Math.min(100, Math.round(Number(input[mode]) || 0)));
    }
  }
  doc.modeRelevance = next;
  if (!doc.modeRelevanceAuto) doc.modeRelevanceAuto = auto;
  doc.modeRelevanceEditedBy = by || "Mesa";
}
