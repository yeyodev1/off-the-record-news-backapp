import { Schema } from "mongoose";

/**
 * Todos los modelos viajan con `id` en vez de `_id`/`__v`: el contrato del
 * API no expone detalles de Mongo. `hidden` quita campos internos (tokens).
 */
export function applyToJSON(schema: Schema, hidden: string[] = []): void {
  schema.set("toJSON", {
    virtuals: false,
    versionKey: false,
    transform: (_doc, ret: Record<string, unknown>) => {
      ret.id = String(ret._id);
      delete ret._id;
      for (const key of hidden) delete ret[key];
      return ret;
    },
  });
}
