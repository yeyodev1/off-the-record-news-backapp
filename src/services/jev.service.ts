import { env } from "../config/env";
import { Section, SECTIONS } from "../models/article.model";
import { mapLimit, truncate } from "../utils/text";
import { SignalForScoring, SignalScore, weightedTotal } from "./anthropic.service";
import { evaluate, JevAnswer, JevQuestion } from "./gateway.service";

/**
 * Jev es el editor que decide: para cada hecho responde preguntas acotadas
 * (¿es de Ecuador?, ¿ya lo publicamos?, ¿qué tan relevante es?) con
 * probabilidades. No redacta; eso lo hace Claude con lo que Jev aprueba.
 */

// Escalas de 5 peldaños (0–4) que luego se llevan a 0–10.
const QUESTIONS: Record<string, JevQuestion> = {
  ecuador: {
    type: "boolean",
    instructions: "¿El hecho ocurre en Ecuador o afecta directamente a ecuatorianos?",
    criteria: {
      true: "pasa en Ecuador, involucra a autoridades, empresas o ciudadanos ecuatorianos, o cambia algo para Ecuador",
      false:
        "hecho extranjero sin vínculo concreto con Ecuador (moda, farándula, deportes o política de otros países)",
    },
  },
  noticia: {
    type: "boolean",
    instructions: "¿Es un hecho noticioso que se puede reportar?",
    criteria: {
      true: "un hecho concreto: algo que pasó, se anunció, se aprobó o se denunció",
      false:
        "opinión, editorial, columna, cartas de lectores, portada o índice de un medio, página de archivo o listado de documentos, texto que dice que no hay información o que algo no ocurrió, horóscopo, publicidad",
    },
  },
  vigente: {
    type: "boolean",
    instructions:
      "¿El hecho ocurrió o se conoció por primera vez en las últimas 48 horas respecto a hora_actual_ecuador? Juzga por el contenido, no solo por la fecha publicado: si describe un suceso de semanas, meses o años atrás (una masacre, elección o desastre ya conocido), es antiguo aunque la nota tenga fecha de hoy.",
    criteria: {
      true: "hecho nuevo de hoy o ayer, o un desarrollo nuevo de hoy o ayer sobre un tema anterior",
      false:
        "suceso ocurrido antes de ayer, nota vieja reindexada, recuento, aniversario o resumen de hechos pasados",
    },
  },
  acusacion: {
    type: "boolean",
    instructions:
      "¿El hecho acusa a una persona o empresa nombrada de un delito, corrupción o una irregularidad?",
    criteria: {
      true: "señala a alguien con nombre como responsable o sospechoso: denuncia, allanamiento, detención, investigación, sanción",
      false: "no acusa a nadie con nombre, o la acusación es contra una institución en abstracto",
    },
  },
  familia: {
    type: "boolean",
    instructions:
      "¿El hecho trata sobre un familiar (madre, padre, hijos, pareja, hermanos, primos, tíos) del presidente de Ecuador, de un expresidente o de los alcaldes de Quito o Guayaquil?",
    criteria: {
      true: "el foco es el familiar o una denuncia que lo toca, y el familiar no es quien ejecutó el acto",
      false: "no involucra familiares de esas autoridades, o el familiar es el actor directo del hecho (firmó, decidió, contrató)",
    },
  },
  duplicado: {
    type: "boolean",
    instructions:
      "¿Este mismo hecho ya está cubierto por alguno de los titulares_publicados? Un desarrollo nuevo del mismo tema no cuenta como repetido.",
  },
  cercania: {
    type: "score",
    instructions: "¿Qué tan cerca está este hecho de la audiencia ecuatoriana?",
    criteria: [
      "sin vínculo con Ecuador",
      "vínculo lejano o indirecto",
      "afecta a una región o sector de Ecuador",
      "afecta a muchos ecuatorianos",
      "afecta a todo el país",
    ],
  },
  inmediatez: {
    type: "score",
    instructions: "¿Qué tan reciente es el hecho respecto a la hora actual?",
    criteria: ["más de una semana", "varios días", "ayer", "hoy", "última hora, en desarrollo"],
  },
  personaje: {
    type: "score",
    instructions: "¿Qué tan relevantes son las personas o instituciones públicas involucradas?",
    criteria: [
      "ninguna figura pública",
      "figura local menor",
      "autoridad local o figura conocida",
      "alto funcionario nacional, asambleístas, grandes empresas",
      "Presidente de la República, Asamblea en pleno, Corte Constitucional o figura de primer nivel",
    ],
  },
  relevancia: {
    type: "score",
    instructions: "¿Cuánto interés público tiene este hecho para Ecuador?",
    criteria: [
      "trivial",
      "curiosidad",
      "interés de un sector",
      "interés público amplio",
      "interés nacional de primer orden",
    ],
  },
  impacto: {
    type: "score",
    instructions: "¿Qué impacto económico o social tiene para las personas en Ecuador?",
    criteria: [
      "ninguno",
      "mínimo",
      "moderado",
      "alto",
      "muy alto: toca el bolsillo, la seguridad o los derechos de millones",
    ],
  },
  seccion: {
    type: "choice",
    instructions: "¿En qué sección de un medio ecuatoriano va este hecho?",
    criteria: {
      politica: "Gobierno, partidos, elecciones, Ejecutivo",
      economia: "economía nacional, precios, empleo, deuda, tarifas, petróleo",
      legislativo: "Asamblea Nacional, leyes, juicios políticos",
      seguridad: "crimen, violencia, cárceles, policía, justicia penal",
      sociedad: "salud, educación, clima, servicios, sucesos, comunidad",
      mundo: "hechos internacionales",
      negocios: "empresas, mercados, inversión, emprendimiento",
      tecnologia: "tecnología, telecomunicaciones, ciencia",
    },
  },
};

