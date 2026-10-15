import { isValidObjectId } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Lesson, LESSON_AREAS, LESSON_VERDICTS, LessonArea } from "../models/lesson.model";
import { User } from "../models/user.model";
import { truncate } from "../utils/text";

/**
 * Instrucciones de la Mesa para la IA. Se leen en cada paso del ciclo; una caché
 * corta evita ir a Mongo por cada señal, y escribir la limpia en esta instancia.
 * Otras instancias de Vercel la renuevan solas al minuto.
 */

const CACHE_MS = 60_000;
// Tope por área: el prompt de Jev tiene 32k tokens para el estado.
const MAX_PER_AREA = 40;
let cache: { at: number; items: any[] } | null = null;

async function activeLessons(): Promise<any[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.items;
  const items = await Lesson.find({ active: true }).sort({ createdAt: -1 }).lean();
  cache = { at: Date.now(), items };
  return items;
}

const VERDICT_TEXT: Record<string, string> = {
  es_noticia: "sí era noticia",
  no_es_noticia: "no era noticia",
};

function asLine(lesson: any): string {
  const example = lesson.example?.title
    ? ` (caso: «${truncate(lesson.example.title, 140)}»${VERDICT_TEXT[lesson.example.verdict] ? ` → ${VERDICT_TEXT[lesson.example.verdict]}` : ""})`
    : "";
  return `${truncate(lesson.instruction, 500)}${example}`;
}

/** Las instrucciones de un paso, más las generales. Nunca rompe el ciclo: sin Mongo, sin lecciones. */
export async function linesFor(area: LessonArea): Promise<string[]> {
  try {
    const items = await activeLessons();
    return items
      .filter((l) => l.area === area || l.area === "general")
      .slice(0, MAX_PER_AREA)
      .map(asLine);
  } catch (error) {
    console.warn("[lecciones] no se pudieron leer:", (error as Error).message);
    return [];
  }
}

/** Bloque para sumar al prompt de sistema. Vacío si no hay instrucciones. */
export async function blockFor(area: LessonArea): Promise<string> {
  const lines = await linesFor(area);
  if (!lines.length) return "";
  return `

Instrucciones de la Mesa de Off the Record (las escribieron los editores; tienen prioridad sobre las reglas generales de arriba, salvo las de no inventar datos):
${lines.map((l) => `- ${l}`).join("\n")}`;
}

// ——— Admin

function parseArea(value: unknown): LessonArea {
  if (!LESSON_AREAS.includes(value as LessonArea)) throw new CustomError("Área inválida", 400);
  return value as LessonArea;
}

function parseInstruction(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < 5) throw new CustomError("Escribe la instrucción (mínimo 5 caracteres)", 400);
  if (text.length > 600)
    throw new CustomError("La instrucción no puede pasar de 600 caracteres", 400);
  return text;
}

function parseExample(value: any) {
  if (!value || typeof value !== "object" || !value.title) return null;
  const verdict = LESSON_VERDICTS.includes(value.verdict) ? value.verdict : "";
  return {
    title: truncate(String(value.title), 300),
    url: truncate(String(value.url ?? ""), 500),
    verdict,
  };
}

export async function list() {
  const items = await Lesson.find().sort({ createdAt: -1 }).limit(500);
  return items.map((l: any) => l.toJSON());
}

export async function create(body: any, userId: string | undefined) {
  const example = parseExample(body?.example);
  const user =
    userId && isValidObjectId(userId) ? await User.findById(userId).select("name email") : null;
  const lesson = await Lesson.create({
    area: parseArea(body?.area ?? "general"),
    instruction: parseInstruction(body?.instruction),
    example,
    origin: example ? "correccion" : "manual",
    createdBy: user?._id ?? null,
    createdByName: user?.name || user?.email || "",
  });
  cache = null;
  return lesson.toJSON();
}

export async function update(id: string, body: any) {
  if (!isValidObjectId(id)) throw new CustomError("Instrucción no encontrada", 404);
  const set: Record<string, unknown> = {};
  if (body?.instruction !== undefined) set.instruction = parseInstruction(body.instruction);
  if (body?.area !== undefined) set.area = parseArea(body.area);
  if (body?.active !== undefined) set.active = !!body.active;
  const lesson = await Lesson.findByIdAndUpdate(id, set, { new: true });
  if (!lesson) throw new CustomError("Instrucción no encontrada", 404);
  cache = null;
  return lesson.toJSON();
}

export async function remove(id: string) {
  if (!isValidObjectId(id)) throw new CustomError("Instrucción no encontrada", 404);
  const lesson = await Lesson.findByIdAndDelete(id);
  if (!lesson) throw new CustomError("Instrucción no encontrada", 404);
  cache = null;
}
