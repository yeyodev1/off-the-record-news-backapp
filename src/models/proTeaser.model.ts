import mongoose, { Schema } from "mongoose";
import { applyToJSON } from "../utils/toJSON";
import { Section, SECTIONS } from "./article.model";

/**
 * Tráiler de una nota de OTR PRO en la portada gratuita. Solo el titular y el
 * "Por qué importa" salen al público: el material reservado (`sourceText`)
 * nunca viaja al navegador, ni difuminado.
 */
export const TEASER_STATUSES = ["draft", "published", "archived"] as const;
export type TeaserStatus = (typeof TEASER_STATUSES)[number];

export interface IProTeaser {
  title: string;
  whyItMatters: string;
  section: Section;
  sourceText: string;
  status: TeaserStatus;
  publishedAt: Date | null;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const proTeaserSchema = new Schema<IProTeaser>(
  {
    title: { type: String, required: true, trim: true },
    whyItMatters: { type: String, default: "" },
    section: { type: String, enum: SECTIONS, default: "politica" },
    sourceText: { type: String, default: "", select: false },
    status: { type: String, enum: TEASER_STATUSES, default: "draft" },
    publishedAt: { type: Date, default: null },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true },
);

proTeaserSchema.index({ status: 1, publishedAt: -1 });
applyToJSON(proTeaserSchema, ["sourceText"]);

export const ProTeaser =
  mongoose.models.ProTeaser || mongoose.model<IProTeaser>("ProTeaser", proTeaserSchema);
