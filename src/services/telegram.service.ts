import { isValidObjectId } from "mongoose";
import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";
import { Article, TelegramCard } from "../models/article.model";
import { TelegramConfig } from "../models/telegramConfig.model";
import { TELEGRAM_ROLES, TelegramMember, TelegramRole } from "../models/telegramMember.model";
import { SECTION_NAMES } from "../models/article.model";
import { errorMessage, truncate } from "../utils/text";
import { articleUrl } from "../utils/links";
import * as anthropicService from "./anthropic.service";
import * as articleService from "./article.service";
import * as cloudinaryService from "./cloudinary.service";
import * as tipService from "./tip.service";
import * as verifierService from "./verifier.service";

/**
 * Bot de Telegram: la única interfaz de la Mesa.
 *
 * - Editores: aprueban, matan, regeneran y publican sus notas directo.
 * - Reporteros: mandan #nota y queda por aprobar en el grupo Mesa.
 * - Cualquier otra persona en chat privado manda una denuncia. En grupos se ignora.
 *
 * Los roles vienen del panel (TelegramMember: cada quien entra con /unirme y un
 * admin le asigna el rol) o de TELEGRAM_EDITOR_IDS / TELEGRAM_REPORTER_IDS.
 * El grupo Mesa lo fija un editor con /mesa (o TELEGRAM_MESA_CHAT_ID). Ahí
 * llegan las notas por aprobar como tarjetas con botones. Responder a una tarjeta con texto la regenera con esa instrucción;
 * responder con #mata la retira.
 */

interface TelegramPhoto {
  file_id: string;
  width: number;
  height: number;
}

interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string; title?: string };
  from?: TelegramUser;
  text?: string;
  caption?: string;
  photo?: TelegramPhoto[];
  reply_to_message?: TelegramMessage;
}

interface TelegramCallback {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
  callback_query?: TelegramCallback;
}

type Role = "editor" | "reporter" | null;

const API = "https://api.telegram.org";
const MIN_NOTE_LENGTH = 20;
const FLAGS_SHOWN = 5;

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

