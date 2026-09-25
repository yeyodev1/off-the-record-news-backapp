import "dotenv/config";

/**
 * Único lugar que lee process.env. Leerlo en otro archivo a nivel de módulo
 * es el bug clásico de "la variable está en .env pero llega undefined".
 */

function required(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key]?.trim() || fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const value = process.env[key]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === "true" || value === "1";
}

function list(key: string): string[] {
  return optional(key, "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

export const env = {
  PORT: Number(optional("PORT", "8100")),
  NODE_ENV: optional("NODE_ENV", "development"),
  IS_VERCEL: Boolean(process.env.VERCEL),
  DB_URI: required("DB_URI"),
  JWT_SECRET: required("JWT_SECRET"),
  CORS_ORIGINS: list("CORS_ORIGINS"),
  FRONTEND_URL: optional("FRONTEND_URL", "http://localhost:5173"),
  SLACK_ERROR_WEBHOOK: optional("SLACK_ERROR_WEBHOOK", ""),
  ADMIN_EMAIL: optional("ADMIN_EMAIL", "admin@cliente.com").toLowerCase(),
  ADMIN_PASSWORD: optional("ADMIN_PASSWORD", ""),
  ADMIN_NAME: optional("ADMIN_NAME", "Administración"),
  RESEND_API_KEY: optional("RESEND_API_KEY", ""),
  RESEND_FROM_EMAIL: optional("RESEND_FROM_EMAIL", "Off The Record <onboarding@resend.dev>"),
  CLOUDINARY_CLOUD_NAME: optional("CLOUDINARY_CLOUD_NAME", ""),
  CLOUDINARY_API_KEY: optional("CLOUDINARY_API_KEY", ""),
  CLOUDINARY_API_SECRET: optional("CLOUDINARY_API_SECRET", ""),
  CRON_SECRET: optional("CRON_SECRET", ""),
  // URL pública del API, para registrar el webhook de Telegram.
  PUBLIC_API_URL: optional("PUBLIC_API_URL", ""),

  // IA: Claude valora y redacta; Perplexity busca en la web en tiempo real.
  ANTHROPIC_API_KEY: optional("ANTHROPIC_API_KEY", ""),
  PERPLEXITY_API_KEY: optional("PERPLEXITY_API_KEY", ""),
  AI_SCORING_MODEL: optional("AI_SCORING_MODEL", "claude-haiku-4-5-20251001"),
  AI_WRITING_MODEL: optional("AI_WRITING_MODEL", "claude-sonnet-5"),
  PERPLEXITY_MODEL: optional("PERPLEXITY_MODEL", "sonar"),

  // Redacción automática
  PUBLISH_THRESHOLD: Number(optional("PUBLISH_THRESHOLD", "7")),
  // false = todo lo que pasa el umbral queda en cola de aprobación.
  AUTO_PUBLISH: bool("AUTO_PUBLISH", false),
  MAX_DRAFTS_PER_RUN: Number(optional("MAX_DRAFTS_PER_RUN", "3")),
  // Horario de la mesa (hora de Ecuador, America/Guayaquil).
  NEWSROOM_START_HOUR: Number(optional("NEWSROOM_START_HOUR", "8")),
  NEWSROOM_END_HOUR: Number(optional("NEWSROOM_END_HOUR", "17")),

  // Telegram: editores publican, el resto manda denuncias.
  TELEGRAM_BOT_TOKEN: optional("TELEGRAM_BOT_TOKEN", ""),
  TELEGRAM_WEBHOOK_SECRET: optional("TELEGRAM_WEBHOOK_SECRET", ""),
  TELEGRAM_EDITOR_CHAT_IDS: list("TELEGRAM_EDITOR_CHAT_IDS"),
} as const;
