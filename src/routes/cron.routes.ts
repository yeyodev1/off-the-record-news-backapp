import { Router, Request, Response, NextFunction } from "express";
import { env } from "../config/env";
import { dbConnect, isConnected } from "../config/mongo";
import { CustomError } from "../errors/customError.error";
import * as cronController from "../controllers/cron.controller";

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

/** Las tareas escriben en la base: se asegura la conexión antes de correrlas. */
async function conBase(_req: Request, _res: Response, next: NextFunction) {
  if (!isConnected() && !(await dbConnect())) {
    return next(new CustomError("Sin base de datos", 503));
  }
  next();
}

// Vercel Cron solo hace GET, de ahí el verbo aunque las tareas escriban.
router.use(soloCron, conBase);

router.get("/newsroom", cronController.newsroom);
router.get("/newsletter/manana", cronController.newsletterManana);
router.get("/newsletter/noche", cronController.newsletterNoche);
router.get("/subscriptions", cronController.subscriptions);

export default router;
