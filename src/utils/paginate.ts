import { Model } from "mongoose";

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pages: number;
}

export function pageParams(page: unknown, limit: unknown, defaultLimit = 20, maxLimit = 100) {
  const p = Math.max(1, Number.parseInt(String(page ?? "1"), 10) || 1);
  const l = Math.min(
    maxLimit,
    Math.max(1, Number.parseInt(String(limit ?? defaultLimit), 10) || defaultLimit),
  );
  return { page: p, limit: l, skip: (p - 1) * l };
}

/** Consulta paginada con la forma del contrato: { items, total, page, pages }. */
export async function paginate<T>(
  model: Model<any>,
  filter: Record<string, unknown>,
  opts: {
    page: unknown;
    limit?: unknown;
    sort: Record<string, 1 | -1>;
    select?: string;
    defaultLimit?: number;
  },
  map: (doc: any) => T = (doc) => doc.toJSON(),
): Promise<Paginated<T>> {
  const { page, limit, skip } = pageParams(opts.page, opts.limit, opts.defaultLimit);
  const query = model.find(filter).sort(opts.sort).skip(skip).limit(limit);
  if (opts.select) query.select(opts.select);
  const [docs, total] = await Promise.all([query, model.countDocuments(filter)]);
  return { items: docs.map(map), total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
