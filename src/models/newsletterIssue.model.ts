import mongoose, { Schema, Types } from "mongoose";

import { EDITIONS, Edition } from "./subscriber.model";

export interface INewsletterIssue {
  edition: Edition;
  subject: string;
  intro: string;
  html: string;
  /** La misma edición ordenada para cada modo (solo para quien consintió guardar su modo). */
  htmlByMode: Record<string, string>;
  articleIds: Types.ObjectId[];
  status: "draft" | "sent";
  recipients: number;
  sentAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const newsletterIssueSchema = new Schema<INewsletterIssue>(
  {
    edition: { type: String, enum: EDITIONS, required: true },
    subject: { type: String, default: "" },
    intro: { type: String, default: "" },
    html: { type: String, default: "" },
    htmlByMode: { type: Schema.Types.Mixed, default: () => ({}) },
    articleIds: [{ type: Schema.Types.ObjectId, ref: "Article" }],
    status: { type: String, enum: ["draft", "sent"], default: "draft" },
    recipients: { type: Number, default: 0 },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true },
);

newsletterIssueSchema.index({ createdAt: -1 });

// El panel ve la versión independiente, sin el hueco del enlace "Borrar mi modo";
// las variantes por modo solo se usan al enviar.
newsletterIssueSchema.set("toJSON", {
  virtuals: false,
  versionKey: false,
  transform: (_doc, raw) => {
    const ret = raw as unknown as Record<string, unknown>;
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.htmlByMode;
    if (typeof ret.html === "string") ret.html = ret.html.replace("{{FORGET_MODE}}", "");
    return ret;
  },
});

export const NewsletterIssue =
  mongoose.models.NewsletterIssue ||
  mongoose.model<INewsletterIssue>("NewsletterIssue", newsletterIssueSchema);
