import { CustomError } from "../errors/customError.error";
import { parseMode, READING_MODES, ReadingMode } from "../config/modes";
import { Article } from "../models/article.model";
import { ModeMetric } from "../models/modeMetric.model";

// Ecuador no tiene horario de verano: UTC-5 fijo.
const EC_OFFSET_MS = 5 * 3600_000;

function ecuadorDay(date = new Date()): string {
  return new Date(date.getTime() - EC_OFFSET_MS).toISOString().slice(0, 10);
}

const EVENTS = ["elegir", "cambiar", "vistas"] as const;
type ModeEvent = (typeof EVENTS)[number];

/** Suma un evento anónimo. Nunca guarda nada que identifique a quien lee. */
export async function track(modoRaw: unknown, eventRaw: unknown) {
  const modo = parseMode(modoRaw);
  const event = String(eventRaw ?? "") as ModeEvent;
  if (!modo || !EVENTS.includes(event)) throw new CustomError("Evento inválido", 400);
  await ModeMetric.updateOne(
    { day: ecuadorDay(), modo },
    { $inc: { [event]: 1 } },
    { upsert: true },
  );
}

/** Para el panel: distribución, meta del 20 % partidista y termómetro de orillas. */
export async function stats(daysRaw: unknown) {
  const days = Math.min(365, Math.max(1, Number(daysRaw) || 60));
  const since = ecuadorDay(new Date(Date.now() - days * 24 * 3600_000));

  const rows = await ModeMetric.aggregate([
    { $match: { day: { $gte: since } } },
    {
      $group: {
        _id: "$modo",
        elegir: { $sum: "$elegir" },
        cambiar: { $sum: "$cambiar" },
        vistas: { $sum: "$vistas" },
      },
    },
  ]);
  const byMode = new Map(rows.map((r) => [r._id as ReadingMode, r]));
  const distribution = READING_MODES.map((modo) => ({
    modo,
    elegir: byMode.get(modo)?.elegir ?? 0,
    cambiar: byMode.get(modo)?.cambiar ?? 0,
    vistas: byMode.get(modo)?.vistas ?? 0,
  }));
  const chosen = distribution.reduce((sum, d) => sum + d.elegir, 0);
  const partisan = distribution
    .filter((d) => d.modo === "noboista" || d.modo === "correista")
    .reduce((sum, d) => sum + d.elegir, 0);

  // Termómetro: qué leyó cada orilla en la última semana.
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000);
  const thermometer = Object.fromEntries(
    await Promise.all(
      READING_MODES.map(async (modo) => {
        const docs = await Article.find({
          status: "published",
          publishedAt: { $gte: weekAgo },
          [`viewsByMode.${modo}`]: { $gt: 0 },
        })
          .sort({ [`viewsByMode.${modo}`]: -1 })
          .limit(5)
          .select("slug title viewsByMode");
        return [
          modo,
          docs.map((d: any) => ({ slug: d.slug, title: d.title, views: d.viewsByMode?.[modo] ?? 0 })),
        ];
      }),
    ),
  );

  const [total, corrected] = await Promise.all([
    Article.countDocuments({ modeRelevanceAuto: { $ne: null } }),
    Article.countDocuments({ modeRelevanceEditedBy: { $nin: ["", null] } }),
  ]);

  return {
    days,
    distribution,
    partisanShare: chosen ? partisan / chosen : 0,
    thermometer,
    golden: { total, corrected },
  };
}

/** Golden set: lo que propuso el sistema contra lo que corrigió la Mesa. */
export async function golden() {
  const docs = await Article.find({ modeRelevanceEditedBy: { $nin: ["", null] } })
    .sort({ updatedAt: -1 })
    .limit(500)
    .select("slug title lens modeRelevance modeRelevanceAuto modeRelevanceEditedBy score");
  return docs.map((d: any) => ({
    id: String(d._id),
    slug: d.slug,
    title: d.title,
    general: d.score?.total ?? null,
    auto: d.modeRelevanceAuto,
    corrected: d.modeRelevance,
    by: d.modeRelevanceEditedBy,
    lens: d.lens,
  }));
}
