import mongoose, { Schema, Types } from "mongoose";
import { applyToJSON } from "../utils/toJSON";
import { EDITIONS, Edition } from "./subscriber.model";

export interface INewsletterIssue {
  edition: Edition;
  subject: string;
  intro: string;
  html: string;
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
    articleIds: [{ type: Schema.Types.ObjectId, ref: "Article" }],
    status: { type: String, enum: ["draft", "sent"], default: "draft" },
    recipients: { type: Number, default: 0 },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true },
);

newsletterIssueSchema.index({ createdAt: -1 });

applyToJSON(newsletterIssueSchema);

export const NewsletterIssue =
  mongoose.models.NewsletterIssue ||
  mongoose.model<INewsletterIssue>("NewsletterIssue", newsletterIssueSchema);
