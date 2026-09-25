import { isValidObjectId } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Article, SECTION_NAMES, Section } from "../models/article.model";
import { NewsletterIssue } from "../models/newsletterIssue.model";
import { Edition, EDITIONS, Subscriber } from "../models/subscriber.model";
import { articleUrl, unsubscribeUrl } from "../utils/links";
import { paginate } from "../utils/paginate";
import { escapeHtml, mapLimit } from "../utils/text";
import * as anthropicService from "./anthropic.service";
import { layout, sendEmail } from "./email.service";

const UNSUBSCRIBE_PLACEHOLDER = "{{UNSUBSCRIBE_URL}}";
const MAX_ARTICLES = 10;
// Ecuador no tiene horario de verano: UTC-5 fijo.
const EC_OFFSET_MS = 5 * 3600_000;

const EDITION_TITLE: Record<Edition, string> = {
  manana: "Off the Record · Mañana",
  noche: "Off the Record · Noche",
  economia: "Off the Record · Economía",
  legislativo: "Off the Record · Asamblea",
};

/** 5:00 de hoy en Ecuador (o de ayer si todavía no son las 5). */
function todayFiveAmEcuador(now = new Date()): Date {
  const ec = new Date(now.getTime() - EC_OFFSET_MS);
  const five = new Date(
    Date.UTC(ec.getUTCFullYear(), ec.getUTCMonth(), ec.getUTCDate(), 5) + EC_OFFSET_MS,
  );
  return five.getTime() > now.getTime() ? new Date(five.getTime() - 24 * 3600_000) : five;
}

function filterFor(edition: Edition): Record<string, unknown> {
  const now = Date.now();
  switch (edition) {
    case "manana":
      return { status: "published", publishedAt: { $gte: new Date(now - 24 * 3600_000) } };
    case "noche":
      return { status: "published", publishedAt: { $gte: todayFiveAmEcuador() } };
    case "economia":
    case "legislativo":
      return {
        status: "published",
        section: edition,
        publishedAt: { $gte: new Date(now - 7 * 24 * 3600_000) },
      };
  }
}

function articleBlock(a: any): string {
  const section = SECTION_NAMES[a.section as Section] ?? "";
  return `
    <tr><td style="padding:18px 0;border-top:1px solid #e4e4e7">
      <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#71717a">${escapeHtml(section)}</div>
      <a href="${articleUrl(a.slug)}" style="display:block;margin:4px 0 8px;font-size:18px;font-weight:bold;color:#111;text-decoration:none">${escapeHtml(a.title)}</a>
      <p style="margin:0 0 6px">${escapeHtml(a.lede)}</p>
      ${a.whyItMatters ? `<p style="margin:0"><strong>Por qué importa:</strong> ${escapeHtml(a.whyItMatters)}</p>` : ""}
    </td></tr>`;
}

function renderHtml(edition: Edition, intro: string, articles: any[]): string {
  const body = `
    <p style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#71717a;margin:0 0 4px">La historia del día</p>
    <p style="margin:0 0 16px">${escapeHtml(intro)}</p>
    <table width="100%" cellpadding="0" cellspacing="0">${articles.map(articleBlock).join("")}</table>
    <p style="margin-top:24px;font-size:12px;color:#71717a">Recibes este correo porque te suscribiste a Off the Record. <a href="${UNSUBSCRIBE_PLACEHOLDER}" style="color:#71717a">Darte de baja</a>.</p>`;
  return layout(EDITION_TITLE[edition], body);
}

export async function buildIssue(edition: Edition) {
  if (!EDITIONS.includes(edition)) throw new CustomError("Edición inválida", 400);
  const articles = await Article.find(filterFor(edition))
    .sort({ "score.total": -1, publishedAt: -1 })
    .limit(MAX_ARTICLES);
  if (!articles.length) throw new CustomError("No hay notas publicadas para esta edición", 404);

  const { subject, intro } = await anthropicService.newsletterIntro(
    articles.map((a: any) => ({ title: a.title, lede: a.lede, section: a.section })),
    edition,
  );

  const issue = await NewsletterIssue.create({
    edition,
    subject: subject.trim() || EDITION_TITLE[edition],
    intro,
    html: renderHtml(edition, intro, articles),
    articleIds: articles.map((a: any) => a._id),
    status: "draft",
  });
  return issue.toJSON();
}

export async function sendIssue(id: string) {
  if (!isValidObjectId(id)) throw new CustomError("Edición no encontrada", 404);
  const issue = await NewsletterIssue.findById(id);
  if (!issue) throw new CustomError("Edición no encontrada", 404);
  if (issue.status === "sent") throw new CustomError("Esta edición ya fue enviada", 409);

  const subscribers = await Subscriber.find({ status: "active", editions: issue.edition }).select(
    "email unsubscribeToken",
  );

  // Resend limita la tasa de envío; dos en paralelo es suficiente para esta escala.
  const results = await mapLimit(subscribers, 2, (sub: any) =>
    sendEmail(
      sub.email,
      issue.subject,
      issue.html.replace(UNSUBSCRIBE_PLACEHOLDER, unsubscribeUrl(sub.unsubscribeToken)),
    ),
  );

  issue.status = "sent";
  issue.recipients = results.filter(Boolean).length;
  issue.sentAt = new Date();
  await issue.save();
  return issue.toJSON();
}

export async function list(query: { page?: unknown; limit?: unknown }) {
  return paginate(
    NewsletterIssue,
    {},
    { page: query.page, limit: query.limit, sort: { createdAt: -1 } },
  );
}

/** Para el cron: arma y envía. Si no hay notas, no es un error. */
export async function buildAndSend(edition: Edition) {
  try {
    const issue = await buildIssue(edition);
    return await sendIssue(issue.id);
  } catch (error) {
    if (error instanceof CustomError && error.status === 404) {
      return { skipped: true, message: error.message };
    }
    throw error;
  }
}
