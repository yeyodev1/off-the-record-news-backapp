import mongoose, { Schema } from "mongoose";
import { applyToJSON } from "../utils/toJSON";

/** Configuración del bot que cambia sin redesplegar: hoy, cuál es el grupo Mesa. */
export interface ITelegramConfig {
  key: string;
  mesaChatId: string;
  mesaTitle: string;
  mesaSetBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const telegramConfigSchema = new Schema<ITelegramConfig>(
  {
    key: { type: String, required: true, unique: true, default: "main" },
    mesaChatId: { type: String, default: "" },
    mesaTitle: { type: String, default: "" },
    mesaSetBy: { type: String, default: "" },
  },
  { timestamps: true },
);

applyToJSON(telegramConfigSchema);

export const TelegramConfig =
  mongoose.models.TelegramConfig ||
  mongoose.model<ITelegramConfig>("TelegramConfig", telegramConfigSchema);
