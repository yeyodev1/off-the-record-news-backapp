import { Request, Response, NextFunction } from "express";
import * as newsletterService from "../services/newsletter.service";
import * as newsroomService from "../services/newsroom.service";
import * as subscriberService from "../services/subscriber.service";
import * as lensService from "../services/lens.service";

// La función de Vercel vive 300 s; lo que sobre del ciclo se usa para la lente.
const FUNCTION_BUDGET_MS = 285_000;

/**
 * GET /api/cron/newsroom — respeta el horario de la mesa. Después, con el tiempo
 * que quede, pone lente por modo a las notas publicadas que no la tienen
 * (las anteriores a los modos o aquellas en que la IA falló). Eso corre a toda hora.
 */
export async function newsroom(_req: Request, res: Response, next: NextFunction) {
  const startedAt = Date.now();
  try {
    const run = await newsroomService.runCycle({ trigger: "cron", force: false });
    const deadline = startedAt + FUNCTION_BUDGET_MS - 20_000;
    const lensed =
      deadline - Date.now() > 20_000 ? await lensService.backfill(8, deadline).catch(() => 0) : 0;
    res.status(200).json({ ...run, lensed });
  } catch (error) {
    next(error);
  }
}

/** GET /api/cron/newsletter/manana */
export async function newsletterManana(_req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await newsletterService.buildAndSend("manana"));
  } catch (error) {
    next(error);
  }
}

/** GET /api/cron/newsletter/noche */
export async function newsletterNoche(_req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await newsletterService.buildAndSend("noche"));
  } catch (error) {
    next(error);
  }
}

/** GET /api/cron/subscriptions */
export async function subscriptions(_req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await subscriberService.expireOverdue());
  } catch (error) {
    next(error);
  }
}
