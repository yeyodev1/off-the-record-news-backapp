import { isValidObjectId } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Signal } from "../models/signal.model";
import { paginate } from "../utils/paginate";

export async function list(query: {
  status?: string;
  minScore?: unknown;
  page?: unknown;
  limit?: unknown;
}) {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  const min = Number(query.minScore);
  if (query.minScore !== undefined && query.minScore !== "" && Number.isFinite(min)) {
    filter["score.total"] = { $gte: min };
  }
  return paginate(Signal, filter, {
    page: query.page,
    limit: query.limit,
    sort: { createdAt: -1 },
  });
}

export async function discard(id: string) {
  if (!isValidObjectId(id)) throw new CustomError("Señal no encontrada", 404);
  const signal = await Signal.findByIdAndUpdate(id, { status: "discarded" }, { new: true });
  if (!signal) throw new CustomError("Señal no encontrada", 404);
  return signal.toJSON();
}
