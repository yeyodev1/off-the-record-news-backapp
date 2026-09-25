import mongoose, { Schema } from "mongoose";
import { applyToJSON } from "../utils/toJSON";

export const TIP_CHANNELS = ["telegram", "web"] as const;
export const TIP_STATUSES = ["new", "reviewing", "used", "discarded"] as const;
export type TipStatus = (typeof TIP_STATUSES)[number];

export interface ITip {
  channel: (typeof TIP_CHANNELS)[number];
  name: string;
  contact: string;
  text: string;
  mediaUrls: string[];
  status: TipStatus;
  createdAt?: Date;
  updatedAt?: Date;
}

const tipSchema = new Schema<ITip>(
  {
    channel: { type: String, enum: TIP_CHANNELS, default: "web" },
    name: { type: String, default: "" },
    contact: { type: String, default: "" },
    text: { type: String, required: true },
    mediaUrls: { type: [String], default: [] },
    status: { type: String, enum: TIP_STATUSES, default: "new" },
  },
  { timestamps: true },
);

tipSchema.index({ status: 1, createdAt: -1 });

applyToJSON(tipSchema);

export const Tip = mongoose.models.Tip || mongoose.model<ITip>("Tip", tipSchema);
