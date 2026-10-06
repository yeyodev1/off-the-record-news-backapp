import { Request, Response, NextFunction } from "express";
import * as modeService from "../services/mode.service";

/** POST /api/metrics/mode — body: { modo, event: "elegir" | "cambiar" } */
export async function track(req: Request, res: Response, next: NextFunction) {
  try {
    await modeService.track(req.body?.modo, req.body?.event);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

/** GET /api/admin/modes/stats?days= */
export async function stats(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await modeService.stats(req.query.days));
  } catch (error) {
    next(error);
  }
}

/** GET /api/admin/modes/golden */
export async function golden(_req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await modeService.golden());
  } catch (error) {
    next(error);
  }
}
