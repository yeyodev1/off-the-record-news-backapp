import mongoose, { Schema, Types } from "mongoose";
import { applyToJSON } from "../utils/toJSON";

export const SECTIONS = [
  "politica",
  "economia",
  "legislativo",
  "seguridad",
  "sociedad",
  "mundo",
  "negocios",
  "tecnologia",
] as const;
export type Section = (typeof SECTIONS)[number];

export const SECTION_NAMES: Record<Section, string> = {
  politica: "Política",
  economia: "Economía",
  legislativo: "Asamblea",
  seguridad: "Seguridad",
  sociedad: "Sociedad",
  mundo: "Mundo",
  negocios: "Negocios",
  tecnologia: "Tecnología",
};

// `retracted`: estuvo publicada y se retiró; la URL queda con el aviso de retiro.
export const ARTICLE_STATUSES = ["pending", "published", "rejected", "retracted"] as const;
export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

export const ARTICLE_ORIGINS = ["ai", "telegram", "manual"] as const;
export type ArticleOrigin = (typeof ARTICLE_ORIGINS)[number];

export const IMAGE_KINDS = ["photo", "illustration", "infographic"] as const;

export interface ScoreBreakdown {
  total: number;
  cercania: number;
  inmediatez: number;
  personaje: number;
  relevancia: number;
  impacto: number;
  reasoning: string;
}

export interface ArticleImage {
  url: string;
  credit: string;
  sourceName: string;
  sourceUrl: string;
  kind: (typeof IMAGE_KINDS)[number];
}

export interface Infographic {
  title: string;
  unit: string;
  items: { label: string; value: number }[];
}

export interface ArticleSource {
  name: string;
  url: string;
  /** Lo que dice esa nota, tomado de su propia descripción: se lee sin entrar. */
  summary?: string;
}

export const FLAG_LEVELS = ["error", "aviso"] as const;

export interface VerificationFlag {
  level: (typeof FLAG_LEVELS)[number];
  kind: string;
  text: string;
}

export interface Verification {
  checkedAt: Date;
  errors: number;
  warnings: number;
  flags: VerificationFlag[];
}

/** El corpus con el que se redactó: lo único que la nota puede afirmar. */
export interface Evidence {
  text: string;
  urls: string[];
}

export const UPDATE_STATUSES = ["pending", "published", "rejected"] as const;
export type UpdateStatus = (typeof UPDATE_STATUSES)[number];

export interface ArticleUpdate {
  _id?: Types.ObjectId;
  text: string;
  sources: ArticleSource[];
  status: UpdateStatus;
  verification: Verification | null;
  evidence: string;
  signalId: Types.ObjectId | null;
  createdAt: Date;
  publishedAt: Date | null;
}

export interface Retraction {
  at: Date;
  by: string;
  reason: string;
}

export interface HistoryEntry {
  action: string;
  by: string;
  at: Date;
  note: string;
}

/** Mensaje de Telegram ligado a la nota, para reconocer respuestas y editar botones. */
export interface TelegramCard {
  chatId: string;
  messageId: number;
  kind: "nota" | "update" | "regen";
  updateId: string;
}

export interface IArticle {
  slug: string;
  title: string;
  lede: string;
  whyItMatters: string;
  keyPoints: string[];
  body: string[];
  bigPicture: string;
  whatsNext: string;
  section: Section;
  tags: string[];
  image: ArticleImage | null;
  infographic: Infographic | null;
  sources: ArticleSource[];
  score: ScoreBreakdown | null;
  status: ArticleStatus;
  origin: ArticleOrigin;
  author: string;
  isPro: boolean;
  isBreaking: boolean;
  readingMinutes: number;
  views: number;
  publishedAt: Date | null;
  signalId: Types.ObjectId | null;
  storyId: Types.ObjectId | null;
  verification: Verification | null;
  evidence: Evidence | null;
  updates: ArticleUpdate[];
  lastUpdatedAt: Date | null;
  reviewedBy: string;
  retraction: Retraction | null;
  history: HistoryEntry[];
  telegramCards: TelegramCard[];
  createdAt?: Date;
  updatedAt?: Date;
}

export const scoreSchema = new Schema<ScoreBreakdown>(
  {
    total: { type: Number, default: 0 },
    cercania: { type: Number, default: 0 },
    inmediatez: { type: Number, default: 0 },
    personaje: { type: Number, default: 0 },
    relevancia: { type: Number, default: 0 },
    impacto: { type: Number, default: 0 },
    reasoning: { type: String, default: "" },
  },
  { _id: false },
);

