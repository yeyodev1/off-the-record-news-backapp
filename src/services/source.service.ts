import { isValidObjectId } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Source, SOURCE_CATEGORIES, SOURCE_KINDS } from "../models/source.model";

const EDITABLE = ["name", "kind", "category", "url", "query", "weight", "isActive"] as const;

function pick(body: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const key of EDITABLE) if (body[key] !== undefined) out[key] = body[key];
  if (out.kind !== undefined && !SOURCE_KINDS.includes(out.kind as any))
    throw new CustomError("Tipo de fuente inválido", 400);
  if (out.category !== undefined && !SOURCE_CATEGORIES.includes(out.category as any)) {
    throw new CustomError("Categoría inválida", 400);
  }
  if (out.weight !== undefined) {
    const w = Number(out.weight);
    if (!Number.isFinite(w) || w < 0.5 || w > 2)
      throw new CustomError("El peso debe estar entre 0.5 y 2", 400);
    out.weight = w;
  }
  return out;
}

function validate(data: Record<string, unknown>) {
  if (!String(data.name ?? "").trim()) throw new CustomError("El nombre es obligatorio", 400);
  if (data.kind === "perplexity" && !String(data.query ?? "").trim()) {
    throw new CustomError("Las fuentes de Perplexity necesitan una consulta", 400);
  }
  if (data.kind !== "perplexity" && !/^https?:\/\//.test(String(data.url ?? ""))) {
    throw new CustomError("La URL de la fuente no es válida", 400);
  }
}

export async function list(query: { kind?: string; category?: string }) {
  const filter: Record<string, unknown> = {};
  if (query.kind) filter.kind = query.kind;
  if (query.category) filter.category = query.category;
  const docs = await Source.find(filter).sort({ kind: 1, name: 1 });
  return docs.map((d: any) => d.toJSON());
}

export async function create(body: Record<string, unknown>) {
  const data: Record<string, unknown> = { kind: "rss", ...pick(body) };
  validate(data);
  if (await Source.exists({ name: String(data.name).trim() })) {
    throw new CustomError("Ya existe una fuente con ese nombre", 409);
  }
  return (await Source.create(data)).toJSON();
}

export async function update(id: string, body: Record<string, unknown>) {
  if (!isValidObjectId(id)) throw new CustomError("Fuente no encontrada", 404);
  const doc = await Source.findById(id);
  if (!doc) throw new CustomError("Fuente no encontrada", 404);
  doc.set(pick(body));
  validate(doc.toObject());
  await doc.save();
  return doc.toJSON();
}

export async function remove(id: string) {
  if (!isValidObjectId(id)) throw new CustomError("Fuente no encontrada", 404);
  const result = await Source.findByIdAndDelete(id);
  if (!result) throw new CustomError("Fuente no encontrada", 404);
  return { ok: true };
}
