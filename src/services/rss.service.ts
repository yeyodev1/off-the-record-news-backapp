import { XMLParser } from "fast-xml-parser";
import { decodeEntities, stripHtml, truncate } from "../utils/text";

/**
 * Lector de feeds RSS 2.0 y Atom. Cada medio arma su feed a su manera, así que
 * se normaliza a un item plano y la imagen se busca en varios lugares.
 */

const USER_AGENT = "OffTheRecordBot/1.0 (+https://offtherecord.ec; mesa de redacción)";
const FEED_TIMEOUT_MS = 10_000;
const PAGE_TIMEOUT_MS = 5_000;

export interface FeedItem {
  title: string;
  url: string;
  summary: string;
  imageUrl: string;
  publishedAt: Date | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  processEntities: true,
  htmlEntities: true,
});

type Node = Record<string, unknown> | string | undefined;

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Texto de un nodo que puede ser string, {#text}, {#cdata} o un arreglo. */
function text(node: unknown): string {
  if (node === undefined || node === null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return text(node[0]);
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    return text(obj["#cdata"] ?? obj["#text"] ?? "");
  }
  return "";
}

function attr(node: unknown, name: string): string {
  if (!node || typeof node !== "object") return "";
  return String((node as Record<string, unknown>)[`@_${name}`] ?? "");
}

function parseDate(value: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function firstImgInHtml(html: string): string {
  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? decodeEntities(match[1]) : "";
}

function imageFrom(item: Record<string, unknown>, html: string): string {
  const candidates: unknown[] = [
    ...asArray(item["media:content"] as Node),
    ...asArray(item["media:thumbnail"] as Node),
    ...asArray(
      (item["media:group"] as Record<string, unknown> | undefined)?.["media:content"] as Node,
    ),
  ];
  for (const c of candidates) {
    const url = attr(c, "url");
    const medium = attr(c, "medium");
    const type = attr(c, "type");
    if (url && (!medium || medium === "image") && (!type || type.startsWith("image"))) return url;
  }
  for (const enc of asArray(item.enclosure as Node)) {
    const url = attr(enc, "url");
    if (url && (attr(enc, "type").startsWith("image") || /\.(jpe?g|png|webp)/i.test(url)))
      return url;
  }
  const img = text(item.image);
  if (/^https?:\/\//.test(img)) return img;
  return firstImgInHtml(html);
}

function normalizeRss(item: Record<string, unknown>): FeedItem {
  const html = text(item["content:encoded"]) || text(item.description);
  const link = text(item.link) || attr(item.link, "href") || text(item.guid);
  return {
    title: stripHtml(text(item.title)),
    url: link.trim(),
    summary: truncate(stripHtml(text(item.description) || html), 600),
    imageUrl: imageFrom(item, html),
    publishedAt: parseDate(text(item.pubDate) || text(item["dc:date"])),
  };
}

function normalizeAtom(entry: Record<string, unknown>): FeedItem {
  const links = asArray(entry.link as Node);
  const alternate =
    links.find((l) => !attr(l, "rel") || attr(l, "rel") === "alternate") ?? links[0];
  const html = text(entry.content) || text(entry.summary);
  return {
    title: stripHtml(text(entry.title)),
    url: attr(alternate, "href") || text(alternate),
    summary: truncate(stripHtml(text(entry.summary) || html), 600),
    imageUrl: imageFrom(entry, html),
    publishedAt: parseDate(text(entry.published) || text(entry.updated)),
  };
}

/** Parsea XML de un feed. Lanza si no es RSS/Atom. */
export function parseFeed(xml: string): FeedItem[] {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const rss = doc.rss as Record<string, unknown> | undefined;
  const rdf = doc["rdf:RDF"] as Record<string, unknown> | undefined;
  const feed = doc.feed as Record<string, unknown> | undefined;

  let items: FeedItem[];
  if (rss?.channel) {
    const channel = asArray(rss.channel as Node)[0] as Record<string, unknown>;
    items = asArray(channel.item as Node).map((i) => normalizeRss(i as Record<string, unknown>));
  } else if (rdf) {
    items = asArray(rdf.item as Node).map((i) => normalizeRss(i as Record<string, unknown>));
  } else if (feed) {
    items = asArray(feed.entry as Node).map((e) => normalizeAtom(e as Record<string, unknown>));
  } else {
    throw new Error("El documento no es un feed RSS ni Atom");
  }
  return items.filter((i) => i.title && /^https?:\/\//.test(i.url));
}

export async function fetchFeed(url: string, limit = 25): Promise<FeedItem[]> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept:
        "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const xml = await response.text();
  return parseFeed(xml).slice(0, limit);
}

/** og:image de una página. Solo lee los primeros ~300 KB y nunca lanza. */
export async function fetchOgImage(pageUrl: string): Promise<string> {
  try {
    const response = await fetch(pageUrl, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    while (html.length < 300_000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    reader.cancel().catch(() => undefined);
    const match =
      html.match(/<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::url)?["']/i) ||
      html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
    const url = match ? decodeEntities(match[1]) : "";
    return /^https?:\/\//.test(url) ? url : "";
  } catch {
    return "";
  }
}