const scale = (a: JevAnswer | undefined) =>
  a?.type === "score" ? Math.round(Math.max(0, Math.min(4, a.score)) * 2.5 * 10) / 10 : 0;
const prob = (a: JevAnswer | undefined) => (a?.type === "boolean" ? a.probability : 0);
const pct = (n: number) => `${Math.round(n * 100)}%`;

function nowInEcuador(): string {
  return new Date().toLocaleString("es-EC", { timeZone: "America/Guayaquil" });
}

async function scoreOne(signal: SignalForScoring, headlines: string[]): Promise<SignalScore> {
  const answers = await evaluate(
    {
      hecho: truncate(signal.title, 200),
      resumen: truncate(signal.summary, 600),
      medio: signal.sourceName,
      publicado: signal.publishedAt ? signal.publishedAt.toISOString() : "sin fecha",
      hora_actual_ecuador: nowInEcuador(),
      titulares_publicados: headlines.slice(0, 40),
    },
    QUESTIONS,
  );

  const ecuador = prob(answers.ecuador);
  const duplicate = prob(answers.duplicado) >= env.JEV_DUPLICATE_MIN;
  let cercania = scale(answers.cercania);
  // Si Jev duda de que sea de Ecuador, la cercanía no puede ser alta: eso activa el tope del total.
  if (ecuador < env.JEV_ECUADOR_MIN) cercania = Math.min(cercania, 3);

  const parts = {
    cercania,
    inmediatez: scale(answers.inmediatez),
    personaje: scale(answers.personaje),
    relevancia: scale(answers.relevancia),
    impacto: scale(answers.impacto),
  };
  const seccion = answers.seccion?.type === "choice" ? answers.seccion.choice : "";
  const section = (SECTIONS as readonly string[]).includes(seccion)
    ? (seccion as Section)
    : "politica";

  const noticia = prob(answers.noticia);
  const vigente = prob(answers.vigente);
  return {
    ref: signal.ref,
    duplicate,
    section,
    notNews: noticia < 0.5 || vigente < 0.5,
    accusation: prob(answers.acusacion) >= 0.5,
    familyVeto: prob(answers.familia) >= 0.5,
    score: {
      ...parts,
      total: weightedTotal(parts),
      reasoning: `Jev: Ecuador ${pct(ecuador)}, hecho noticioso ${pct(noticia)}, reciente ${pct(vigente)}, repetida ${pct(prob(answers.duplicado))}, acusación ${pct(prob(answers.acusacion))}, sección ${section}.`,
    },
  };
}

