import { isValidObjectId } from "mongoose";
import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";
import { Section, SECTIONS } from "../models/article.model";
import { LEAD_STATUSES, LeadStatus, PRO_PLANS, ProLead, ProPlan } from "../models/proLead.model";
import { ProTeaser, TEASER_STATUSES, TeaserStatus } from "../models/proTeaser.model";
import { paginate } from "../utils/paginate";
import { escapeHtml, truncate } from "../utils/text";
import * as anthropicService from "./anthropic.service";
import { layout, sendEmail } from "./email.service";

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PUBLIC_WINDOW_MS = 14 * 24 * 3600_000;

// ——— Teasers (público)

/** Lo que ve la portada: tráileres recientes y cuántas notas selladas hubo esta semana. */
export async function publicTeasers() {
  const now = Date.now();
  const [items, sealedThisWeek] = await Promise.all([
    ProTeaser.find({ status: "published", publishedAt: { $gte: new Date(now - PUBLIC_WINDOW_MS) } })
      .sort({ publishedAt: -1 })
      .limit(12)
      .select("title whyItMatters section publishedAt"),
    ProTeaser.countDocuments({
      status: "published",
      publishedAt: { $gte: new Date(now - 7 * 24 * 3600_000) },
    }),
  ]);
  return { items: items.map((d: any) => d.toJSON()), sealedThisWeek };
}

/**
 * Las mejores notas PRO del día para venderlas en el boletín: las publicadas en
 * las últimas 36 h, de la más nueva a la más vieja, hasta `limit`. Si no hubo
 * nada en el día, el boletín simplemente no lleva la sección PRO.
 */
export async function newsletterPicks(limit = 5) {
  const since = new Date(Date.now() - 36 * 3600_000);
  const items = await ProTeaser.find({ status: "published", publishedAt: { $gte: since } })
    .sort({ publishedAt: -1 })
    .limit(limit)
    .select("title whyItMatters section");
  return items.map((d: any) => ({
    id: String(d._id),
    title: d.title as string,
    whyItMatters: (d.whyItMatters as string) ?? "",
    section: d.section as string,
  }));
}

// ——— Teasers (panel)

function getTeaser(id: string) {
  if (!isValidObjectId(id)) throw new CustomError("Tráiler no encontrado", 404);
  return ProTeaser.findById(id).select("+sourceText");
}

export async function listTeasers(query: { status?: string; page?: unknown }) {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  return paginate(ProTeaser, filter, { page: query.page, limit: 30, sort: { createdAt: -1 } });
}

/** La Mesa pega lo que se mandó a los clientes PRO y la IA arma el tráiler. */
export async function teaserFromText(text: string, by = "") {
  if (!text || text.trim().length < 40) {
    throw new CustomError("Pega la nota PRO completa (mínimo 40 caracteres)", 400);
  }
  const draft = await anthropicService.proTeaser(text.trim());
  const doc = await ProTeaser.create({ ...draft, sourceText: text.trim(), createdBy: by });
  return doc.toJSON();
}

export async function updateTeaser(id: string, body: Record<string, unknown>) {
  const doc: any = await getTeaser(id);
  if (!doc) throw new CustomError("Tráiler no encontrado", 404);
  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (!title) throw new CustomError("El titular no puede quedar vacío", 400);
    doc.title = truncate(title, 120);
  }
  if (body.whyItMatters !== undefined) doc.whyItMatters = String(body.whyItMatters).trim();
  if (body.section !== undefined) {
    if (!SECTIONS.includes(body.section as Section)) throw new CustomError("Sección inválida", 400);
    doc.section = body.section;
  }
  if (body.status !== undefined) {
    if (!TEASER_STATUSES.includes(body.status as TeaserStatus))
      throw new CustomError("Estado inválido", 400);
    if (body.status === "published" && !doc.publishedAt) doc.publishedAt = new Date();
    doc.status = body.status;
  }
  await doc.save();
  return doc.toJSON();
}

export async function removeTeaser(id: string) {
  if (!isValidObjectId(id)) throw new CustomError("Tráiler no encontrado", 404);
  const result = await ProTeaser.findByIdAndDelete(id);
  if (!result) throw new CustomError("Tráiler no encontrado", 404);
  return { ok: true };
}

// ——— Leads de venta

const PLAN_NAMES: Record<ProPlan, string> = {
  semanal: "Informe semanal (desde USD 1.500 al mes)",
  diario: "Informe semanal + notificaciones diarias 24/7 (hasta USD 3.000 al mes)",
};

export async function createLead(body: Record<string, unknown>) {
  const str = (key: string, max = 200) =>
    String(body[key] ?? "")
      .trim()
      .slice(0, max);
  const email = str("email").toLowerCase();
  const name = str("name", 120);
  const company = str("company", 160);
  if (!name) throw new CustomError("Escribe tu nombre", 400);
  if (!EMAIL_RX.test(email)) throw new CustomError("Ingresa un correo válido", 400);
  if (!company) throw new CustomError("Escribe el nombre de tu empresa", 400);
  const plan = PRO_PLANS.includes(body.plan as ProPlan) ? (body.plan as ProPlan) : "semanal";

  const lead: any = await ProLead.create({
    name,
    email,
    company,
    phone: str("phone", 40),
    role: str("role", 120),
    plan,
    wantsMeeting: body.wantsMeeting === true,
    message: str("message", 2000),
  });

  // Aviso a ventas: si pidió reunión, se agenda con un ejecutivo.
  const rows = [
    ["Nombre", lead.name],
    ["Cargo", lead.role || "—"],
    ["Empresa", lead.company],
    ["Correo", lead.email],
    ["Teléfono", lead.phone || "—"],
    ["Plan", PLAN_NAMES[lead.plan as ProPlan]],
    ["Pide reunión", lead.wantsMeeting ? "Sí" : "No"],
    ["Mensaje", lead.message || "—"],
  ]
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#71717a">${k}</td><td>${escapeHtml(v)}</td></tr>`,
    )
    .join("");
  await sendEmail(
    env.ADMIN_EMAIL,
    `Nuevo interesado en OTR PRO: ${lead.company}`,
    layout("Nuevo interesado en OTR PRO", `<table>${rows}</table>`),
  );
  await sendEmail(
    email,
    "Recibimos tu solicitud de Off the Record PRO",
    layout(
      "Recibimos tu solicitud",
      `<p>Hola ${escapeHtml(name)},</p>
       <p>Gracias por tu interés en Off the Record PRO para ${escapeHtml(company)}. ${
         lead.wantsMeeting
           ? "Un ejecutivo te escribirá en las próximas horas para agendar la reunión."
           : "Te enviaremos la propuesta y los pasos para activar el servicio en las próximas horas."
       }</p>`,
    ),
  );
  return {
    lead: lead.toJSON(),
    message: lead.wantsMeeting
      ? "Listo. Un ejecutivo te escribirá en las próximas horas para agendar la reunión."
      : "Listo. Te enviaremos la propuesta a tu correo en las próximas horas.",
  };
}

export async function listLeads(query: { status?: string; page?: unknown }) {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  return paginate(ProLead, filter, { page: query.page, limit: 30, sort: { createdAt: -1 } });
}

export async function setLeadStatus(id: string, status: unknown) {
  if (!isValidObjectId(id)) throw new CustomError("Solicitud no encontrada", 404);
  if (!LEAD_STATUSES.includes(status as LeadStatus)) throw new CustomError("Estado inválido", 400);
  const doc = await ProLead.findByIdAndUpdate(id, { status }, { new: true });
  if (!doc) throw new CustomError("Solicitud no encontrada", 404);
  return doc.toJSON();
}
