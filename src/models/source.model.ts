import mongoose, { Schema } from "mongoose";
import { applyToJSON } from "../utils/toJSON";

export const SOURCE_KINDS = ["rss", "perplexity", "web"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

// Mapa de fuentes de la reunión del 13/10/2026: instituciones del Estado, medios
// (prensa, radio, TV, digitales), programas, políticos activos y retirados,
// periodistas de todas las orillas, sociedad civil, lo internacional sobre
// Ecuador y lo viral en redes.
export const SOURCE_CATEGORIES = [
  "institucion",
  "medio",
  "programa",
  "politico",
  "periodista",
  "sociedad_civil",
  "internacional",
  "redes",
] as const;
export type SourceCategory = (typeof SOURCE_CATEGORIES)[number];

/** Personas: sin consulta propia se buscan de a varias por pedido, que es lo barato. */
export const PEOPLE_CATEGORIES: readonly SourceCategory[] = [
  "politico",
  "periodista",
  "sociedad_civil",
];

export interface ISource {
  name: string;
  kind: SourceKind;
  category: SourceCategory;
  url: string;
  query: string;
  weight: number;
  isActive: boolean;
  /** Cada cuánto se consulta. 0 = lo de su tipo (RSS en cada ciclo, búsquedas cada hora o más). */
  everyMinutes: number;
  /** Cargo, red social o lo que ayude a buscarla. Lo escriben los periodistas en el Sheet. */
  notes: string;
  /** Vino del Google Sheet: el sync la puede actualizar o apagar. */
  fromSheet: boolean;
  /** Hay licencia para usar sus fotos. Con la política de fotos activa, solo estas se muestran (B2). */
  photoLicensed: boolean;
  lastCheckedAt: Date | null;
  lastError: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const sourceSchema = new Schema<ISource>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    kind: { type: String, enum: SOURCE_KINDS, default: "rss" },
    category: { type: String, enum: SOURCE_CATEGORIES, default: "medio" },
    url: { type: String, default: "" },
    query: { type: String, default: "" },
    weight: { type: Number, default: 1, min: 0.5, max: 2 },
    isActive: { type: Boolean, default: true },
    everyMinutes: { type: Number, default: 0, min: 0 },
    notes: { type: String, default: "" },
    fromSheet: { type: Boolean, default: false },
    photoLicensed: { type: Boolean, default: false },
    lastCheckedAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
  },
  { timestamps: true },
);

applyToJSON(sourceSchema);

export const Source = mongoose.models.Source || mongoose.model<ISource>("Source", sourceSchema);
