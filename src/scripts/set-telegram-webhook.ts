/**
 * Registra el webhook del bot de Telegram en PUBLIC_API_URL + /api/telegram/webhook.
 * Uso: pnpm telegram:webhook
 */
import "dotenv/config";
import { env } from "../config/env";
import { callApi } from "../services/telegram.service";

async function main() {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN no está definido en .env");
  if (!env.TELEGRAM_WEBHOOK_SECRET)
    throw new Error("TELEGRAM_WEBHOOK_SECRET no está definido en .env");
  if (!/^https:\/\//.test(env.PUBLIC_API_URL))
    throw new Error("PUBLIC_API_URL debe ser una URL https pública");

  const url = `${env.PUBLIC_API_URL.replace(/\/+$/, "")}/api/telegram/webhook`;
  await callApi("setWebhook", {
    url,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message", "channel_post"],
    drop_pending_updates: true,
  });
  const info = await callApi<{
    url: string;
    pending_update_count: number;
    last_error_message?: string;
  }>("getWebhookInfo", {});
  console.log(`✔ Webhook registrado: ${info.url}`);
  if (info.last_error_message)
    console.log(`  Último error de Telegram: ${info.last_error_message}`);
}

main().catch((error) => {
  console.error(
    "✖ No se pudo registrar el webhook:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