async function reply(chatId: number | string, text: string, extra: Record<string, unknown> = {}) {
  try {
    return await callApi<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text: truncate(text, 4000),
      disable_web_page_preview: true,
      ...extra,
    });
  } catch (error) {
    console.error("[telegram] no se pudo responder:", errorMessage(error));
    return null;
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

async function roleOf(userId: number | undefined): Promise<Role> {
  if (userId === undefined) return null;
  const id = String(userId);
  if (env.TELEGRAM_EDITOR_IDS.includes(id)) return "editor";
  if (env.TELEGRAM_REPORTER_IDS.includes(id)) return "reporter";
  const member: any = await TelegramMember.findOne({ telegramId: id }).select("role");
  if (member?.role === "editor" || member?.role === "reporter") return member.role;
  return null;
}

async function mesaChatId(): Promise<string> {
  if (env.TELEGRAM_MESA_CHAT_ID) return env.TELEGRAM_MESA_CHAT_ID;
  const config: any = await TelegramConfig.findOne({ key: "main" }).select("mesaChatId");
  return config?.mesaChatId ?? "";
}

function nameOf(user: TelegramUser | undefined): string {
  if (!user) return "";
  const full = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return full || (user.username ? `@${user.username}` : `Telegram ${user.id}`);
}

// ——— Tarjetas de la Mesa

function flagLines(verification: any): string[] {
  if (!verification) return ["Verificación: no corrió"];
  const { errors, warnings, flags } = verification;
  if (!errors && !warnings) return ["Verificación: sin observaciones"];
  return [
    `Verificación: ${errors} error${errors === 1 ? "" : "es"}, ${warnings} aviso${warnings === 1 ? "" : "s"}`,
    ...flags.slice(0, FLAGS_SHOWN).map((f: any) => `${f.level === "error" ? "❌" : "⚠️"} ${f.text}`),
  ];
}

function editUrl(id: string): string | null {
  const base = env.FRONTEND_URL.replace(/\/+$/, "");
  // Telegram rechaza botones con enlaces locales; en desarrollo se omite.
  return /^https:\/\//.test(base) ? `${base}/admin/notas/${id}` : null;
}

function articleCardText(article: any): string {
  const score = article.score?.total ? ` · puntaje ${article.score.total}` : "";
  const sources = (article.sources ?? []).map((s: any) => s.name).filter(Boolean);
  const origin =
    article.origin === "ai" ? "Mesa automática" : `${article.author} (${article.origin})`;
  return [
    `🗂 POR APROBAR · ${SECTION_NAMES[article.section as keyof typeof SECTION_NAMES] ?? article.section}${score}`,
    "",
    article.title,
    "",
    article.lede,
    "",
    `Fuentes (${sources.length}): ${sources.join(", ") || "ninguna"}`,
    ...flagLines(article.verification),
    `Origen: ${origin}`,
    `ID: ${article._id ?? article.id}`,
  ].join("\n");
}

function articleButtons(id: string) {
  const rows: Array<Array<Record<string, string>>> = [
    [
      { text: "✅ Publicar", callback_data: `pub:${id}` },
      { text: "🗑 Matar", callback_data: `kill:${id}` },
    ],
    [
      { text: "⏸ Esperar más fuentes", callback_data: `wait:${id}` },
      { text: "🔁 Regenerar", callback_data: `regen:${id}` },
    ],
  ];
  const url = editUrl(id);
  if (url) rows.push([{ text: "✏️ Editar", url }]);
  return { inline_keyboard: rows };
}

async function rememberCard(articleId: unknown, card: TelegramCard) {
  await Article.updateOne({ _id: articleId }, { $push: { telegramCards: card } });
}

async function findCard(chatId: number, messageId: number) {
  const article: any = await Article.findOne({
    telegramCards: { $elemMatch: { chatId: String(chatId), messageId } },
  });
  if (!article) return null;
  const card = article.telegramCards.find(
    (c: TelegramCard) => c.chatId === String(chatId) && c.messageId === messageId,
  );
  return { article, card: card as TelegramCard };
}

/** Manda la nota por aprobar al grupo Mesa. Nunca lanza: la nota ya está guardada. */
export async function notifyArticle(article: any): Promise<void> {
  if (!isTelegramConfigured()) return;
  const mesa = await mesaChatId().catch(() => "");
  if (!mesa) return;
  const id = String(article._id ?? article.id);
  const sent = await reply(mesa, articleCardText(article), {
    reply_markup: articleButtons(id),
  });
  if (sent) {
    await rememberCard(id, {
      chatId: String(sent.chat.id),
      messageId: sent.message_id,
      kind: "nota",
      updateId: "",
    });
  }
}

/** Manda una actualización propuesta al grupo Mesa. Nunca lanza. */
export async function notifyUpdate(article: any, update: any): Promise<void> {
  if (!isTelegramConfigured()) return;
  const mesa = await mesaChatId().catch(() => "");
  if (!mesa) return;
  const id = String(article._id);
  const updateId = String(update._id);
  const text = [
    "🆕 ACTUALIZACIÓN POR APROBAR",
    "",
    `Nota: ${article.title}`,
    articleUrl(article.slug),
    "",
    update.text,
    "",
    `Fuente: ${update.sources.map((s: any) => s.name).join(", ")}`,
    ...flagLines(update.verification),
  ].join("\n");
  const sent = await reply(mesa, text, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Publicar actualización", callback_data: `upub:${id}:${updateId}` },
          { text: "🗑 Descartar", callback_data: `urej:${id}:${updateId}` },
        ],
      ],
    },
  });
  if (sent) {
    await rememberCard(id, {
      chatId: String(sent.chat.id),
      messageId: sent.message_id,
      kind: "update",
      updateId,
    });
  }
}

/** Cierra la tarjeta: quita los botones y deja escrito quién hizo qué. */
async function closeCard(message: TelegramMessage | undefined, outcome: string) {
  if (!message) return;
  try {
    await callApi("editMessageText", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: truncate(`${message.text ?? ""}\n\n${outcome}`, 4000),
      disable_web_page_preview: true,
    });
  } catch (error) {
    console.error("[telegram] no se pudo cerrar la tarjeta:", errorMessage(error));
  }
}

async function answerCallback(id: string, text: string) {
  try {
    await callApi("answerCallbackQuery", { callback_query_id: id, text: truncate(text, 190) });
  } catch (error) {
    console.error("[telegram] no se pudo contestar el botón:", errorMessage(error));
  }
}

