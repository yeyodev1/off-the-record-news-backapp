import { isValidObjectId } from "mongoose";
import { AGENTS, findSection, MAX_RULE_CHARS, MAX_RULES } from "../config/agents";
import { CustomError } from "../errors/customError.error";
import { AgentConfig } from "../models/agentConfig.model";
import { User } from "../models/user.model";

/**
 * Reglas vigentes de cada agente: lo que la Mesa guardó o, si no tocó la
 * sección, el original. Caché corta como las lecciones: el ciclo pide reglas
 * en cada llamada a la IA.
 */

const CACHE_MS = 60_000;
let cache: { at: number; byKey: Map<string, any> } | null = null;

const keyOf = (agent: string, section: string) => `${agent}/${section}`;

async function saved(): Promise<Map<string, any>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.byKey;
  const docs = await AgentConfig.find().lean();
  const byKey = new Map(docs.map((d: any) => [keyOf(d.agent, d.section), d]));
  cache = { at: Date.now(), byKey };
  return byKey;
}

/** Nunca rompe el ciclo: sin Mongo, el original. */
export async function rules(agent: string, section: string): Promise<string[]> {
  const def = findSection(agent, section);
  if (!def) throw new Error(`Sección de agente desconocida: ${agent}/${section}`);
  try {
    const doc = (await saved()).get(keyOf(agent, section));
    return doc ? doc.rules : def.rules;
  } catch (error) {
    console.warn("[agentes] no se pudieron leer las reglas:", (error as Error).message);
    return def.rules;
  }
}

/** Reglas como viñetas, listas para el prompt. */
export async function bullets(agent: string, section: string): Promise<string> {
  const list = await rules(agent, section);
  return list.length ? list.map((r) => `- ${r}`).join("\n") : "- (sin reglas)";
}

// ——— Admin

function view(agent: string, sectionKey: string, doc: any) {
  const def = findSection(agent, sectionKey)!;
  return {
    key: def.key,
    title: def.title,
    help: def.help,
    rules: doc ? doc.rules : def.rules,
    defaults: def.rules,
    isDefault: !doc,
    updatedByName: doc?.updatedByName ?? "",
    updatedAt: doc?.updatedAt ?? null,
  };
}

export async function list() {
  const docs = await AgentConfig.find().lean();
  const byKey = new Map(docs.map((d: any) => [keyOf(d.agent, d.section), d]));
  return AGENTS.map((a) => ({
    key: a.key,
    name: a.name,
    description: a.description,
    sections: a.sections.map((s) => view(a.key, s.key, byKey.get(keyOf(a.key, s.key)))),
  }));
}

function parseRules(value: unknown): string[] {
  if (!Array.isArray(value)) throw new CustomError("Las reglas tienen que ser una lista", 400);
  const out = value.map((r) => (typeof r === "string" ? r.trim() : "")).filter(Boolean);
  if (out.length > MAX_RULES)
    throw new CustomError(`Una sección puede tener hasta ${MAX_RULES} reglas`, 400);
  for (const r of out) {
    if (r.length < 3) throw new CustomError("Hay una regla demasiado corta", 400);
    if (r.length > MAX_RULE_CHARS)
      throw new CustomError(`Cada regla puede tener hasta ${MAX_RULE_CHARS} caracteres`, 400);
  }
  return out;
}

function requireSection(agent: string, section: string) {
  if (!findSection(agent, section)) throw new CustomError("Sección no encontrada", 404);
}

export async function save(agent: string, section: string, body: any, userId?: string) {
  requireSection(agent, section);
  const user =
    userId && isValidObjectId(userId) ? await User.findById(userId).select("name email") : null;
  const doc = await AgentConfig.findOneAndUpdate(
    { agent, section },
    { rules: parseRules(body?.rules), updatedByName: user?.name || user?.email || "" },
    { new: true, upsert: true },
  ).lean();
  cache = null;
  return view(agent, section, doc);
}

export async function reset(agent: string, section: string) {
  requireSection(agent, section);
  await AgentConfig.deleteOne({ agent, section });
  cache = null;
  return view(agent, section, null);
}
