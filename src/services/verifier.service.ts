import {
  ArticleSource,
  Evidence,
  IArticle,
  Verification,
  VerificationFlag,
} from "../models/article.model";
import { normalizeUrl, truncate } from "../utils/text";

/**
 * Capa 1 del verificador: código, sin IA. "Si no está en el corpus, no existe":
 * cada cifra, enlace y nombre propio de la nota tiene que aparecer en lo que se
 * le dio al redactor. Lo que falla queda como flag para el editor; un `error`
 * impide que la nota salga sola aunque AUTO_PUBLISH esté encendido.
 *
 * Las reglas de estilo son las mínimas del manual (guion largo, paralelismo
 * negativo). La lista completa vive en REGLAS-DE-REDACCION.md de la redacción.
 */

type Checkable = Pick<
  IArticle,
  "title" | "lede" | "whyItMatters" | "keyPoints" | "body" | "bigPicture" | "whatsNext"
> & { sources?: ArticleSource[]; infographic?: IArticle["infographic"] };

const MAX_FLAGS = 15;
const MAX_TITLE = 70;

const NUMBER_WORDS: Record<string, number> = {
  uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
  nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20,
  treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80,
  noventa: 90, cien: 100, ciento: 100, mil: 1000, millon: 1, millones: 1,
};

// Palabras que arrancan una frase con mayúscula sin ser parte de un nombre.
const LEADING_WORDS = new Set([
  "el", "la", "los", "las", "un", "una", "en", "por", "para", "con", "tras", "desde",
  "segun", "este", "esta", "estos", "estas", "ese", "esa", "al", "del", "de", "y", "a",
  "hoy", "ayer", "su", "sus", "sin", "ante", "entre", "durante", "cuando", "si",
]);

const CONNECTORS = new Set(["de", "del", "la", "las", "los", "y", "e"]);

const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
  "septiembre", "octubre", "noviembre", "diciembre",
];

/** Minúsculas, sin tildes ni signos: "Asamblea Nacional," y "asamblea nacional" son lo mismo. */
function plain(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "1.200", "1,200" y "1200" son la misma cifra; "1,5" y "1.5" también. */
function canonicalNumber(raw: string): string {
  return raw.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
}

function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:[.,:]\d+)*/g) ?? []).map(canonicalNumber).filter(Boolean);
}

/** Cifras del corpus, incluidas las escritas en letras ("dos", "veinte"). */
function evidenceNumbers(text: string): Set<string> {
  const set = new Set(numbersIn(text));
  for (const word of plain(text).split(" ")) {
    const value = NUMBER_WORDS[word];
    if (value !== undefined) set.add(String(value));
  }
  return set;
}

function articleText(a: Checkable): string[] {
  return [
    a.title,
    a.lede,
    a.whyItMatters,
    ...(a.keyPoints ?? []),
    ...(a.body ?? []),
    a.bigPicture,
    a.whatsNext,
  ].filter((t): t is string => Boolean(t && t.trim()));
}

function urlsIn(text: string): string[] {
  return text.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? [];
}

/** Secuencias de dos o más palabras con mayúscula: "Corte Constitucional", "Daniel Noboa". */
function properNames(text: string): string[] {
  const words = text.split(/\s+/);
  const names: string[] = [];
  let current: string[] = [];
  const flush = () => {
    while (current.length && CONNECTORS.has(plain(current[current.length - 1]))) current.pop();
    while (current.length && LEADING_WORDS.has(plain(current[0]))) current.shift();
    const capitalized = current.filter((w) => /^[A-ZÁÉÍÓÚÑ]/.test(w));
    if (capitalized.length >= 2) names.push(current.join(" "));
    current = [];
  };
  for (const raw of words) {
    const word = raw.replace(/^[«"“(¿¡]+|[»"”).,;:!?]+$/g, "");
    // Una coma también corta: "Quito, Guayaquil" son dos nombres, no uno.
    const endsGroup = /[.,;:!?]["”»)]*$/.test(raw);
    if (/^[A-ZÁÉÍÓÚÑ][\wáéíóúñü-]+$/.test(word)) current.push(word);
    else if (current.length && CONNECTORS.has(word.toLowerCase())) current.push(word);
    else flush();
    if (endsGroup) flush();
  }
  flush();
  return [...new Set(names)];
}

interface StyleRule {
  kind: string;
  level: VerificationFlag["level"];
  label: string;
  pattern: RegExp;
}

/**
 * Las 11 reglas de REGLAS-DE-REDACCION.md (adaptación de "Signs of AI writing").
 * ERROR bloquea la salida automática; AVISO pide ojo humano. Si un tell nuevo se
 * escapa, su patrón se agrega aquí el mismo día.
 */