/** Misma firma que la valoración de Claude, para que el ciclo pueda usar cualquiera. */
export async function scoreSignals(
  signals: SignalForScoring[],
  recentHeadlines: string[] = [],
): Promise<SignalScore[]> {
  const results = await mapLimit(signals, 8, async (s) => {
    try {
      return await scoreOne(s, recentHeadlines);
    } catch (error) {
      console.warn(
        `[jev] no se pudo valorar "${truncate(s.title, 60)}":`,
        (error as Error).message,
      );
      return null;
    }
  });
  const scored = results.filter((r): r is SignalScore => r !== null);
  // Si falló todo el lote es un problema del gateway, no de las señales: que el ciclo lo registre.
  if (signals.length && !scored.length)
    throw new Error("Jev no pudo valorar ninguna señal del lote");
  return scored;
}

/**
 * ¿Es el mismo hecho que alguno de los ya elegidos o publicados? Los titulares
 * de dos medios sobre lo mismo casi nunca comparten palabras, por eso decide Jev.
 */
export async function isSameStory(
  candidate: { title: string; summary: string },
  others: string[],
): Promise<boolean> {
  if (!others.length) return false;
  const answers = await evaluate(
    {
      hecho: truncate(candidate.title, 200),
      resumen: truncate(candidate.summary, 400),
      notas: others.slice(0, 40),
    },
    {
      mismo: {
        type: "boolean",
        instructions: "¿El hecho describe el mismo acontecimiento que alguna de las notas?",
        criteria: {
          true: "mismo acontecimiento contado por otro medio o con otras palabras",
          false: "acontecimiento distinto, aunque sea del mismo tema o institución",
        },
      },
    },
  );
  return prob(answers.mismo) >= env.JEV_DUPLICATE_MIN;
}

/**
 * ¿A cuál de los hechos abiertos pertenece esta pieza? Devuelve el ref del hecho
 * o null si es un acontecimiento nuevo. Una sola pregunta de opción: Jev ve todos
 * los candidatos a la vez y no hay que preguntarle uno por uno.
 */
export async function matchStory(
  candidate: { title: string; summary: string },
  stories: { ref: string; title: string }[],
): Promise<string | null> {
  if (!stories.length) return null;
  const NONE = "ninguno";
  const criteria: Record<string, string> = {};
  for (const s of stories) criteria[s.ref] = truncate(s.title, 160);
  criteria[NONE] = "acontecimiento distinto de todos los anteriores";
  const answers = await evaluate(
    { pieza: truncate(candidate.title, 200), resumen: truncate(candidate.summary, 400) },
    {
      hecho: {
        type: "choice",
        instructions:
          "¿La pieza cuenta el mismo acontecimiento que alguno de estos hechos? Mismo suceso contado por otro medio o un desarrollo directo de ese suceso. Un tema parecido no basta.",
        criteria,
      },
    },
  );
  const answer = answers.hecho;
  if (answer?.type !== "choice" || answer.choice === NONE) return null;
  const confidence = answer.probabilities?.[answer.choice] ?? 0;
  return confidence >= env.JEV_DUPLICATE_MIN && criteria[answer.choice] ? answer.choice : null;
}

/** Filtro barato antes de pedirle a Claude un bloque de actualización. */
export async function bringsNewFacts(
  article: { title: string; lede: string; keyPoints: string[]; updates: string[] },
  piece: { title: string; summary: string; sourceName: string },
): Promise<boolean> {
  const answers = await evaluate(
    {
      nota_publicada: {
        titular: article.title,
        entrada: article.lede,
        detalles: article.keyPoints,
        actualizaciones: article.updates,
      },
      pieza_nueva: {
        titular: truncate(piece.title, 200),
        resumen: truncate(piece.summary, 600),
        medio: piece.sourceName,
      },
    },
    {
      nuevo: {
        type: "boolean",
        instructions: "¿La pieza nueva trae un dato o desarrollo que la nota publicada todavía no cuenta?",
        criteria: {
          true: "respuesta del aludido, cifra oficial, decisión, detención, votación u otro hecho posterior",
          false: "repite lo que la nota ya dice con otras palabras",
        },
      },
    },
  );
  return prob(answers.nuevo) >= 0.6;
}
