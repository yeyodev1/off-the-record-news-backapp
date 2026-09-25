import mongoose, { Schema } from "mongoose";
import { applyToJSON } from "../utils/toJSON";

export interface IPipelineRun {
  trigger: "cron" | "manual";
  startedAt: Date;
  finishedAt: Date | null;
  signalsFound: number;
  signalsNew: number;
  scored: number;
  drafted: number;
  skippedReason: string;
  errors: string[];
  createdAt?: Date;
  updatedAt?: Date;
}

const pipelineRunSchema = new Schema<IPipelineRun>(
  {
    trigger: { type: String, enum: ["cron", "manual"], default: "manual" },
    startedAt: { type: Date, default: () => new Date() },
    finishedAt: { type: Date, default: null },
    signalsFound: { type: Number, default: 0 },
    signalsNew: { type: Number, default: 0 },
    scored: { type: Number, default: 0 },
    drafted: { type: Number, default: 0 },
    skippedReason: { type: String, default: "" },
    errors: { type: [String], default: [] },
  },
  // `errors` choca con una propiedad reservada de Mongoose; se silencia a propósito.
  { timestamps: true, suppressReservedKeysWarning: true },
);

pipelineRunSchema.index({ startedAt: -1 });

applyToJSON(pipelineRunSchema);

export const PipelineRun =
  mongoose.models.PipelineRun || mongoose.model<IPipelineRun>("PipelineRun", pipelineRunSchema);
