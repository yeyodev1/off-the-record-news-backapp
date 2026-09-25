import mongoose, { Schema } from "mongoose";
import { applyToJSON } from "../utils/toJSON";

export const SOURCE_KINDS = ["rss", "perplexity", "web"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_CATEGORIES = ["medio", "periodista", "politico", "institucion"] as const;
export type SourceCategory = (typeof SOURCE_CATEGORIES)[number];

export interface ISource {
  name: string;
  kind: SourceKind;
  category: SourceCategory;
  url: string;
  query: string;
  weight: number;
  isActive: boolean;
  lastCheckedAt: Date | null;
  lastError: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const sourceSchema = new Schema<ISource>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    kind: { type: String, enum: SOURCE_KINDS, default: "rss" },
    category: { type: String, enum: SOURCE_CATEGORIES, default: "medio" },
    url: { type: String, default: "" },
    query: { type: String, default: "" },
    weight: { type: Number, default: 1, min: 0.5, max: 2 },
    isActive: { type: Boolean, default: true },
    lastCheckedAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
  },
  { timestamps: true },
);

applyToJSON(sourceSchema);

export const Source = mongoose.models.Source || mongoose.model<ISource>("Source", sourceSchema);
