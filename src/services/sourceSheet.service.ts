import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";
import { PEOPLE_CATEGORIES, Source, SourceCategory } from "../models/source.model";

/**
 * Repositorio de fuentes en un Google Sheet (pedido del fundador): los
 * periodistas agregan una fila y la mesa la empieza a vigilar sin tocar código.
 * El Sheet se publica como CSV y el cron lo trae cada hora. Columnas:
 * nombre, categoria, tipo, url, consulta, peso, cada_minutos, activa, notas.
 * Solo administra las fuentes que vinieron del Sheet: las que se crearon en el
 * panel no se tocan.
 */

const HEADERS = [
  "nombre",
  "categoria",
  "tipo",
  "url",
  "consulta",
  "peso",
  "cada_minutos",
  "activa",
  "notas",
];

/** CSV con comillas dobles, comas y saltos de línea dentro de una celda. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const plain = (s: string) =>
  s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, "_");

const CATEGORY_ALIASES: Record<string, SourceCategory> = {
  institucion: "institucion",
  instituciones: "institucion",
  estado: "institucion",
  medio: "medio",
  medios: "medio",
  prensa: "medio",
  radio: "medio",
  tv: "medio",
  television: "medio",
  digital: "medio",
  programa: "programa",
  noticiero: "programa",
  politico: "politico",
  politicos: "politico",
  periodista: "periodista",
  periodistas: "periodista",
  sociedad_civil: "sociedad_civil",
  sociedad: "sociedad_civil",
  activista: "sociedad_civil",
  articulista: "sociedad_civil",
  abogado: "sociedad_civil",
  internacional: "internacional",
  redes: "redes",
  viral: "redes",
};

const yes = (v: string) => !/^(no|false|0|inactiva|apagada)$/i.test(v.trim());

interface SheetRow {
  name: string;
  category: SourceCategory;
  kind: "rss" | "perplexity";
  url: string;
  query: string;
  weight: number;
  everyMinutes: number;
  isActive: boolean;
  notes: string;
}

export function rowsToSources(rows: string[][]): { items: SheetRow[]; errors: string[] } {
  const [header, ...body] = rows;
  if (!header) return { items: [], errors: ["El Sheet está vacío"] };
  const index = Object.fromEntries(HEADERS.map((h) => [h, header.map(plain).indexOf(h)]));
  if (index.nombre < 0) throw new CustomError("El Sheet necesita la columna 'nombre'", 400);
  const get = (r: string[], key: string) => (index[key] >= 0 ? (r[index[key]] ?? "").trim() : "");

  const items: SheetRow[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  body.forEach((r, i) => {
    const name = get(r, "nombre");
    if (!name) return;
    const line = i + 2;
    if (seen.has(name.toLowerCase())) {
      errors.push(`Fila ${line}: "${name}" está repetida`);
      return;
    }
    seen.add(name.toLowerCase());
    const category = CATEGORY_ALIASES[plain(get(r, "categoria"))] ?? "medio";
    const url = get(r, "url");
    const notes = get(r, "notas");
    const kind = plain(get(r, "tipo")) === "rss" ? "rss" : "perplexity";
    if (kind === "rss" && !/^https?:\/\//.test(url)) {
      errors.push(`Fila ${line}: "${name}" es RSS pero no tiene URL válida`);
      return;
    }
    const person = PEOPLE_CATEGORIES.includes(category);
    // Sin consulta escrita, se arma una con lo que haya; las personas se buscan en grupo.
    // Los links de la fila (web, cuenta de X) le dicen a la búsqueda dónde mirar primero.
    const links = [url, ...(notes.match(/https?:\/\/\S+/g) ?? [])].filter(Boolean);
    const lookAt = links.length ? `. Revisa primero: ${[...new Set(links)].join(", ")}` : "";
    const written = get(r, "consulta");
    const query =
      kind !== "perplexity" || person
        ? written
        : written
          ? `${written}${lookAt}`
          : `lo publicado hoy por ${name}${notes ? `, ${notes}` : ""}${lookAt}`;
    const weight = Number(get(r, "peso").replace(",", "."));
    const every = Number(get(r, "cada_minutos"));
    items.push({
      name,
      category,
      kind,
      url,
      query,
      weight: Number.isFinite(weight) && weight >= 0.5 && weight <= 2 ? weight : 1,
      everyMinutes: Number.isFinite(every) && every > 0 ? Math.round(every) : 0,
      isActive: get(r, "activa") ? yes(get(r, "activa")) : true,
      notes: person && url ? [notes, url].filter(Boolean).join(" · ") : notes,
    });
  });
  return { items, errors };
}

/** Aplica las filas: crea o actualiza por nombre y apaga lo que se borró del Sheet. */
export async function applyRows(items: SheetRow[]) {
  let created = 0;
  let updated = 0;
  for (const item of items) {
    const existing: any = await Source.findOne({ name: item.name });
    if (existing && !existing.fromSheet) continue; // la creó la Mesa en el panel
    if (existing) {
      existing.set(item);
      await existing.save();
      updated++;
    } else {
      await Source.create({ ...item, fromSheet: true });
      created++;
    }
  }
  const names = items.map((i) => i.name);
  const removed = await Source.updateMany(
    { fromSheet: true, isActive: true, name: { $nin: names } },
    { isActive: false, lastError: "Ya no está en el Sheet de fuentes" },
  );
  return { created, updated, deactivated: removed.modifiedCount };
}

export async function syncFromCsv(text: string) {
  const { items, errors } = rowsToSources(parseCsv(text));
  return { ...(await applyRows(items)), rows: items.length, errors };
}

export async function syncFromSheet() {
  if (!env.SOURCES_SHEET_CSV_URL) {
    return {
      skipped: "SOURCES_SHEET_CSV_URL no está configurada",
      created: 0,
      updated: 0,
      deactivated: 0,
    };
  }
  const response = await fetch(env.SOURCES_SHEET_CSV_URL, { signal: AbortSignal.timeout(30_000) });
  // Sheet privado: no es una falla del servidor, falta compartirlo "con cualquiera que tenga el enlace".
  if (response.status === 401 || response.status === 403) {
    return {
      skipped: "El Sheet no está compartido con enlace: Compartir → Cualquier persona con el enlace → Lector",
      created: 0,
      updated: 0,
      deactivated: 0,
    };
  }
  if (!response.ok) throw new CustomError(`El Sheet de fuentes respondió ${response.status}`, 502);
  return syncFromCsv(await response.text());
}
