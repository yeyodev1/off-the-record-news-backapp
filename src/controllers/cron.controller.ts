import { Request, Response, NextFunction } from "express";
import * as newsletterService from "../services/newsletter.service";
import * as newsroomService from "../services/newsroom.service";
import * as subscriberService from "../services/subscriber.service";

/** GET /api/cron/newsroom — respeta el horario de la mesa. */
export async function newsroom(_req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await newsroomService.runCycle({ trigger: "cron", force: false }));
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
