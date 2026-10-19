import mongoose, { Schema } from "mongoose";
import { applyToJSON } from "../utils/toJSON";

/** Bitácora de cada commit que hizo el conector de gerencia: quién, qué y dónde. */
export const MCP_REPOS = ["back", "front"] as const;
export type McpRepo = (typeof MCP_REPOS)[number];

export interface IMcpChange {
  email: string;
  repo: McpRepo;
  kind: "cambio" | "deshacer";
  message: string;
  sha: string;
  url: string;
  files: string[];
  createdAt?: Date;
}

const mcpChangeSchema = new Schema<IMcpChange>(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    repo: { type: String, enum: MCP_REPOS, required: true },
    kind: { type: String, enum: ["cambio", "deshacer"], default: "cambio" },
    message: { type: String, default: "" },
    sha: { type: String, required: true },
    url: { type: String, default: "" },
    files: { type: [String], default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

mcpChangeSchema.index({ createdAt: -1 });
applyToJSON(mcpChangeSchema);

export const McpChange =
  mongoose.models.McpChange || mongoose.model<IMcpChange>("McpChange", mcpChangeSchema);
