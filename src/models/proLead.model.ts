import mongoose, { Schema } from "mongoose";
import { applyToJSON } from "../utils/toJSON";

/**
 * Empresa interesada en OTR PRO. La venta es casi automática: la persona elige
 * plan y, si quiere, pide una reunión con un ejecutivo. Nunca se cruza con el
 * modo de lectura (§6 del spec).
 */
export const PRO_PLANS = ["semanal", "diario"] as const;
export type ProPlan = (typeof PRO_PLANS)[number];
export const LEAD_STATUSES = ["new", "contacted", "meeting", "won", "lost"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export interface IProLead {
  name: string;
  email: string;
  phone: string;
  company: string;
  role: string;
  plan: ProPlan;
  wantsMeeting: boolean;
  message: string;
  status: LeadStatus;
  createdAt?: Date;
  updatedAt?: Date;
}

const proLeadSchema = new Schema<IProLead>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, default: "" },
    company: { type: String, required: true, trim: true },
    role: { type: String, default: "" },
    plan: { type: String, enum: PRO_PLANS, default: "semanal" },
    wantsMeeting: { type: Boolean, default: false },
    message: { type: String, default: "" },
    status: { type: String, enum: LEAD_STATUSES, default: "new" },
  },
  { timestamps: true },
);

proLeadSchema.index({ status: 1, createdAt: -1 });
applyToJSON(proLeadSchema);

export const ProLead =
  mongoose.models.ProLead || mongoose.model<IProLead>("ProLead", proLeadSchema);
