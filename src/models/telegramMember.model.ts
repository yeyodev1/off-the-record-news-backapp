import mongoose, { Schema } from "mongoose";
import { applyToJSON } from "../utils/toJSON";

/**
 * Persona del equipo en Telegram. Entra con /unirme como `pending` y un
 * administrador le asigna el rol desde el panel; así sumar a alguien no
 * exige tocar variables ni redesplegar.
 */
export const TELEGRAM_ROLES = ["pending", "editor", "reporter", "disabled"] as const;
export type TelegramRole = (typeof TELEGRAM_ROLES)[number];

export interface ITelegramMember {
  telegramId: string;
  name: string;
  username: string;
  role: TelegramRole;
  lastSeenAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const telegramMemberSchema = new Schema<ITelegramMember>(
  {
    telegramId: { type: String, required: true, unique: true, index: true },
    name: { type: String, default: "" },
    username: { type: String, default: "" },
    role: { type: String, enum: TELEGRAM_ROLES, default: "pending" },
    lastSeenAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

applyToJSON(telegramMemberSchema);

export const TelegramMember =
  mongoose.models.TelegramMember ||
  mongoose.model<ITelegramMember>("TelegramMember", telegramMemberSchema);
