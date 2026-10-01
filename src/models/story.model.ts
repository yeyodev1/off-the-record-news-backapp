import mongoose, { Schema, Types } from "mongoose";
import { applyToJSON } from "../utils/toJSON";
import { ScoreBreakdown, scoreSchema, Section, SECTIONS } from "./article.model";

/**
 * Un hecho: el mismo acontecimiento contado por varios medios. Las señales se
 * agrupan aquí y la mesa decide sobre el hecho, no sobre cada titular suelto.
 *
 * - ready: pasa el umbral y cumple las reglas; espera redacción.
 * - watchlist: interesante pero le falta puntaje o corroboración.
 * - covered: ya tiene nota (por aprobar o publicada); lo nuevo propone actualizaciones.
 * - archived: bajo el puntaje de observación. Sigue recibiendo señales y puede subir.
 * - blocked: toca la familia vetada; nunca se redacta solo, un humano decide desde el panel.
 * - discarded: repetido con una nota anterior al sistema de hechos, o descartado a mano.
 */
export const STORY_STATUSES = [
  "ready",
  "watchlist",
  "covered",
  "archived",
  "blocked",
  "discarded",
] as const;
export type StoryStatus = (typeof STORY_STATUSES)[number];

export interface IStory {
  title: string;
  summary: string;
  /** Últimos titulares que entraron: el agrupador compara contra ellos. */
  titles: string[];
  status: StoryStatus;
  reason: string;
  score: number;
  bestScore: ScoreBreakdown | null;
  section: Section;
  signalCount: number;
  sourceNames: string[];
  hasOfficialSource: boolean;
  accusation: boolean;
  familyVeto: boolean;
  /** "Esperar más fuentes": no vuelve a redactarse hasta superar este conteo de señales. */
  holdUntilCount: number;
  firstSignalAt: Date;
  lastSignalAt: Date;
  articleId: Types.ObjectId | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const storySchema = new Schema<IStory>(
  {
    title: { type: String, required: true },
    summary: { type: String, default: "" },
    titles: { type: [String], default: [] },
    status: { type: String, enum: STORY_STATUSES, default: "archived" },
    reason: { type: String, default: "" },
    score: { type: Number, default: 0 },
    bestScore: { type: scoreSchema, default: null },
    section: { type: String, enum: SECTIONS, default: "politica" },
    signalCount: { type: Number, default: 0 },
    sourceNames: { type: [String], default: [] },
    hasOfficialSource: { type: Boolean, default: false },
    accusation: { type: Boolean, default: false },
    familyVeto: { type: Boolean, default: false },
    holdUntilCount: { type: Number, default: 0 },
    firstSignalAt: { type: Date, default: () => new Date() },
    lastSignalAt: { type: Date, default: () => new Date() },
    articleId: { type: Schema.Types.ObjectId, ref: "Article", default: null, index: true },
  },
  { timestamps: true },
);

storySchema.index({ status: 1, lastSignalAt: -1 });
storySchema.index({ lastSignalAt: -1 });

applyToJSON(storySchema);

export const Story = mongoose.models.Story || mongoose.model<IStory>("Story", storySchema);
