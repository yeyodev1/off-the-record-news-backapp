import { isValidObjectId } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Edition, EDITIONS, Plan, PLANS, Subscriber } from "../models/subscriber.model";
import { escapeRegex, paginate } from "../utils/paginate";
import { escapeHtml } from "../utils/text";
import { unsubscribeUrl } from "../utils/links";
import { layout, sendEmail } from "./email.service";

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const EDITION_NAMES: Record<Edition, string> = {
  manana: "Mañana (5:00)",
  noche: "Noche (20:00)",
  economia: "Economía semanal",
  legislativo: "Asamblea semanal",
};

function unsubscribeFooter(token: string): string {
  return `<p style="margin-top:24px;font-size:12px;color:#71717a">¿No quieres recibir más correos? <a href="${unsubscribeUrl(token)}" style="color:#71717a">Darte de baja</a>.</p>`;
}

function registrationEmail(sub: any): string {
  const editions = (sub.editions as Edition[]).map((e) => EDITION_NAMES[e]).join(", ");
  const plan = sub.plan === "pro" ? "Off the Record Pro" : "Newsletter";
  return layout(
    "Recibimos tu suscripción",
    `<p>Hola${sub.name ? ` ${escapeHtml(sub.name)}` : ""},</p>
     <p>Registramos tu solicitud al plan <strong>${plan}</strong> con las ediciones: ${escapeHtml(editions)}.</p>
     <p>Tu suscripción queda <strong>pendiente de pago</strong>. Nuestro equipo te contactará en las próximas horas para coordinar el pago; apenas se confirme, la activamos y empiezas a recibir Off the Record.</p>
     ${unsubscribeFooter(sub.unsubscribeToken)}`,
  );
}

function activationEmail(sub: any): string {
  const until = sub.paidUntil
    ? `Tu suscripción está activa hasta el <strong>${new Date(sub.paidUntil).toLocaleDateString("es-EC", { timeZone: "America/Guayaquil", day: "numeric", month: "long", year: "numeric" })}</strong>.`
    : "Tu suscripción está activa y no tiene fecha de vencimiento.";
  return layout(
    "Tu suscripción está activa",
    `<p>Hola${sub.name ? ` ${escapeHtml(sub.name)}` : ""},</p>
     <p>Confirmamos tu pago. ${until}</p>
     <p>Desde la próxima edición recibirás Off the Record en este correo.</p>
     ${unsubscribeFooter(sub.unsubscribeToken)}`,
  );
}

export async function register(body: Record<string, unknown>) {
  const email = String(body.email ?? "")
    .trim()
    .toLowerCase();
  if (!EMAIL_RX.test(email)) throw new CustomError("Ingresa un correo válido", 400);

  const plan = (body.plan ?? "newsletter") as Plan;
  if (!PLANS.includes(plan)) throw new CustomError("Plan inválido", 400);

  const rawEditions = Array.isArray(body.editions) ? body.editions : [];
  const editions = [...new Set(rawEditions.map(String))].filter((e): e is Edition =>
    EDITIONS.includes(e as Edition),
  );
  if (!editions.length) throw new CustomError("Elige al menos una edición", 400);

  const name = String(body.name ?? "")
    .trim()
    .slice(0, 120);
  const company = String(body.company ?? "")
    .trim()
    .slice(0, 160);

  let sub = await Subscriber.findOne({ email });
  if (sub && sub.status === "active") {
    // No se degrada a una cuenta pagada: solo se actualizan preferencias.
    sub.set({ editions, ...(name ? { name } : {}), ...(company ? { company } : {}) });
    await sub.save();
    return {
      subscriber: sub.toJSON(),
      message: "Ya tienes una suscripción activa; actualizamos tus ediciones.",
    };
  }

  if (sub) {
    sub.set({
      plan,
      editions,
      name: name || sub.name,
      company: company || sub.company,
      status: "pending_payment",
    });
    await sub.save();
  } else {
    sub = await Subscriber.create({
      email,
      name,
      plan,
      editions,
      company,
      status: "pending_payment",
    });
  }

  await sendEmail(email, "Recibimos tu suscripción a Off the Record", registrationEmail(sub));
  return {
    subscriber: sub.toJSON(),
    message:
      "¡Listo! Te enviamos un correo de confirmación. Te contactaremos para coordinar el pago.",
  };
}

export async function unsubscribe(token: string) {
  const sub = await Subscriber.findOne({ unsubscribeToken: token });
  if (!sub) throw new CustomError("El enlace de baja no es válido", 404);
  sub.status = "canceled";
  await sub.save();
  return { message: "Te diste de baja. Ya no recibirás nuestros correos." };
}

export async function adminList(query: {
  status?: string;
  plan?: string;
  q?: string;
  page?: unknown;
  limit?: unknown;
}) {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  if (query.plan) filter.plan = query.plan;
  if (query.q) {
    const rx = new RegExp(escapeRegex(String(query.q)), "i");
    filter.$or = [{ email: rx }, { name: rx }, { company: rx }];
  }
  return paginate(Subscriber, filter, {
    page: query.page,
    limit: query.limit,
    sort: { createdAt: -1 },
  });
}

async function getDoc(id: string) {
  if (!isValidObjectId(id)) throw new CustomError("Suscriptor no encontrado", 404);
  const sub = await Subscriber.findById(id);
  if (!sub) throw new CustomError("Suscriptor no encontrado", 404);
  return sub;
}

/** El admin debe elegir explícitamente: fecha de vencimiento o "no vence". */
export async function activate(id: string, body: { paidUntil?: unknown; noExpiry?: unknown }) {
  const noExpiry = body.noExpiry === true;
  const hasDate = body.paidUntil !== undefined && body.paidUntil !== null && body.paidUntil !== "";
  if (!noExpiry && !hasDate) {
    throw new CustomError("Elige una fecha de vencimiento o marca que no vence", 400);
  }
  let paidUntil: Date | null = null;
  if (!noExpiry) {
    paidUntil = new Date(String(body.paidUntil));
    if (Number.isNaN(paidUntil.getTime()))
      throw new CustomError("La fecha de vencimiento no es válida", 400);
    if (paidUntil.getTime() < Date.now())
      throw new CustomError("La fecha de vencimiento ya pasó", 400);
  }
  const sub = await getDoc(id);
  const wasActive = sub.status === "active";
  sub.status = "active";
  sub.paidUntil = paidUntil;
  await sub.save();
  if (!wasActive)
    await sendEmail(sub.email, "Tu suscripción a Off the Record está activa", activationEmail(sub));
  return sub.toJSON();
}

export async function cancel(id: string) {
  const sub = await getDoc(id);
  sub.status = "canceled";
  await sub.save();
  return sub.toJSON();
}

/** Cron diario: vence las suscripciones activas con `paidUntil` pasado. */
export async function expireOverdue() {
  const result = await Subscriber.updateMany(
    { status: "active", paidUntil: { $ne: null, $lt: new Date() } },
    { status: "expired" },
  );
  return { expired: result.modifiedCount };
}
