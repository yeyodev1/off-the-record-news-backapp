import { FRAMED_MODES, ReadingMode } from "../config/modes";
import { Article, Framing } from "../models/article.model";
import { truncate } from "../utils/text";
import { writeFraming } from "./anthropic.service";
import * as verifierService from "./verifier.service";

/**
 * Encuadre por mirada (reunión del 13/10/2026): noboísta y correísta leen el
 * mismo hecho con su titular, entrada, "Por qué importa", detalles y cuerpo.
 * Independiente es el texto base. El corpus de cada encuadre es la nota base: un encuadre con
 * una cifra o un nombre que la nota no tiene se descarta y esa mirada ve el
 * texto base. Así un modo nunca afirma algo que el otro no.
 */

interface Frameable {
  title: string;
  lede: string;
  whyItMatters: string;
  keyPoints: string[];
  body: string[];
  bigPicture?: string;
  whatsNext?: string;
}

function baseCorpus(doc: Frameable, extra = "") {
  return verifierService.buildEvidence([
    doc.title,
    doc.lede,
    doc.whyItMatters,
    ...doc.keyPoints,
    ...doc.body,
    doc.bigPicture ?? "",
    doc.whatsNext ?? "",
    extra,
  ]);
}

/** Sube cuando cambia lo que se encuadra: el cron rehace las notas recientes con la versión vieja. */
const FRAMING_VERSION = 2;

/** "" si el texto pasa el verificador; si no, lo que encontró. */
function passes(texts: string[], corpus: ReturnType<typeof verifierService.buildEvidence>): string {
  const check = verifierService.verifyText(texts.join("\n"), corpus);
  const inventsName = check.flags.some((f) => f.kind === "nombre");
  if (!check.errors && !inventsName) return "";
  return check.flags.map((f) => f.text).join("; ") || "error del verificador";
}

const cleanList = (items: string[] | undefined) =>
  (items ?? []).map((t) => t.trim()).filter(Boolean);

function clean(item: Framing): Framing {
  return {
    title: truncate(item.title.trim().replace(/\.$/, ""), 90),
    lede: item.lede.trim(),
    whyItMatters: item.whyItMatters.trim(),
    keyPoints: cleanList(item.keyPoints),
    body: cleanList(item.body),
  };
}

/** Nunca lanza: si la IA falla, la nota queda sin encuadre y todos leen el texto base. */
export async function frameDoc(doc: any): Promise<boolean> {
  try {
    const draft = await writeFraming(doc);
    const corpus = baseCorpus(doc, doc.evidence?.text ?? "");
    const framing: Record<string, Framing | number | null> = { version: FRAMING_VERSION };
    for (const mode of FRAMED_MODES) {
      const item = clean(draft[mode]);
      const head = passes([item.title, item.lede, item.whyItMatters], corpus);
      if (!item.title || head) {
        console.warn(`[encuadre] ${mode} descartado en "${doc.title}": ${head}`);
        framing[mode] = null;
        continue;
      }
      // Un cuerpo con un dato de más no tumba el titular: esa mirada lee el cuerpo base.
      const body = passes([...item.keyPoints, ...item.body], corpus);
      if (body) {
        console.warn(`[encuadre] cuerpo ${mode} descartado en "${doc.title}": ${body}`);
        item.keyPoints = [];
        item.body = [];
      }
      framing[mode] = item;
    }
    doc.framing = framing;
    return true;
  } catch (error) {
    console.warn(`[encuadre] "${doc.title}": ${(error as Error).message}`);
    return false;
  }
}

/**
 * Para el cron: notas publicadas recientes sin encuadre, o con el de antes del
 * 13/10 (solo titular y entrada: sin cuerpo propio no cambiaba la redacción).
 */
export async function backfill(limit = 4, deadline = Date.now() + 60_000): Promise<number> {
  const since = new Date(Date.now() - 3 * 24 * 3600_000);
  const docs = await Article.find({
    status: "published",
    publishedAt: { $gte: since },
    $or: [{ framing: null }, { "framing.version": { $ne: FRAMING_VERSION } }],
  })
    .sort({ publishedAt: -1 })
    .limit(limit);
  let done = 0;
  for (const doc of docs) {
    if (Date.now() > deadline) break;
    if (await frameDoc(doc)) {
      await doc.save();
      done++;
    }
  }
  return done;
}

/** Aplica al JSON público el encuadre del modo del lector y quita los datos internos. */
export function applyFraming(json: Record<string, any>, mode: ReadingMode | null) {
  const item = mode && mode !== "independiente" ? json.framing?.[mode] : null;
  if (item?.title) {
    json.title = item.title;
    json.lede = item.lede || json.lede;
    json.whyItMatters = item.whyItMatters || json.whyItMatters;
    if (item.keyPoints?.length) json.keyPoints = item.keyPoints;
    if (item.body?.length && json.body?.length) json.body = item.body;
  }
  delete json.framing;
  delete json.followUps;
  return json;
}
