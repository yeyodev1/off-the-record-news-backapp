import mongoose, { Schema } from "mongoose";
import { applyToJSON } from "../utils/toJSON";

/** Reglas de una sección de un agente editadas por la Mesa. Sin documento = original de config/agents.ts. */
export interface IAgentConfig {
  agent: string;
  section: string;
  rules: string[];
  updatedByName: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const agentConfigSchema = new Schema<IAgentConfig>(
  {
    agent: { type: String, required: true },
    section: { type: String, required: true },
    rules: { type: [String], default: [] },
    updatedByName: { type: String, default: "" },
  },
  { timestamps: true },
);

agentConfigSchema.index({ agent: 1, section: 1 }, { unique: true });

applyToJSON(agentConfigSchema);

export const AgentConfig =
  mongoose.models.AgentConfig || mongoose.model<IAgentConfig>("AgentConfig", agentConfigSchema);
