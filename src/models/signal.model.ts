import mongoose, { Schema, Types } from "mongoose";
import { applyToJSON } from "../utils/toJSON";
import { ScoreBreakdown, scoreSchema } from "./article.model";

export const SIGNAL_STATUSES = ["new", "scored", "discarded", "drafted", "duplicate"] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

export interface ISignal {
  sourceId: Types.ObjectId | null;
  sourceName: string;
  title: string;
  url: string;
  summary: string;
  imageUrl: string;
  publishedAt: Date | null;
  status: SignalStatus;
  score: ScoreBreakdown | null;
  articleId: Types.ObjectId | null;
  // Hash de URL normalizada: evita guardar dos veces la misma nota.
  hash: string;
  // Hash del título normalizado: atrapa la misma nota con URL distinta.
  titleHash: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const signalSchema = new Schema<ISignal>(
  {
    sourceId: { type: Schema.Types.ObjectId, ref: "Source", default: null },
    sourceName: { type: String, default: "" },
    title: { type: String, required: true },
    url: { type: String, default: "" },
    summary: { type: String, default: "" },
    imageUrl: { type: String, default: "" },
    publishedAt: { type: Date, default: null },
    status: { type: String, enum: SIGNAL_STATUSES, default: "new" },
    score: { type: scoreSchema, default: null },
    articleId: { type: Schema.Types.ObjectId, ref: "Article", default: null },
    hash: { type: String, required: true, unique: true },
    titleHash: { type: String, default: "", index: true },
  },
  { timestamps: true },
);

signalSchema.index({ status: 1, createdAt: -1 });
signalSchema.index({ "score.total": -1 });

applyToJSON(signalSchema, ["hash", "titleHash"]);

export const Signal = mongoose.models.Signal || mongoose.model<ISignal>("Signal", signalSchema);
