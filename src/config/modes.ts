/**
 * Modos de lectura (MODOS-DE-LECTURA.md). El modo solo cambia el orden y qué
 * cobertura se ve primero: el texto de la nota es uno solo para todos. Por eso
 * aquí no hay nada de redacción, solo números.
 */

export const READING_MODES = ["noboista", "correista", "anti_ambos", "independiente"] as const;
export type ReadingMode = (typeof READING_MODES)[number];

export const MODE_NAMES: Record<ReadingMode, string> = {
  noboista: "Noboísta",
  correista: "Correísta",
  anti_ambos: "Anti-ambos",
  independiente: "Independiente",
};

export function parseMode(value: unknown): ReadingMode | null {
  const mode = String(value ?? "").trim().toLowerCase().replace("-", "_");
  return READING_MODES.includes(mode as ReadingMode) ? (mode as ReadingMode) : null;
}

/** Modos que reponderan; independiente es el orden editorial tal cual. */
export function isWeighted(mode: ReadingMode | null): mode is Exclude<ReadingMode, "independiente"> {
  return !!mode && mode !== "independiente";
}

/** Postura de una pieza respecto del hecho concreto, no del medio en general. */
export const STANCES = [
  "oficialista",
  "opositora",
  "correista",
  "institucional",
  "neutral",
  "no_aplica",
] as const;
export type Stance = (typeof STANCES)[number];

/** Lo que la IA lee del hecho. La relevancia por modo sale de aquí con código, no del modelo. */
export interface Lens {
  /** Presencia de cada orilla o actor en el hecho, 0 a 10. */
  oficialismo: number;
  correismo: number;
  /** Oposición que no es correísmo (PSC, Pachakutik, ADN disidente, etc.). */
  oposicion: number;
  institucional: number;
  /** S1 = un solo medio o declaración; S2 = varias fuentes independientes; S3 = documento o dato oficial verificable. */
  solidez: 1 | 2 | 3;
  documentosPrimarios: boolean;
  /** Contradicción entre lo dicho y lo hecho, o promesa incumplida. */
  contradiccion: boolean;
  nota: string;
  assessedAt: Date;
}

export type ModeRelevance = Record<ReadingMode, number>;

/**
 * Pesos por modo. Agregar un modo es agregar una fila aquí (y su nombre arriba).
 * Cada peso multiplica una señal de 0 a 1; el resultado se suma al valor
 * general (0–100) y se recorta a 0–100.
 */
export const MODE_WEIGHTS: Record<Exclude<ReadingMode, "independiente">, Record<string, number>> = {
  noboista: { oficialismo: 18, correismo: 4, oposicion: 5, institucional: 2, sinOrilla: -10 },
  correista: { oficialismo: 5, correismo: 18, oposicion: 6, institucional: 2, sinOrilla: -10 },
  // Anti-ambos premia prueba y control, y castiga la pelea de orillas sin sustento.
  anti_ambos: { institucional: 8, solidez: 8, documentos: 5, contradiccion: 12, puraOrilla: -10 },
};

/** Garantía del spec: lo grande le llega a todos. */
export const BIG_STORY_MIN = 85;

/** Cuánto pierde una nota por hora en los órdenes reponderados (secciones y bloques). */
export const DECAY_PER_HOUR = 1.2;

const clamp100 = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** `general` es el score total de la Mesa (0–10) llevado a 0–100. */
export function computeRelevance(general: number, lens: Lens | null): ModeRelevance {
  const base = clamp100(general);
  const out = { noboista: base, correista: base, anti_ambos: base, independiente: base };
  if (!lens) return out;

  const signals: Record<string, number> = {
    oficialismo: lens.oficialismo / 10,
    correismo: lens.correismo / 10,
    oposicion: lens.oposicion / 10,
    institucional: lens.institucional / 10,
    solidez: (lens.solidez - 1) / 2,
    documentos: lens.documentosPrimarios ? 1 : 0,
    contradiccion: lens.contradiccion ? 1 : 0,
    sinOrilla: Math.max(lens.oficialismo, lens.correismo, lens.oposicion) < 3 ? 1 : 0,
    puraOrilla:
      lens.solidez === 1 && Math.max(lens.oficialismo, lens.correismo, lens.oposicion) >= 6 ? 1 : 0,
  };
  for (const mode of Object.keys(MODE_WEIGHTS) as (keyof typeof MODE_WEIGHTS)[]) {
    const weights = MODE_WEIGHTS[mode];
    const delta = Object.entries(weights).reduce((sum, [k, w]) => sum + w * (signals[k] ?? 0), 0);
    let value = clamp100(base + delta);
    if (base >= BIG_STORY_MIN) value = Math.max(value, BIG_STORY_MIN);
    out[mode] = value;
  }
  return out;
}

/** El modo contrario, para "Lo que tu orilla no está mirando". */
export function oppositeOf(mode: ReadingMode): ReadingMode | null {
  if (mode === "noboista") return "correista";
  if (mode === "correista") return "noboista";
  return null;
}
