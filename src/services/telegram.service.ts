import { env } from "../config/env";
import { errorMessage } from "../utils/text";
import { articleUrl } from "../utils/links";
import * as anthropicService from "./anthropic.service";
import * as articleService from "./article.service";
import * as cloudinaryService from "./cloudinary.service";
import * as tipService from "./tip.service";

/**
 * Bot de Telegram con dos caras: los chats de editores (TELEGRAM_EDITOR_CHAT_IDS)
 * publican directo; cualquier otro chat es un ciudadano que manda una denuncia.
 */

interface TelegramPhoto {
  file_id: string;
  width: number;
  height: number;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string; title?: string };
  from?: { id: number; first_name?: string; last_name?: string; username?: string };
  text?: string;
  caption?: string;
  photo?: TelegramPhoto[];
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
}

const API = "https://api.telegram.org";

export function isTelegramConfigured(): boolean {
  return !!env.TELEGRAM_BOT_TOKEN;
}

export function isValidSecret(header: unknown): boolean {
  // Sin secreto configurado se rechaza todo: un webhook abierto permitiría publicar a cualquiera.
  return !!env.TELEGRAM_WEBHOOK_SECRET && header === env.TELEGRAM_WEBHOOK_SECRET;
}

export async function callApi<T = unknown>(
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await response.json()) as { ok: boolean; result?: T; description?: string };
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? response.status}`);
  return data.result as T;
}

async function reply(chatId: number, text: string) {
  try {
    await callApi("sendMessage", { chat_id: chatId, text, disable_web_page_preview: false });
  } catch (error) {
    console.error("[telegram] no se pudo responder:", errorMessage(error));
  }
}

/** Descarga la foto más grande y la sube a Cloudinary. La URL de Telegram lleva el token: nunca se guarda. */
async function uploadPhoto(photos: TelegramPhoto[] | undefined): Promise<string> {
  if (!photos?.length || !cloudinaryService.isCloudinaryConfigured()) return "";
  try {
    const largest = [...photos].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const file = await callApi<{ file_path?: string }>("getFile", { file_id: largest.file_id });
    if (!file.file_path) return "";
    const response = await fetch(`${API}/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return "";
    const buffer = Buffer.from(await response.arrayBuffer());
    const { url } = await cloudinaryService.uploadBuffer(buffer, "off-the-record/telegram");
    return url;
  } catch (error) {
    console.error("[telegram] no se pudo subir la foto:", errorMessage(error));
    return "";
  }
}

function isEditor(chatId: number): boolean {
  return env.TELEGRAM_EDITOR_CHAT_IDS.includes(String(chatId));
}

async function handleEditor(msg: TelegramMessage, text: string) {
  if (text.length < 20) {
    await reply(
      msg.chat.id,
      "Mándame el texto o los datos de la nota (mínimo 20 caracteres) y la publico.",
    );
    return;
  }
  await reply(msg.chat.id, "Recibido. Redactando y publicando…");
  try {
    const [draft, imageUrl] = await Promise.all([
      anthropicService.articleFromText(text),
      uploadPhoto(msg.photo),
    ]);
    const author = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ");
    const article = await articleService.createFromDraft(draft, {
      origin: "telegram",
      status: "published",
      image: imageUrl
        ? { url: imageUrl, credit: "", sourceName: "", sourceUrl: "", kind: "photo" }
        : null,
      author: author ? `${author} · Off the Record` : "Redacción Off the Record",
    });
    await reply(msg.chat.id, `Publicada: ${article.title}\n${articleUrl(article.slug)}`);
  } catch (error) {
    await reply(msg.chat.id, `No pude publicar la nota: ${errorMessage(error)}`);
  }
}

async function handleCitizen(msg: TelegramMessage, text: string) {
  if (!text && !msg.photo?.length) {
    await reply(
      msg.chat.id,
      "Cuéntanos qué pasó con el mayor detalle posible: qué, dónde, cuándo y quiénes.",
    );
    return;
  }
  const mediaUrl = await uploadPhoto(msg.photo);
  const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ");
  await tipService.createTelegramTip({
    name,
    contact: msg.from?.username ? `@${msg.from.username}` : `telegram:${msg.chat.id}`,
    text: text || "(foto sin texto)",
    mediaUrls: mediaUrl ? [mediaUrl] : [],
  });
  await reply(
    msg.chat.id,
    "Gracias. Tu denuncia llegó a la mesa de redacción de Off the Record. La revisaremos y, si necesitamos más datos, te escribimos por aquí. Tu identidad está protegida.",
  );
}

/** Procesa un update. Nunca lanza: Telegram reintenta lo que no recibe 200. */
export async function handleUpdate(update: TelegramUpdate): Promise<void> {
  if (!isTelegramConfigured()) return;
  const msg = update.message ?? update.channel_post;
  if (!msg?.chat) return;

  const text = (msg.text ?? msg.caption ?? "").trim();
  try {
    if (text.startsWith("/start")) {
      await reply(
        msg.chat.id,
        isEditor(msg.chat.id)
          ? "Hola, editor. Todo lo que me mandes (texto, con foto opcional) se convierte en nota y se publica en Off the Record."
          : "Hola, esto es Off the Record. Si tienes una denuncia o un dato, escríbelo aquí (puedes adjuntar una foto). Lo revisará la mesa de redacción y tu identidad está protegida.",
      );
      return;
    }
    if (isEditor(msg.chat.id)) await handleEditor(msg, text);
    else await handleCitizen(msg, text);
  } catch (error) {
    console.error("[telegram] error procesando update:", errorMessage(error));
  }
}
