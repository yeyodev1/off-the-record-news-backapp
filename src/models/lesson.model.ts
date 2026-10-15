import mongoose, { Schema, Types } from "mongoose";
import { applyToJSON } from "../utils/toJSON";

/**
 * Lo que la Mesa le enseña a la IA sin tocar código: una instrucción en
 * lenguaje normal que se suma al prompt del paso que corresponde.
 *
 * - general: todos los pasos.
 * - valoracion: qué es noticia y qué no (Jev y el valorador de respaldo).
 * - redaccion: cómo se escribe la nota y sus actualizaciones.
 * - modos: orden y enfoque de noboísta, correísta e independiente.
 * - fotos: qué foto aporta y cuál no.
 */
export const LESSON_AREAS = ["general", "valoracion", "redaccion", "modos", "fotos"] as const;
export type LessonArea = (typeof LESSON_AREAS)[number];

export const LESSON_VERDICTS = ["es_noticia", "no_es_noticia", ""] as const;
export type LessonVerdict = (typeof LESSON_VERDICTS)[number];

export interface ILesson {
  area: LessonArea;
  instruction: string;
  /** La señal que motivó la corrección, para que la IA vea el caso concreto. */
  example: { title: string; url: string; verdict: LessonVerdict } | null;
  active: boolean;
  origin: "manual" | "correccion";
  createdBy: Types.ObjectId | null;
  createdByName: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const lessonSchema = new Schema<ILesson>(
  {
    area: { type: String, enum: LESSON_AREAS, default: "general" },
    instruction: { type: String, required: true, trim: true, maxlength: 600 },
    example: {
      type: new Schema(
        {
          title: { type: String, default: "" },
          url: { type: String, default: "" },
          verdict: { type: String, enum: LESSON_VERDICTS, default: "" },
        },
        { _id: false },
      ),
      default: null,
    },
    active: { type: Boolean, default: true },
    origin: { type: String, enum: ["manual", "correccion"], default: "manual" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    createdByName: { type: String, default: "" },
  },
  { timestamps: true },
);

lessonSchema.index({ active: 1, area: 1, createdAt: -1 });

applyToJSON(lessonSchema, ["createdBy"]);

export const Lesson = mongoose.models.Lesson || mongoose.model<ILesson>("Lesson", lessonSchema);
