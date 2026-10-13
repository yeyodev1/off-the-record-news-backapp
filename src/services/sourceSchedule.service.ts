import { env } from "../config/env";
import { PEOPLE_CATEGORIES } from "../models/source.model";

/**
 * Qué fuentes se consultan en cada ciclo. El fundador pidió que la mesa
 * funcione la mayor cantidad de horas al menor costo: los RSS son gratis y van
 * en cada ciclo; las búsquedas con IA (Perplexity) cuestan, así que cada una
 * tiene su frecuencia, se atienden primero las que llevan más tiempo sin
 * revisarse y hay un tope por ciclo. Las personas sin consulta propia se buscan
 * de a varias en una sola búsqueda.
 */

export interface AiJob {
  query: string;
  sources: any[];
  weight: number;
}

const PEOPLE_PER_QUERY = 5;

function intervalMinutes(source: any): number {
  if (source.everyMinutes > 0) return source.everyMinutes;
  if (source.kind === "rss") return 0;
  return isPerson(source) ? env.PEOPLE_EVERY_MINUTES : env.AI_SOURCE_EVERY_MINUTES;
}

function isPerson(source: any): boolean {
  return PEOPLE_CATEGORIES.includes(source.category) && !String(source.query ?? "").trim();
}

export function isDue(source: any, now = Date.now()): boolean {
  const every = intervalMinutes(source);
  if (!every || !source.lastCheckedAt) return true;
  return now - new Date(source.lastCheckedAt).getTime() >= every * 60_000;
}

const byStaleness = (a: any, b: any) =>
  (a.lastCheckedAt ? new Date(a.lastCheckedAt).getTime() : 0) -
    (b.lastCheckedAt ? new Date(b.lastCheckedAt).getTime() : 0) ||
  (b.weight ?? 1) - (a.weight ?? 1);

function personLabel(source: any): string {
  const notes = String(source.notes ?? "").trim();
  return notes ? `${source.name} (${notes})` : source.name;
}

/** Arma las búsquedas del ciclo a partir de las fuentes de IA vencidas. */
export function planAiJobs(sources: any[], now = Date.now()): AiJob[] {
  const due = sources.filter((s) => isDue(s, now)).sort(byStaleness);
  const jobs: AiJob[] = [];
  const peopleByCategory = new Map<string, any[]>();

  for (const source of due) {
    if (isPerson(source)) {
      const group = peopleByCategory.get(source.category) ?? [];
      group.push(source);
      peopleByCategory.set(source.category, group);
      continue;
    }
    jobs.push({
      query: source.query || source.name,
      sources: [source],
      weight: source.weight ?? 1,
    });
  }

  for (const people of peopleByCategory.values()) {
    for (let i = 0; i < people.length; i += PEOPLE_PER_QUERY) {
      const group = people.slice(i, i + PEOPLE_PER_QUERY);
      jobs.push({
        query: `declaraciones públicas, entrevistas, denuncias o publicaciones en X/Twitter de: ${group
          .map(personLabel)
          .join("; ")}. Solo lo que dijeron o hicieron, con el medio o la red donde se publicó`,
        sources: group,
        weight: Math.max(...group.map((s) => s.weight ?? 1)),
      });
    }
  }

  // Las búsquedas más atrasadas primero; las personas compiten igual que el resto.
  return jobs
    .sort((a, b) => byStaleness(a.sources[0], b.sources[0]))
    .slice(0, env.MAX_AI_QUERIES_PER_RUN);
}
