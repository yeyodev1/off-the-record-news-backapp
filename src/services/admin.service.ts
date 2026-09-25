import { Article } from "../models/article.model";
import { Signal } from "../models/signal.model";
import { Subscriber } from "../models/subscriber.model";
import { Tip } from "../models/tip.model";
import * as newsroomService from "./newsroom.service";

/** Medianoche de hoy en Ecuador (UTC-5 fijo). */
function startOfTodayEcuador(now = new Date()): Date {
  const offset = 5 * 3600_000;
  const ec = new Date(now.getTime() - offset);
  return new Date(Date.UTC(ec.getUTCFullYear(), ec.getUTCMonth(), ec.getUTCDate()) + offset);
}

export async function stats() {
  const today = startOfTodayEcuador();
  const [
    pending,
    publishedToday,
    publishedTotal,
    signalsToday,
    subscribersActive,
    subscribersPending,
    tipsNew,
    lastRun,
  ] = await Promise.all([
    Article.countDocuments({ status: "pending" }),
    Article.countDocuments({ status: "published", publishedAt: { $gte: today } }),
    Article.countDocuments({ status: "published" }),
    Signal.countDocuments({ createdAt: { $gte: today } }),
    Subscriber.countDocuments({ status: "active" }),
    Subscriber.countDocuments({ status: "pending_payment" }),
    Tip.countDocuments({ status: "new" }),
    newsroomService.lastRun(),
  ]);
  return {
    pending,
    publishedToday,
    publishedTotal,
    signalsToday,
    subscribersActive,
    subscribersPending,
    tipsNew,
    lastRun,
  };
}