const imageSchema = new Schema<ArticleImage>(
  {
    url: { type: String, required: true },
    credit: { type: String, default: "" },
    sourceName: { type: String, default: "" },
    sourceUrl: { type: String, default: "" },
    kind: { type: String, enum: IMAGE_KINDS, default: "photo" },
  },
  { _id: false },
);

const infographicSchema = new Schema<Infographic>(
  {
    title: { type: String, default: "" },
    unit: { type: String, default: "" },
    items: [{ _id: false, label: String, value: Number }],
  },
  { _id: false },
);

const verificationSchema = new Schema<Verification>(
  {
    checkedAt: { type: Date, default: () => new Date() },
    errors: { type: Number, default: 0 },
    warnings: { type: Number, default: 0 },
    flags: [
      {
        _id: false,
        level: { type: String, enum: FLAG_LEVELS, default: "aviso" },
        kind: String,
        text: String,
      },
    ],
  },
  { _id: false, suppressReservedKeysWarning: true },
);

const sourceSchema = { _id: false, name: String, url: String, summary: { type: String, default: "" } };

const updateSchema = new Schema<ArticleUpdate>({
  text: { type: String, required: true },
  sources: { type: [sourceSchema], default: [] },
  status: { type: String, enum: UPDATE_STATUSES, default: "pending" },
  verification: { type: verificationSchema, default: null },
  evidence: { type: String, default: "" },
  signalId: { type: Schema.Types.ObjectId, ref: "Signal", default: null },
  createdAt: { type: Date, default: () => new Date() },
  publishedAt: { type: Date, default: null },
});
applyToJSON(updateSchema, ["evidence"]);

const articleSchema = new Schema<IArticle>(
  {
    slug: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true, trim: true },
    lede: { type: String, default: "" },
    whyItMatters: { type: String, default: "" },
    keyPoints: { type: [String], default: [] },
    body: { type: [String], default: [] },
    bigPicture: { type: String, default: "" },
    whatsNext: { type: String, default: "" },
    section: { type: String, enum: SECTIONS, default: "politica" },
    tags: { type: [String], default: [] },
    image: { type: imageSchema, default: null },
    infographic: { type: infographicSchema, default: null },
    sources: { type: [sourceSchema], default: [] },
    score: { type: scoreSchema, default: null },
    status: { type: String, enum: ARTICLE_STATUSES, default: "pending" },
    origin: { type: String, enum: ARTICLE_ORIGINS, default: "ai" },
    author: { type: String, default: "Mesa Off the Record" },
    isPro: { type: Boolean, default: false },
    isBreaking: { type: Boolean, default: false },
    readingMinutes: { type: Number, default: 1 },
    views: { type: Number, default: 0 },
    publishedAt: { type: Date, default: null },
    signalId: { type: Schema.Types.ObjectId, ref: "Signal", default: null },
    storyId: { type: Schema.Types.ObjectId, ref: "Story", default: null, index: true },
    verification: { type: verificationSchema, default: null },
    // El corpus pesa; solo se trae cuando hay que verificar.
    evidence: {
      type: new Schema<Evidence>({ text: String, urls: [String] }, { _id: false }),
      default: null,
      select: false,
    },
    updates: { type: [updateSchema], default: [] },
    lastUpdatedAt: { type: Date, default: null },
    reviewedBy: { type: String, default: "" },
    retraction: {
      type: new Schema<Retraction>({ at: Date, by: String, reason: String }, { _id: false }),
      default: null,
    },
    history: {
      type: [{ _id: false, action: String, by: String, at: Date, note: String }],
      default: [],
    },
    telegramCards: {
      type: [
        {
          _id: false,
          chatId: String,
          messageId: Number,
          kind: { type: String, enum: ["nota", "update", "regen"] },
          updateId: { type: String, default: "" },
        },
      ],
      default: [],
    },
  },
  { timestamps: true },
);

articleSchema.index({ status: 1, publishedAt: -1 });
articleSchema.index({ section: 1, status: 1, publishedAt: -1 });
articleSchema.index({ tags: 1 });
articleSchema.index({ "telegramCards.chatId": 1, "telegramCards.messageId": 1 });

// ~200 palabras por minuto; nunca menos de 1.
articleSchema.pre("save", function (next) {
  const text = [
    this.lede,
    this.whyItMatters,
    ...this.keyPoints,
    ...this.body,
    this.bigPicture,
    this.whatsNext,
  ].join(" ");
  const words = text.split(/\s+/).filter(Boolean).length;
  this.readingMinutes = Math.max(1, Math.round(words / 200));
  next();
});

applyToJSON(articleSchema, ["signalId", "telegramCards", "evidence"]);

export const Article =
  mongoose.models.Article || mongoose.model<IArticle>("Article", articleSchema);
