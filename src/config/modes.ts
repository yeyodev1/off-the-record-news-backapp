/**
 * Modos de lectura (MODOS-DE-LECTURA.md, ajustado en la reunión del 13 de
 * octubre de 2026: quedan tres miradas y "anti-ambos" se funde con
 * independiente). Definición de Andersson: el noboísta no tuerce los hechos,
 * pero busca los que reafirman la narrativa oficial; el correísta busca la
 * visión de la oposición; el independiente equilibra ambos. El modo cambia el
 * orden (también el de "Las 5 cosas") y el encuadre y la redacción de la nota.
 * Los hechos, cifras y nombres son los mismos para todos: el verificador
 * revisa cada encuadre contra el corpus.
 */

export const READING_MODES = ["noboista", "correista", "independiente"] as const;
export type ReadingMode = (typeof READING_MODES)[number];

/** Modos con encuadre propio; independiente usa el texto base de la nota. */
export const FRAMED_MODES = ["noboista", "correista"] as const;
export type FramedMode = (typeof FRAMED_MODES)[number];

export const MODE_NAMES: Record<ReadingMode, string> = {
  noboista: "Noboísta",
  correista: "Correísta",
  independiente: "Independiente",
};

export function parseMode(value: unknown): ReadingMode | null {
  const mode = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace("-", "_");
  // Quien eligió anti-ambos antes del cambio sigue leyendo, ahora en independiente.
  if (mode === "anti_ambos") return "independiente";
  return READING_MODES.includes(mode as ReadingMode) ? (mode as ReadingMode) : null;
}

/** Modos que reponderan; independiente es el orden editorial tal cual. */
export function isWeighted(
  mode: ReadingMode | null,
): mode is Exclude<ReadingMode, "independiente"> {
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
  /** Cuánto sostiene el hecho la narrativa oficial (logros, decisiones, resultados del gobierno), 0 a 10. */
  refuerzaOficial: number;
  /** Cuánto sostiene la visión de la oposición (críticas, fallas, denuncias contra el gobierno), 0 a 10. */
  refuerzaOposicion: number;
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
  noboista: {
    refuerzaOficial: 30,
    refuerzaOposicion: -12,
    oficialismo: 8,
    institucional: 2,
    sinOrilla: -8,
  },
  correista: {
    refuerzaOposicion: 30,
    refuerzaOficial: -12,
    correismo: 10,
    oposicion: 6,
    institucional: 2,
    sinOrilla: -8,
  },
};

/** Garantía del spec: lo grande le llega a todos. */
export const BIG_STORY_MIN = 85;

/** Cuánto pierde una nota por hora en los órdenes reponderados (secciones y bloques). */
export const DECAY_PER_HOUR = 1.2;

const clamp100 = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** `general` es el score total de la Mesa (0–10) llevado a 0–100. */
export function computeRelevance(general: number, lens: Lens | null): ModeRelevance {
  const base = clamp100(general);
  const out = { noboista: base, correista: base, independiente: base };
  if (!lens) return out;

  const signals: Record<string, number> = {
    oficialismo: lens.oficialismo / 10,
    correismo: lens.correismo / 10,
    oposicion: lens.oposicion / 10,
    institucional: lens.institucional / 10,
    solidez: (lens.solidez - 1) / 2,
    documentos: lens.documentosPrimarios ? 1 : 0,
    contradiccion: lens.contradiccion ? 1 : 0,
    // Las lentes anteriores a esta señal no la tienen: cuentan como neutras.
    refuerzaOficial: (lens.refuerzaOficial ?? 0) / 10,
    refuerzaOposicion: (lens.refuerzaOposicion ?? 0) / 10,
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