function hourInEcuador(): string {
  return new Date().toLocaleTimeString("es-EC", {
    timeZone: "America/Guayaquil",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

async function handleCallback(cb: TelegramCallback) {
  const [action, id, updateId] = (cb.data ?? "").split(":");
  if ((await roleOf(cb.from.id)) !== "editor") {
    await answerCallback(cb.id, "Solo los editores pueden aprobar, matar o regenerar notas.");
    return;
  }
  const by = nameOf(cb.from);
  const at = hourInEcuador();
  try {
    switch (action) {
      case "pub": {
        const article = await articleService.publish(id, by);
        await closeCard(cb.message, `✅ Publicada por ${by} a las ${at}\n${articleUrl(String(article.slug))}`);
        await answerCallback(cb.id, "Publicada");
        return;
      }
      case "kill": {
        const article = await articleService.retract(id, by);
        const label = article.status === "retracted" ? "Retirada" : "Matada";
        await closeCard(cb.message, `🗑 ${label} por ${by} a las ${at}`);
        await answerCallback(cb.id, label);
        return;
      }
      case "wait": {
        await articleService.wait(id, by);
        await closeCard(
          cb.message,
          `⏸ ${by} pidió esperar más fuentes (${at}). Se vuelve a redactar cuando llegue otra pieza.`,
        );
        await answerCallback(cb.id, "En espera de más fuentes");
        return;
      }
      case "regen": {
        const prompt = await reply(
          cb.message?.chat.id ?? (await mesaChatId()),
          `🔁 Responde a este mensaje con la instrucción para regenerar la nota (ej: "quita el adjetivo, agrega la cifra del BCE").\nID: ${id}`,
          { reply_markup: { force_reply: true, selective: true } },
        );
        if (prompt) {
          await rememberCard(id, {
            chatId: String(prompt.chat.id),
            messageId: prompt.message_id,
            kind: "regen",
            updateId: "",
          });
        }
        await answerCallback(cb.id, "Escribe la instrucción respondiendo al mensaje");
        return;
      }
      case "upub": {
        await articleService.publishUpdate(id, updateId, by);
        await closeCard(cb.message, `✅ Actualización publicada por ${by} a las ${at}`);
        await answerCallback(cb.id, "Actualización publicada");
        return;
      }
      case "urej": {
        await articleService.rejectUpdate(id, updateId, by);
        await closeCard(cb.message, `🗑 Actualización descartada por ${by} a las ${at}`);
        await answerCallback(cb.id, "Actualización descartada");
        return;
      }
      default:
        await answerCallback(cb.id, "Acción desconocida");
    }
  } catch (error) {
    await answerCallback(cb.id, `No se pudo: ${errorMessage(error)}`);
  }
}

// ——— Mensajes

const COMMAND = /^[#/](nota|mata)(?:@\w+)?(?:\s+|$)([\s\S]*)$/i;

function parseCommand(text: string): { name: "nota" | "mata"; rest: string } | null {
  const match = text.match(COMMAND);
  if (!match) return null;
  return { name: match[1].toLowerCase() as "nota" | "mata", rest: match[2].trim() };
}

async function handleNote(msg: TelegramMessage, role: Role, text: string) {
  if (text.length < MIN_NOTE_LENGTH) {
    await reply(
      msg.chat.id,
      `Mándame el texto o los datos de la nota (mínimo ${MIN_NOTE_LENGTH} caracteres). En un grupo, empieza con #nota.`,
    );
    return;
  }
  await reply(msg.chat.id, "Recibido. Redactando…");
  try {
    const [draft, imageUrl] = await Promise.all([
      anthropicService.articleFromText(text),
      uploadPhoto(msg.photo),
    ]);
    const author = nameOf(msg.from);
    const isEditor = role === "editor";
    const article: any = await articleService.createFromDraft(draft, {
      origin: "telegram",
      // El editor publica directo, salvo que el verificador encuentre algo que no estaba en su texto.
      publishIfClean: isEditor,
      status: "pending",
      image: imageUrl
        ? { url: imageUrl, credit: author ? `Foto: ${author}` : "", sourceName: "", sourceUrl: "", kind: "photo" }
        : null,
      author: author ? `${author} · Off the Record` : "Redacción Off the Record",
      evidence: verifierService.buildEvidence([text]),
      by: author,
      reviewedBy: author,
    });

    if (article.status === "published") {
      await reply(msg.chat.id, `Publicada: ${article.title}\n${articleUrl(article.slug)}`);
      return;
    }
    await notifyArticle(article);
    const why = isEditor
      ? `El verificador encontró algo que no está en tu texto, así que quedó por aprobar:\n${flagLines(article.verification).join("\n")}`
      : "Quedó en la Mesa para que un editor la apruebe.";
    await reply(msg.chat.id, `${article.title}\n\n${why}`);
  } catch (error) {
    await reply(msg.chat.id, `No pude armar la nota: ${errorMessage(error)}`);
  }
}

async function handleKill(
  msg: TelegramMessage,
  rest: string,
  replied: Awaited<ReturnType<typeof findCard>>,
) {
  const by = nameOf(msg.from);
  let articleId: string;
  let reason = rest;
  if (replied) {
    articleId = String(replied.article._id);
  } else {
    const [ref, ...words] = rest.split(/\s+/);
    if (!ref) {
      await reply(msg.chat.id, "Uso: #mata <id o enlace de la nota> [motivo], o responde #mata a la tarjeta.");
      return;
    }
    const article = await articleService.resolve(ref);
    articleId = String(article._id);
    reason = words.join(" ");
  }
  const article = await articleService.retract(articleId, by, reason);
  await reply(
    msg.chat.id,
    article.status === "retracted"
      ? `🗑 Retirada: ${article.title}. La URL muestra el aviso de retiro.`
      : `🗑 Matada antes de publicarse: ${article.title}`,
  );
}

async function handleRegenerate(msg: TelegramMessage, articleId: string, instruction: string) {
  if (instruction.length < 3) {
    await reply(msg.chat.id, "Escribe la instrucción para regenerar la nota.");
    return;
  }
  await reply(msg.chat.id, "Regenerando…");
  const article: any = await articleService.rewrite(articleId, instruction, nameOf(msg.from));
  if (article.status === "pending") {
    await notifyArticle(await articleService.getDoc(articleId));
  } else {
    await reply(msg.chat.id, `Nota regenerada: ${article.title}\n${articleUrl(article.slug)}`);
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

const HELP = {
  editor: `Hola, editor de Off the Record.

• Nota propia: escríbeme por privado el texto (con foto opcional) y la publico. En el grupo usa /nota <texto>.
• Tarjetas de la Mesa: Publicar, Matar, Esperar más fuentes, Regenerar o Editar.
• Regenerar: responde a la tarjeta con la instrucción ("titular más corto, agrega la cifra del BCE").
• Retirar: responde /mata a la tarjeta, o /mata <id o enlace> [motivo].
• /mesa en un grupo lo convierte en la Mesa, donde llegan las notas por aprobar.
• /id muestra tu id y el del chat.`,
  reporter: `Hola, reportero de Off the Record.

• Escríbeme por privado tu nota (texto y foto opcional), o usa /nota <texto> en el grupo.
• Queda por aprobar en la Mesa; un editor la publica.
• /id muestra tu id y el del chat.`,
  citizen:
    "Hola, esto es Off the Record. Si tienes una denuncia o un dato, escríbelo aquí (puedes adjuntar una foto). Lo revisa la mesa de redacción y tu identidad está protegida.",
};

/** /unirme: queda registrado como pendiente y un admin le da el rol desde el panel. */
async function handleJoin(msg: TelegramMessage) {
  if (!msg.from) return;
  if (msg.chat.type !== "private") {
    await reply(msg.chat.id, "Escríbeme /unirme por privado.");
    return;
  }
  const existing: any = await TelegramMember.findOne({ telegramId: String(msg.from.id) });
  const role = existing?.role ?? (await roleOf(msg.from.id));
  if (role === "editor" || role === "reporter") {
    await reply(msg.chat.id, `Ya eres parte del equipo como ${role === "editor" ? "editor" : "reportero"}.`);
    return;
  }
  await TelegramMember.updateOne(
    { telegramId: String(msg.from.id) },
    {
      $set: { name: nameOf(msg.from), username: msg.from.username ?? "", lastSeenAt: new Date() },
      $setOnInsert: { role: "pending" },
    },
    { upsert: true },
  );
  await reply(
    msg.chat.id,
    "Listo. Tu solicitud llegó al panel de Off the Record; cuando un administrador te asigne el rol, te aviso por aquí.",
  );
}

/** /mesa: un editor fija este grupo como el lugar donde llegan las tarjetas. */
async function handleSetMesa(msg: TelegramMessage, role: Role) {
  if (msg.chat.type === "private") {
    await reply(msg.chat.id, "Usa /mesa dentro del grupo de la Mesa.");
    return;
  }
  if (role !== "editor") {
    await reply(msg.chat.id, "Solo un editor puede fijar el grupo de la Mesa.");
    return;
  }
  await TelegramConfig.updateOne(
    { key: "main" },
    {
      $set: {
        mesaChatId: String(msg.chat.id),
        mesaTitle: msg.chat.title ?? "",
        mesaSetBy: nameOf(msg.from),
      },
    },
    { upsert: true },
  );
  await reply(
    msg.chat.id,
    env.TELEGRAM_MESA_CHAT_ID && env.TELEGRAM_MESA_CHAT_ID !== String(msg.chat.id)
      ? "Guardado, pero TELEGRAM_MESA_CHAT_ID en el servidor apunta a otro grupo y tiene prioridad."
      : "✅ Este grupo es ahora la Mesa de Off the Record. Aquí llegarán las notas y actualizaciones por aprobar.",
  );
}

/** Procesa un update. Nunca lanza: Telegram reintenta lo que no recibe 200. */
export async function handleUpdate(update: TelegramUpdate): Promise<void> {
  if (!isTelegramConfigured()) return;
  try {
    if (update.callback_query) {
      await handleCallback(update.callback_query);
      return;
    }
    const msg = update.message ?? update.channel_post;
    if (!msg?.chat) return;

    const text = (msg.text ?? msg.caption ?? "").trim();
    const role = await roleOf(msg.from?.id);
    const isPrivate = msg.chat.type === "private";
    const slash = text.match(/^\/(\w+)(?:@\w+)?/)?.[1]?.toLowerCase() ?? "";

    if (slash === "start" || slash === "ayuda" || slash === "help") {
      if (isPrivate || role) await reply(msg.chat.id, HELP[role ?? "citizen"]);
      return;
    }
    if (slash === "id") {
      await reply(
        msg.chat.id,
        `Tu id de Telegram: ${msg.from?.id ?? "?"}\nId de este chat: ${msg.chat.id}${msg.chat.title ? ` (${msg.chat.title})` : ""}`,
      );
      return;
    }
    if (slash === "unirme") {
      await handleJoin(msg);
      return;
    }
    if (slash === "mesa") {
      await handleSetMesa(msg, role);
      return;
    }
    if (!role) {
      // En los grupos solo hablan los de la redacción; el público escribe por privado.
      if (isPrivate) await handleCitizen(msg, text);
      return;
    }

    const command = parseCommand(text);
    const replied = msg.reply_to_message
      ? await findCard(msg.chat.id, msg.reply_to_message.message_id)
      : null;

    if (command?.name === "mata") {
      if (role !== "editor") {
        await reply(msg.chat.id, "Solo los editores pueden retirar notas.");
        return;
      }
      await handleKill(msg, command.rest, replied);
      return;
    }
    if (replied && !command) {
      if (role !== "editor") {
        await reply(msg.chat.id, "Solo los editores pueden regenerar notas.");
        return;
      }
      if (replied.card.kind === "update") {
        await reply(msg.chat.id, "Las actualizaciones se publican o descartan con los botones.");
        return;
      }
      await handleRegenerate(msg, String(replied.article._id), text);
      return;
    }
    if (command?.name === "nota" || (isPrivate && !command)) {
      await handleNote(msg, role, command ? command.rest : text);
    }
  } catch (error) {
    console.error("[telegram] error procesando update:", errorMessage(error));
    const chatId = update.message?.chat.id;
    if (chatId) await reply(chatId, `No se pudo: ${errorMessage(error)}`);
  }
}

// ——— Panel y configuración

/** Estado del bot en Telegram. No toca la base: sirve también para el script de configuración. */
export async function botStatus() {
  let bot: { username: string; name: string } | null = null;
  let webhook: { url: string; pendingUpdates: number; lastError: string } | null = null;
  if (isTelegramConfigured()) {
    try {
      const me = await callApi<{ username: string; first_name: string }>("getMe", {});
      bot = { username: me.username, name: me.first_name };
      const info = await callApi<{
        url: string;
        pending_update_count: number;
        last_error_message?: string;
      }>("getWebhookInfo", {});
      webhook = {
        url: info.url,
        pendingUpdates: info.pending_update_count,
        lastError: info.last_error_message ?? "",
      };
    } catch (error) {
      console.error("[telegram] no se pudo leer el estado del bot:", errorMessage(error));
    }
  }
  return { configured: isTelegramConfigured(), bot, webhook };
}

export async function team() {
  const [members, config, status] = await Promise.all([
    TelegramMember.find().sort({ role: 1, createdAt: -1 }),
    TelegramConfig.findOne({ key: "main" }),
    botStatus(),
  ]);
  return {
    ...status,
    mesa: {
      chatId: env.TELEGRAM_MESA_CHAT_ID || config?.mesaChatId || "",
      title: env.TELEGRAM_MESA_CHAT_ID ? "(desde la variable del servidor)" : (config?.mesaTitle ?? ""),
      setBy: config?.mesaSetBy ?? "",
    },
    envEditors: env.TELEGRAM_EDITOR_IDS,
    envReporters: env.TELEGRAM_REPORTER_IDS,
    members: members.map((m: any) => m.toJSON()),
  };
}

const ROLE_NOTICE: Record<TelegramRole, string> = {
  editor: "✅ Ya eres editor de Off the Record en Telegram. Escribe /ayuda para ver lo que puedes hacer.",
  reporter: "✅ Ya eres reportero de Off the Record en Telegram. Escribe /ayuda para ver lo que puedes hacer.",
  disabled: "Tu acceso al equipo de Off the Record en Telegram quedó desactivado.",
  pending: "",
};

export async function setMemberRole(id: string, role: unknown) {
  if (!isValidObjectId(id)) throw new CustomError("Miembro no encontrado", 404);
  if (!TELEGRAM_ROLES.includes(role as TelegramRole)) throw new CustomError("Rol inválido", 400);
  const member: any = await TelegramMember.findById(id);
  if (!member) throw new CustomError("Miembro no encontrado", 404);
  const changed = member.role !== role;
  member.role = role;
  await member.save();
  if (changed && ROLE_NOTICE[role as TelegramRole] && isTelegramConfigured()) {
    await reply(member.telegramId, ROLE_NOTICE[role as TelegramRole]);
  }
  return member.toJSON();
}

export async function removeMember(id: string) {
  if (!isValidObjectId(id)) throw new CustomError("Miembro no encontrado", 404);
  const result = await TelegramMember.findByIdAndDelete(id);
  if (!result) throw new CustomError("Miembro no encontrado", 404);
  return { ok: true };
}

const COMMANDS_PRIVATE = [
  { command: "start", description: "Qué es este bot y cómo usarlo" },
  { command: "ayuda", description: "Lo que puedes hacer según tu rol" },
  { command: "nota", description: "Equipo: manda una nota (texto y foto)" },
  { command: "unirme", description: "Equipo: pide acceso a la Mesa" },
  { command: "id", description: "Muestra tu id de Telegram" },
];

const COMMANDS_GROUP = [
  { command: "nota", description: "Manda una nota a la Mesa" },
  { command: "mata", description: "Retira una nota: /mata <id> [motivo]" },
  { command: "mesa", description: "Editor: fija este grupo como la Mesa" },
  { command: "id", description: "Muestra los ids del chat y tuyo" },
  { command: "ayuda", description: "Cómo usar el bot" },
];

const DESCRIPTION = `Off the Record · Noticias de Ecuador, breves y con fuentes.

¿Viste algo que debería ser noticia? Escríbelo aquí, con foto si tienes. La mesa de redacción revisa cada mensaje y tu identidad está protegida.

Si eres del equipo, escribe /unirme.`;

const SHORT_DESCRIPTION =
  "Canal de denuncias y mesa de redacción de Off the Record, el medio de Boscán y La Moni. Tu identidad está protegida.";

/**
 * Deja el bot listo: webhook con secreto, nombre, descripciones y comandos.
 * Idempotente: se puede correr cada vez que cambie algo.
 */
export async function configureBot() {
  if (!isTelegramConfigured()) throw new CustomError("Falta TELEGRAM_BOT_TOKEN", 503);
  if (!env.TELEGRAM_WEBHOOK_SECRET) throw new CustomError("Falta TELEGRAM_WEBHOOK_SECRET", 503);
  if (!/^https:\/\//.test(env.PUBLIC_API_URL)) {
    throw new CustomError("PUBLIC_API_URL debe ser una URL https pública", 503);
  }
  const url = `${env.PUBLIC_API_URL.replace(/\/+$/, "")}/api/telegram/webhook`;
  await callApi("setWebhook", {
    url,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message", "channel_post", "callback_query"],
  });
  await callApi("setMyName", { name: "Off the Record" }).catch((error) =>
    // Telegram limita cuántas veces se cambia el nombre; si ya está, no es grave.
    console.warn("[telegram] setMyName:", errorMessage(error)),
  );
  await callApi("setMyDescription", { description: DESCRIPTION });
  await callApi("setMyShortDescription", { short_description: SHORT_DESCRIPTION });
  await callApi("setMyCommands", {
    commands: COMMANDS_PRIVATE,
    scope: { type: "all_private_chats" },
  });
  await callApi("setMyCommands", {
    commands: COMMANDS_GROUP,
    scope: { type: "all_group_chats" },
  });
  return botStatus();
}
