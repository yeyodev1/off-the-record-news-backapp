import { Request, Response, NextFunction } from "express";
import * as tipService from "../services/tip.service";

/** POST /api/tips — body: { name?, contact?, text } */
export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await tipService.createWebTip(req.body ?? {}));
  } catch (error) {
    next(error);
  }
}

// ——— Admin

/** GET /api/admin/tips?status=&page= */
export async function adminList(req: Request, res: Response, next: NextFunction) {
  try {
    const status =
      typeof req.query.status === "string" && req.query.status ? req.query.status : undefined;
    res
      .status(200)
      .json(await tipService.adminList({ status, page: req.query.page, limit: req.query.limit }));
  } catch (error) {
    next(error);
  }
}

/** PUT /api/admin/tips/:id — body: { status } */
export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await tipService.updateStatus(String(req.params.id), req.body?.status));
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/tips/:id/draft */
export async function draft(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await tipService.draftFromTip(String(req.params.id)));
  } catch (error) {
    next(error);
  }
}
