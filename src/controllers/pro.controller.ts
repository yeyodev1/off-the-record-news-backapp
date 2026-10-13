import { Request, Response, NextFunction } from "express";
import { AuthRequest } from "../types/AuthRequest";
import { actorName } from "../utils/actor";
import * as proService from "../services/pro.service";

const q = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** GET /api/pro/teasers */
export async function teasers(_req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await proService.publicTeasers());
  } catch (error) {
    next(error);
  }
}

/** POST /api/pro/leads */
export async function createLead(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await proService.createLead(req.body ?? {}));
  } catch (error) {
    next(error);
  }
}

// ——— Admin

/** GET /api/admin/pro/teasers?status=&page= */
export async function adminTeasers(req: Request, res: Response, next: NextFunction) {
  try {
    res
      .status(200)
      .json(await proService.listTeasers({ status: q(req.query.status), page: req.query.page }));
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/pro/teasers/from-text — body: { text } */
export async function teaserFromText(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res
      .status(201)
      .json(await proService.teaserFromText(String(req.body?.text ?? ""), await actorName(req)));
  } catch (error) {
    next(error);
  }
}

/** PUT /api/admin/pro/teasers/:id */
export async function updateTeaser(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await proService.updateTeaser(String(req.params.id), req.body ?? {}));
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/admin/pro/teasers/:id */
export async function removeTeaser(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await proService.removeTeaser(String(req.params.id)));
  } catch (error) {
    next(error);
  }
}

/** GET /api/admin/pro/leads?status=&page= */
export async function adminLeads(req: Request, res: Response, next: NextFunction) {
  try {
    res
      .status(200)
      .json(await proService.listLeads({ status: q(req.query.status), page: req.query.page }));
  } catch (error) {
    next(error);
  }
}

/** PUT /api/admin/pro/leads/:id — body: { status } */
export async function setLeadStatus(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await proService.setLeadStatus(String(req.params.id), req.body?.status));
  } catch (error) {
    next(error);
  }
}
