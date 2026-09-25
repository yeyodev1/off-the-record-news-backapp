import { Router, Request, Response, NextFunction } from "express";
import { env } from "../config/env";
import { dbConnect, isConnected } from "../config/mongo";
import { CustomError } from "../errors/customError.error";

const router = Router();

/**
 * Solo Vercel Cron puede disparar esto.
 *
 * Vercel manda `Authorization: Bearer $CRON_SECRET` en cada corrida. Sin el
 * secreto configurado la ruta queda cerrada: es preferible que la tarea no
 * ocurra a que cualquiera desde internet pueda dispararla.
 */
function soloCron(req: Request, _res: Response, next: NextFunction) {
  if (!env.CRON_SECRET) {
    return next(new CustomError("CRON_SECRET no está configurado", 503));
  }
  if (req.headers.authorization !== `Bearer ${env.CRON_SECRET}`) {
    return next(new CustomError("No autorizado", 401));
  }
  next();
}

/**
 * GET /api/cron/ping — tarea de ejemplo (ver `crons` en vercel.json).
 * Vercel Cron solo hace GET, de ahí el verbo aunque la tarea escriba.
 */
router.get("/ping", soloCron, async (_req, res, next) => {
  try {
    if (!isConnected() && !(await dbConnect())) {
      throw new CustomError("Sin base de datos", 503);
    }
    console.log("[cron] ping");
    res.status(200).json({ ok: true, at: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

export default router;