const STYLE_RULES: StyleRule[] = [
  { kind: "guion_largo", level: "error", label: "Guion largo", pattern: /[—–]/ },
  {
    kind: "paralelismo_negativo",
    level: "error",
    label: "Paralelismo negativo",
    pattern:
      /\bno (?:es|son|fue|fueron|era|eran|se trata de|significa)\b[^.;]{0,90}?(?:,\s*(?:sino|es|son|fue)\b|\s+sino\b)|\bno solo\b[^.]{0,90}?\bsino\b|\bmás que\b[^.]{1,60},\s*(?:es|son|fue)\b|\blejos de (?:ser|significar)\b|\bno (?:es|fue|son) [^.]{1,60}\.\s+(?:Es|Fue|Son)\b/i,
  },
  {
    kind: "inflado",
    level: "error",
    label: "Inflado de importancia",
    pattern:
      /\b(?:marca(?:n|rá|ría)? un hito|hito histórico|sin precedentes|punto de inflexión|un antes y un después|momento histórico|cambio de paradigma|dejar(?:á)? huella)\b/i,
  },
  {
    kind: "gerundio_colgado",
    level: "error",
    label: "Gerundio analítico colgado",
    pattern:
      /,\s*(?:evidenciando|reflejando|subrayando|destacando|consolidando|demostrando|poniendo de manifiesto|marcando|resaltando|confirmando|mostrando)\b[^.]*\.?$/i,
  },
  {
    kind: "atribucion_vaga",
    level: "error",
    label: "Atribución vaga",
    pattern:
      /\b(?:(?:los |algunos |varios |diversos )?(?:expertos|analistas|especialistas|observadores|críticos) (?:señalan|creen|advierten|consideran|coinciden|apuntan)|muchos (?:consideran|creen|opinan)|se dice que|hay quienes (?:dicen|creen|aseguran))\b/i,
  },
  {
    kind: "vocabulario_ia",
    level: "aviso",
    label: "Vocabulario de IA",
    pattern:
      /\b(?:cabe (?:destacar|señalar|mencionar|resaltar)|es importante (?:señalar|destacar|mencionar)|en el marco de|en un contexto (?:de|donde|en el que)|abordar|fomentar|potenciar|crucial|sinergia|ecosistema|navegar|desafíos|tapiz|robusto|integral|en este sentido|vale la pena)\b/i,
  },
  {
    kind: "rodeo_ser",
    level: "aviso",
    label: "Rodeo del verbo ser",
    pattern: /\b(?:se erige como|se posiciona como|se consolida como|constituye|representa un[ao]?)\b/i,
  },
  {
    kind: "muletilla",
    level: "error",
    label: "Muletilla o cierre de ensayo",
    pattern:
      /\b(?:en resumen|en conclusión|en definitiva|sin lugar a dudas|sin duda alguna|queda claro que|solo el tiempo dirá|el tiempo dirá|en un mundo (?:donde|en el que)|a fin de cuentas)\b/i,
  },
  {
    kind: "hedging",
    level: "aviso",
    label: "Hedging doble",
    pattern: /\b(?:podría eventualmente|posiblemente podría|quizás podría|tal vez podría|podría potencialmente)\b/i,
  },
  {
    kind: "comunicado",
    level: "aviso",
    label: "Tono de comunicado",
    pattern:
      /\b(?:reafirma(?:n)? su compromiso|se complace|en aras de|con el firme propósito|de cara a|pone(?:n)? a disposición)\b/i,
  },
  { kind: "formato", level: "error", label: "Negrilla mecánica", pattern: /\*\*[^*]+\*\*/ },
];

/** Regla de tres decorativa: tres adjetivos o sustantivos sueltos en fila por ritmo. */
// Sin bandera i: "Quito, Guayaquil y Cuenca" (nombres propios) no cuenta.
const TRIPLET = /\b([a-záéíóúñ]{4,}), ([a-záéíóúñ]{4,}) y ([a-záéíóúñ]{4,})\b(?=[.;]|$)/;

function styleFlags(paragraphs: string[]): VerificationFlag[] {
  const flags: VerificationFlag[] = [];
  for (const p of paragraphs) {
    for (const rule of STYLE_RULES) {
      const match = p.match(rule.pattern);
      if (!match) continue;
      flags.push({
        level: rule.level,
        kind: rule.kind,
        text: `${rule.label} ("${truncate(match[0].trim(), 60)}") en: "${truncate(p, 90)}"`,
      });
    }
    const triplet = p.match(TRIPLET);
    if (triplet && /(?:o|a|e|es|os|as|al|ble|ente)$/i.test(triplet[3])) {
      flags.push({
        level: "aviso",
        kind: "regla_de_tres",
        text: `Posible regla de tres decorativa ("${triplet[0]}")`,
      });
    }
  }
  return flags;
}

