import { FRAMED_MODES, ReadingMode } from "../config/modes";
import { Article, Framing } from "../models/article.model";
import { truncate } from "../utils/text";
import { writeFraming } from "./anthropic.service";
import * as verifierService from "./verifier.service";

/**
 * Encuadre por mirada (reunión del 13/10/2026): noboísta y correísta leen el
 * mismo hecho con su titular, su entrada y su "Por qué importa". Independiente
 * es el texto base. El corpus de cada encuadre es la nota base: un encuadre con
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

function clean(item: Framing): Framing {
  return {
    title: truncate(item.title.trim().replace(/\.$/, ""), 90),
    lede: item.lede.trim(),
    whyItMatters: item.whyItMatters.trim(),
  };
}

/** Nunca lanza: si la IA falla, la nota queda sin encuadre y todos leen el texto base. */
export async function frameDoc(doc: any): Promise<boolean> {
  try {
    const draft = await writeFraming(doc);
    const corpus = baseCorpus(doc, doc.evidence?.text ?? "");
    const framing: Record<string, Framing | null> = {};
    for (const mode of FRAMED_MODES) {
      const item = clean(draft[mode]);
      const check = verifierService.verifyText(
        [item.title, item.lede, item.whyItMatters].join("\n"),
        corpus,
      );
      const inventsName = check.flags.some((f) => f.kind === "nombre");
      framing[mode] = item.title && !check.errors && !inventsName ? item : null;
      if (!framing[mode]) {
        console.warn(
          `[encuadre] ${mode} descartado en "${doc.title}": ${check.flags.map((f) => f.text).join("; ")}`,
        );
      }
    }
    doc.framing = framing;
    return true;
  } catch (error) {
    console.warn(`[encuadre] "${doc.title}": ${(error as Error).message}`);
    return false;
  }
}

/** Para el cron: notas publicadas recientes que todavía no tienen encuadre. */
export async function backfill(limit = 4, deadline = Date.now() + 60_000): Promise<number> {
  const since = new Date(Date.now() - 3 * 24 * 3600_000);
  const docs = await Article.find({
    status: "published",
    framing: null,
    publishedAt: { $gte: since },
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
  }
  delete json.framing;
  delete json.followUps;
  return json;
}
