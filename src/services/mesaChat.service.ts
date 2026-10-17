import { AGENTS, findSection } from "../config/agents";
import { CustomError } from "../errors/customError.error";
import { LESSON_AREAS, LessonArea } from "../models/lesson.model";
import { env } from "../config/env";
import { truncate } from "../utils/text";
import * as agentConfigService from "./agentConfig.service";
import * as anthropicService from "./anthropic.service";
import * as lessonService from "./lesson.service";

/**
 * Entrenar la mesa por chat: el editor escribe en lenguaje normal qué quiere
 * cambiar y la IA propone cómo aplicarlo, sin tocar código. Dos caminos:
 *
 * - lección: una instrucción que se suma al prompt de un área (lo mismo que
 *   "Instrucciones extra", pero dictado en conversación).
 * - regla de agente: una regla nueva para una sección de un agente.
 *
 * El chat solo propone; aplicar es un segundo paso explícito. Nunca toca los
 * formatos técnicos ni la regla de no inventar datos: eso queda fijo.
 */

export type MesaChangeKind = "lesson" | "agent_rule" | "question" | "none";

export interface MesaProposal {
  kind: MesaChangeKind;
  area?: LessonArea;
  agent?: string;
  section?: string;
  instruction?: string;
  newRule?: string;
  summary: string;
}

export interface MesaChatTurn {
  role: "editor" | "mesa";
  text: string;
}

const AREA_HELP: Record<LessonArea, string> = {
  general: "aplica a todos los pasos de la mesa",
  valoracion: "qué es noticia y qué no, y cómo puntúa el valorador (Jev)",
  redaccion: "cómo se escribe la nota y sus actualizaciones",
  modos: "orden y enfoque de las miradas noboísta, correísta e independiente",
  fotos: "qué foto aporta y cuál no",
};

function agentCatalog(): string {
  const areas = LESSON_AREAS.map((a) => `  - ${a}: ${AREA_HELP[a]}`).join("\n");
  const agents = AGENTS.map((a) => {
    const sections = a.sections.map((s) => `    - ${s.key}: ${s.title} (${s.help})`).join("\n");
    return `  ${a.key} — ${a.name}: ${a.description}\n${sections}`;
  }).join("\n");
  return `Áreas de lección (para \`lesson\`):\n${areas}\n\nAgentes y sus secciones (para \`agent_rule\`):\n${agents}`;
}

function systemPrompt(): string {
  return `Eres la mesa de Off the Record, un medio de noticias de Ecuador. Un editor te habla por chat para entrenar a la IA que valora, redacta y encuadra las notas. Tu trabajo es entender qué quiere cambiar y proponer cómo aplicarlo, sin tocar código.

Tienes dos formas de aplicar un cambio:
1. "lesson": una instrucción en lenguaje normal que se suma al prompt de un área. Útil para matices, prioridades y correcciones de criterio. Elige el \`area\` que mejor corresponda.
2. "agent_rule": una regla nueva para una sección concreta de un agente. Útil cuando es una regla de oficio clara y estable. Elige \`agent\` y \`section\` del catálogo, y escribe la regla ya redactada en \`newRule\`, en el mismo estilo que las reglas del agente (una sola regla, directa).

Si lo que pide es ambiguo o te falta un dato para aplicarlo bien, usa kind "question" y en \`summary\` deja la pregunta. Si solo está conversando o lo que pide ya está cubierto, usa kind "none".

Reglas:
- Nunca propongas tocar los formatos técnicos de la nota (los campos del esquema) ni la regla de no inventar datos: eso queda fijo. Si lo piden, explícalo en \`summary\` con kind "none".
- Prefiere "lesson" cuando sea un criterio o matiz; "agent_rule" solo cuando sea una regla de oficio clara.
- \`summary\` es lo que le respondes al editor: una o dos frases, en español cercano, sin tecnicismos y SIN punto final.
- Redacta \`instruction\` y \`newRule\` claras y autosuficientes, como se las dirías a un periodista nuevo.

${agentCatalog()}`;
}

const proposalSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["lesson", "agent_rule", "question", "none"] },
    area: { type: "string", enum: [...LESSON_AREAS, ""] },
    agent: { type: "string" },
    section: { type: "string" },
    instruction: { type: "string" },
    newRule: { type: "string" },
    summary: { type: "string" },
  },
  required: ["kind", "summary"],
  additionalProperties: false,
};

function historyBlock(history: MesaChatTurn[]): string {
  if (!history.length) return "";
  const lines = history
    .slice(-8)
    .map((t) => `${t.role === "editor" ? "Editor" : "Mesa"}: ${truncate(t.text, 500)}`)
    .join("\n");
  return `Conversación hasta ahora:\n${lines}\n\n`;
}

function parseHistory(value: unknown): MesaChatTurn[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((t) => t && typeof t.text === "string")
    .map((t) => ({ role: t.role === "editor" ? "editor" : "mesa", text: String(t.text) }));
}

/** El editor escribe; la IA propone un cambio (o pregunta, o conversa). */
export async function chat(body: any): Promise<{ proposal: MesaProposal }> {
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (message.length < 2) throw new CustomError("Escribe lo que quieres cambiar", 400);
  if (message.length > 1500) throw new CustomError("El mensaje es demasiado largo", 400);
  const history = parseHistory(body?.history);

  const raw = await anthropicService.callJson<MesaProposal>({
    model: env.AI_WRITING_MODEL,
    system: systemPrompt(),
    prompt: `${historyBlock(history)}Editor: ${message}`,
    schema: proposalSchema,
    maxTokens: 1200,
  });

  return { proposal: normalize(raw) };
}

function normalize(raw: MesaProposal): MesaProposal {
  const summary = truncate(String(raw.summary ?? "").trim(), 600) || "Listo";
  if (raw.kind === "lesson") {
    const area = (LESSON_AREAS as readonly string[]).includes(raw.area as string)
      ? (raw.area as LessonArea)
      : "general";
    const instruction = String(raw.instruction ?? "").trim();
    if (instruction.length < 5) return { kind: "none", summary };
    return { kind: "lesson", area, instruction: truncate(instruction, 600), summary };
  }
  if (raw.kind === "agent_rule") {
    const def = raw.agent && raw.section ? findSection(raw.agent, raw.section) : null;
    const newRule = String(raw.newRule ?? "").trim();
    if (!def || newRule.length < 3) return { kind: "none", summary };
    return {
      kind: "agent_rule",
      agent: raw.agent,
      section: raw.section,
      newRule: truncate(newRule, 800),
      summary,
    };
  }
  if (raw.kind === "question") return { kind: "question", summary };
  return { kind: "none", summary };
}

/** El editor confirma: se guarda la lección o se agrega la regla al agente. */
export async function apply(body: any, userId?: string) {
  const p = body?.proposal ?? body;
  const kind = p?.kind;

  if (kind === "lesson") {
    const lesson = await lessonService.create(
      { area: p.area, instruction: p.instruction },
      userId,
    );
    return { applied: "lesson" as const, lesson };
  }

  if (kind === "agent_rule") {
    const def = p.agent && p.section ? findSection(p.agent, p.section) : null;
    if (!def) throw new CustomError("Sección de agente no encontrada", 404);
    const rule = String(p.newRule ?? "").trim();
    if (rule.length < 3) throw new CustomError("La regla está vacía", 400);
    const current = await agentConfigService.rules(p.agent, p.section);
    const section = await agentConfigService.save(
      p.agent,
      p.section,
      { rules: [...current, rule] },
      userId,
    );
    return { applied: "agent_rule" as const, agent: p.agent, section };
  }

  throw new CustomError("No hay nada que aplicar", 400);
}