/** Fechas que el redactor conoce sin estar en las fuentes: hoy, en Ecuador. */
function todayText(now = new Date()): string {
  const ec = new Date(now.toLocaleString("en-US", { timeZone: "America/Guayaquil" }));
  return `${ec.getDate()} de ${MONTHS[ec.getMonth()]} de ${ec.getFullYear()} ${ec.getHours()}:${String(ec.getMinutes()).padStart(2, "0")}`;
}

export function buildEvidence(parts: string[], urls: string[] = []): Evidence {
  const text = parts.filter(Boolean).join("\n\n");
  const all = [...urls, ...urlsIn(text)].filter(Boolean);
  return { text, urls: [...new Set(all)] };
}

/**
 * Deja solo los enlaces que existen en el corpus. Un enlace inventado por la IA
 * se quita (la fuente queda nombrada sin link) y se avisa.
 */
export function keepKnownUrls(
  sources: ArticleSource[],
  evidence: Evidence,
): { sources: ArticleSource[]; flags: VerificationFlag[] } {
  const known = new Set(evidence.urls.map(normalizeUrl));
  const flags: VerificationFlag[] = [];
  const cleaned = sources.map((s) => {
    if (!s.url || known.has(normalizeUrl(s.url))) return s;
    flags.push({
      level: "aviso",
      kind: "enlace_quitado",
      text: `Se quitó el enlace de "${s.name}": no estaba entre las fuentes (${truncate(s.url, 80)})`,
    });
    return { ...s, url: "" };
  });
  return { sources: cleaned, flags };
}

function summarize(flags: VerificationFlag[]): Verification {
  const sorted = [...flags].sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1));
  return {
    checkedAt: new Date(),
    errors: flags.filter((f) => f.level === "error").length,
    warnings: flags.filter((f) => f.level === "aviso").length,
    flags: sorted.slice(0, MAX_FLAGS),
  };
}

function checkText(paragraphs: string[], evidence: Evidence): VerificationFlag[] {
  const corpus = `${evidence.text}\n${todayText()}`;
  const corpusNumbers = evidenceNumbers(corpus);
  const corpusPlain = ` ${plain(corpus)} `;
  const flags: VerificationFlag[] = [];

  const missingNumbers = new Set<string>();
  for (const p of paragraphs) {
    for (const raw of p.match(/\d+(?:[.,:]\d+)*/g) ?? []) {
      const n = canonicalNumber(raw);
      if (n && !corpusNumbers.has(n)) missingNumbers.add(raw);
    }
  }
  for (const raw of missingNumbers) {
    flags.push({
      level: "error",
      kind: "cifra",
      text: `La cifra "${raw}" no aparece en las fuentes`,
    });
  }

  const missingNames = new Set<string>();
  for (const p of paragraphs) {
    for (const name of properNames(p)) {
      if (!corpusPlain.includes(` ${plain(name)} `)) missingNames.add(name);
    }
  }
  for (const name of missingNames) {
    flags.push({
      level: "aviso",
      kind: "nombre",
      text: `"${name}" no aparece tal cual en las fuentes`,
    });
  }

  return [...flags, ...styleFlags(paragraphs)];
}

/** Verifica una nota completa contra su corpus. */
export function verifyArticle(
  article: Checkable,
  evidence: Evidence | null,
  extraFlags: VerificationFlag[] = [],
): Verification {
  const paragraphs = articleText(article);
  const flags: VerificationFlag[] = [...extraFlags];

  if (!evidence?.text?.trim()) {
    flags.push({
      level: "aviso",
      kind: "sin_corpus",
      text: "Sin corpus guardado: no se pudo comprobar cifras ni nombres contra las fuentes",
    });
    flags.push(...styleFlags(paragraphs));
  } else {
    flags.push(...checkText(paragraphs, evidence));
    const infographicNumbers = (article.infographic?.items ?? []).map((i) => String(i.value));
    const corpusNumbers = evidenceNumbers(evidence.text);
    for (const value of infographicNumbers) {
      if (!corpusNumbers.has(canonicalNumber(value))) {
        flags.push({
          level: "error",
          kind: "infografia",
          text: `El valor ${value} de la infografía no aparece en las fuentes`,
        });
      }
    }
  }

  if (article.sources && !article.sources.length) {
    flags.push({ level: "error", kind: "sin_fuentes", text: "La nota no cita ninguna fuente" });
  }
  if (article.title && article.title.length > MAX_TITLE) {
    flags.push({
      level: "aviso",
      kind: "largo",
      text: `Titular de ${article.title.length} caracteres (máximo ${MAX_TITLE})`,
    });
  }
  return summarize(flags);
}

/** Verifica un bloque de actualización contra la pieza que lo originó. */
export function verifyText(text: string, evidence: Evidence): Verification {
  return summarize(checkText([text], evidence));
}
