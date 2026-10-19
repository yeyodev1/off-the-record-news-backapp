import mongoose, { Schema, Types } from "mongoose";
import { applyToJSON } from "../utils/toJSON";

/**
 * Llave del conector de gerencia. Va dentro de la URL del conector porque
 * claude.ai no deja poner encabezados en un conector propio. Solo se guarda
 * el hash: la URL completa se ve una vez, al generarla.
 */
export interface IMcpAccess {
  user: Types.ObjectId;
  email: string;
  tokenHash: string;
  /** Últimos 4 caracteres, para reconocer cuál está en uso. */
  tokenHint: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const mcpAccessSchema = new Schema<IMcpAccess>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    tokenHash: { type: String, required: true, unique: true },
    tokenHint: { type: String, default: "" },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

applyToJSON(mcpAccessSchema, ["tokenHash"]);

export const McpAccess =
  mongoose.models.McpAccess || mongoose.model<IMcpAccess>("McpAccess", mcpAccessSchema);
