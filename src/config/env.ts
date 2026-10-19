import dotenv from "dotenv";

dotenv.config();
// `vercel env pull` deja el token OIDC del AI Gateway en .env.local (solo en local).
dotenv.config({ path: ".env.local" });

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
  // B2: con esto en true, solo se muestran fotos de fuentes con licencia; el resto cae a la tarjeta propia.
  PHOTOS_LICENSED_ONLY: bool("PHOTOS_LICENSED_ONLY", false),
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
  // Cifra el modo de lectura de los suscriptores que consintieron. Sin valor se deriva de JWT_SECRET.
  MODE_ENCRYPTION_KEY: optional("MODE_ENCRYPTION_KEY", ""),
  // URL pública del API, para registrar el webhook de Telegram.
  PUBLIC_API_URL: optional("PUBLIC_API_URL", ""),

  // Vercel AI Gateway: Jev decide qué es noticia y Claude redacta por el mismo gateway.
  // Sin API key se usa el token OIDC del proyecto de Vercel.
  AI_GATEWAY_API_KEY: optional("AI_GATEWAY_API_KEY", ""),
  HAS_VERCEL_OIDC: Boolean(process.env.VERCEL_OIDC_TOKEN),
  JEV_MODEL: optional("JEV_MODEL", "typesafe-ai/jev"),
  GATEWAY_WRITING_MODEL: optional("GATEWAY_WRITING_MODEL", "anthropic/claude-sonnet-5"),
  GATEWAY_FAST_MODEL: optional("GATEWAY_FAST_MODEL", "anthropic/claude-haiku-4.5"),
  // Umbral de Jev para considerar que un hecho es de Ecuador o está repetido.
  JEV_ECUADOR_MIN: Number(optional("JEV_ECUADOR_MIN", "0.5")),
  JEV_DUPLICATE_MIN: Number(optional("JEV_DUPLICATE_MIN", "0.6")),

  // IA directa (respaldo): Claude con llave propia y Perplexity para buscar en la web.
  ANTHROPIC_API_KEY: optional("ANTHROPIC_API_KEY", ""),
  ANTHROPIC_WORKSPACE_ID: optional("ANTHROPIC_WORKSPACE_ID", ""),
  PERPLEXITY_API_KEY: optional("PERPLEXITY_API_KEY", ""),
  AI_SCORING_MODEL: optional("AI_SCORING_MODEL", "claude-haiku-4-5-20251001"),
  AI_WRITING_MODEL: optional("AI_WRITING_MODEL", "claude-sonnet-5"),
  PERPLEXITY_MODEL: optional("PERPLEXITY_MODEL", "sonar"),
  // Redacta cuando Claude no está disponible.
  PERPLEXITY_WRITING_MODEL: optional("PERPLEXITY_WRITING_MODEL", "sonar-pro"),

  // Redacción automática
  PUBLISH_THRESHOLD: Number(optional("PUBLISH_THRESHOLD", "7")),
  // false = todo lo que pasa el umbral queda en cola de aprobación.
  AUTO_PUBLISH: bool("AUTO_PUBLISH", false),
  MAX_DRAFTS_PER_RUN: Number(optional("MAX_DRAFTS_PER_RUN", "3")),
  // Hechos entre este puntaje y el umbral quedan en observación hasta que lleguen más fuentes.
  WATCHLIST_MIN: Number(optional("WATCHLIST_MIN", "5")),
  // Nivel N1: las actualizaciones sin errores de verificación salen solas.
  AUTO_PUBLISH_UPDATES: bool("AUTO_PUBLISH_UPDATES", false),
  MAX_UPDATES_PER_RUN: Number(optional("MAX_UPDATES_PER_RUN", "2")),
  // Horario de la mesa (hora de Ecuador, America/Guayaquil).
  // Por defecto cubre desde los programas de la mañana hasta después de los noticieros de la noche.
  NEWSROOM_START_HOUR: Number(optional("NEWSROOM_START_HOUR", "5")),
  NEWSROOM_END_HOUR: Number(optional("NEWSROOM_END_HOUR", "23")),
  // Costo de las búsquedas con IA: frecuencia por fuente y tope de búsquedas por ciclo.
  AI_SOURCE_EVERY_MINUTES: Number(optional("AI_SOURCE_EVERY_MINUTES", "60")),
  PEOPLE_EVERY_MINUTES: Number(optional("PEOPLE_EVERY_MINUTES", "180")),
  MAX_AI_QUERIES_PER_RUN: Number(optional("MAX_AI_QUERIES_PER_RUN", "6")),
  // Google Sheet de fuentes publicado como CSV (Archivo → Compartir → Publicar en la web → CSV).
  SOURCES_SHEET_CSV_URL: optional("SOURCES_SHEET_CSV_URL", ""),

  // Telegram: editores aprueban y publican, reporteros mandan notas a la Mesa,
  // el resto manda denuncias por chat privado.
  TELEGRAM_BOT_TOKEN: optional("TELEGRAM_BOT_TOKEN", ""),
  TELEGRAM_WEBHOOK_SECRET: optional("TELEGRAM_WEBHOOK_SECRET", ""),
  // Grupo "Mesa": ahí llegan las notas por aprobar con sus botones.
  TELEGRAM_MESA_CHAT_ID: optional("TELEGRAM_MESA_CHAT_ID", ""),
  // Ids de usuario de Telegram. TELEGRAM_EDITOR_CHAT_IDS se mantiene por compatibilidad:
  // en un chat privado el id del chat es el del usuario.
  TELEGRAM_EDITOR_IDS: [...list("TELEGRAM_EDITOR_IDS"), ...list("TELEGRAM_EDITOR_CHAT_IDS")],
  TELEGRAM_REPORTER_IDS: list("TELEGRAM_REPORTER_IDS"),

  // Conector de gerencia (MCP): edita los repos del sitio con commits a main.
  // Token de GitHub fine-grained con Contents: read/write solo en los dos repos.
  GITHUB_TOKEN: optional("GITHUB_TOKEN", ""),
  GITHUB_BACK_REPO: optional("GITHUB_BACK_REPO", "yeyodev1/off-the-record-news-backapp"),
  GITHUB_FRONT_REPO: optional("GITHUB_FRONT_REPO", "yeyodev1/off-the-record-news-frontapp"),
  // Solo estas cuentas del panel ven la página del conector y pueden usarlo.
  MCP_ALLOWED_EMAILS: list("MCP_ALLOWED_EMAILS").map((e) => e.toLowerCase()),
  // A quién se avisa de cada cambio hecho por el conector.
  MCP_NOTIFY_EMAILS: list("MCP_NOTIFY_EMAILS"),
} as const;
