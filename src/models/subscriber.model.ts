import crypto from "crypto";
import mongoose, { Schema } from "mongoose";
import { applyToJSON } from "../utils/toJSON";

export const EDITIONS = ["manana", "noche", "economia", "legislativo"] as const;
export type Edition = (typeof EDITIONS)[number];

export const PLANS = ["newsletter", "pro"] as const;
export type Plan = (typeof PLANS)[number];

export const SUBSCRIBER_STATUSES = ["pending_payment", "active", "canceled", "expired"] as const;
export type SubscriberStatus = (typeof SUBSCRIBER_STATUSES)[number];

export interface ISubscriber {
  email: string;
  name: string;
  plan: Plan;
  editions: Edition[];
  status: SubscriberStatus;
  company: string;
  paidUntil: Date | null;
  unsubscribeToken: string;
  /** Modo de lectura cifrado. Solo existe con consentimiento explícito y separado. */
  readingModeSealed: string;
  modeConsentAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const subscriberSchema = new Schema<ISubscriber>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, default: "" },
    plan: { type: String, enum: PLANS, default: "newsletter" },
    editions: { type: [String], enum: EDITIONS, default: ["manana"] },
    status: { type: String, enum: SUBSCRIBER_STATUSES, default: "pending_payment" },
    company: { type: String, default: "" },
    paidUntil: { type: Date, default: null },
    unsubscribeToken: {
      type: String,
      unique: true,
      default: () => crypto.randomBytes(24).toString("hex"),
    },
    readingModeSealed: { type: String, default: "" },
    modeConsentAt: { type: Date, default: null },
  },
  { timestamps: true },
);

subscriberSchema.index({ status: 1, editions: 1 });

// El modo nunca sale en el API, ni siquiera al panel: es dato sensible.
applyToJSON(subscriberSchema, ["unsubscribeToken", "readingModeSealed"]);

export const Subscriber =
  mongoose.models.Subscriber || mongoose.model<ISubscriber>("Subscriber", subscriberSchema);
