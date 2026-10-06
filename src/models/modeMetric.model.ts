import mongoose, { Schema } from "mongoose";
import { applyToJSON } from "../utils/toJSON";
import { READING_MODES, ReadingMode } from "../config/modes";

/**
 * Conteo diario y anónimo de modos de lectura. Solo día, modo y contadores:
 * nunca correo, IP ni identificador del navegador (LOPDP, dato sensible).
 */
export interface IModeMetric {
  day: string;
  modo: ReadingMode;
  elegir: number;
  cambiar: number;
  vistas: number;
}

const modeMetricSchema = new Schema<IModeMetric>({
  day: { type: String, required: true },
  modo: { type: String, enum: READING_MODES, required: true },
  elegir: { type: Number, default: 0 },
  cambiar: { type: Number, default: 0 },
  vistas: { type: Number, default: 0 },
});

modeMetricSchema.index({ day: 1, modo: 1 }, { unique: true });

applyToJSON(modeMetricSchema);

export const ModeMetric =
  mongoose.models.ModeMetric || mongoose.model<IModeMetric>("ModeMetric", modeMetricSchema);
