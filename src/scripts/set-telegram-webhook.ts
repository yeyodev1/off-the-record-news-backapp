/**
 * Deja el bot listo: webhook en PUBLIC_API_URL + /api/telegram/webhook, nombre,
 * descripción y comandos. No toca la base. Uso: pnpm telegram:webhook
 */
import "dotenv/config";
import { configureBot } from "../services/telegram.service";

configureBot()
  .then((state) => {
    console.log(`✔ Bot @${state.bot?.username} listo`);
    console.log(`  Webhook: ${state.webhook?.url}`);
    if (state.webhook?.lastError) console.log(`  Último error de Telegram: ${state.webhook.lastError}`);
  })
  .catch((error) => {
    console.error("✖ No se pudo configurar el bot:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
