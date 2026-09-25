import { isValidObjectId } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Tip, TIP_STATUSES, TipStatus } from "../models/tip.model";
import { paginate } from "../utils/paginate";
import * as anthropicService from "./anthropic.service";
import * as articleService from "./article.service";

export async function createWebTip(body: Record<string, unknown>) {
  const text = String(body.text ?? "").trim();
  if (text.length < 20)
    throw new CustomError(
      "Cuéntanos un poco más: la denuncia debe tener al menos 20 caracteres",
      400,
    );
  await Tip.create({
    channel: "web",
    name: String(body.name ?? "")
      .trim()
      .slice(0, 120),
    contact: String(body.contact ?? "")
      .trim()
      .slice(0, 160),
    text: text.slice(0, 10_000),
  });
  return { message: "Gracias. Recibimos tu denuncia y la revisará la mesa de redacción." };
}

export async function createTelegramTip(data: {
  name: string;
  contact: string;
  text: string;
  mediaUrls: string[];
}) {
  return Tip.create({ channel: "telegram", ...data });
}

export async function adminList(query: { status?: string; page?: unknown; limit?: unknown }) {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  return paginate(Tip, filter, { page: query.page, limit: query.limit, sort: { createdAt: -1 } });
}

async function getDoc(id: string) {
  if (!isValidObjectId(id)) throw new CustomError("Denuncia no encontrada", 404);
  const tip = await Tip.findById(id);
  if (!tip) throw new CustomError("Denuncia no encontrada", 404);
  return tip;
}

export async function updateStatus(id: string, status: unknown) {
  if (!TIP_STATUSES.includes(status as TipStatus)) throw new CustomError("Estado inválido", 400);
  const tip = await getDoc(id);
  tip.status = status as TipStatus;
  await tip.save();
  return tip.toJSON();
}

export async function draftFromTip(id: string) {
  const tip = await getDoc(id);
  const context = `Denuncia ciudadana recibida por ${tip.channel === "telegram" ? "Telegram" : "la web"}. Trátala como información por verificar: atribúyela a "una denuncia recibida por Off the Record" y no la presentes como hecho confirmado.\n\n${tip.text}`;
  const draft = await anthropicService.articleFromText(context);
  const article = await articleService.createFromDraft(draft, {
    origin: "manual",
    status: "pending",
  });
  if (tip.mediaUrls[0]) {
    article.image = {
      url: tip.mediaUrls[0],
      credit: "Foto: denuncia ciudadana",
      sourceName: "",
      sourceUrl: "",
      kind: "photo",
    };
    await article.save();
  }
  tip.status = "used";
  await tip.save();
  return article.toJSON();
}
