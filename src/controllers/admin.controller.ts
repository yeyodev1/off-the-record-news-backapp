import { Request, Response, NextFunction } from "express";
import { EDITIONS, Edition } from "../models/subscriber.model";
import { CustomError } from "../errors/customError.error";
import * as adminService from "../services/admin.service";
import * as newsletterService from "../services/newsletter.service";
import * as newsroomService from "../services/newsroom.service";
import * as signalService from "../services/signal.service";
import * as sourceService from "../services/source.service";

const q = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** GET /api/admin/stats */
export async function stats(_req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await adminService.stats());
  } catch (error) {
    next(error);
  }
}

// ——— Señales

/** GET /api/admin/signals?status=&minScore=&page= */
export async function listSignals(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await signalService.list({
      status: q(req.query.status),
      minScore: q(req.query.minScore),
      page: req.query.page,
      limit: req.query.limit,
    });
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/signals/:id/draft */
export async function draftSignal(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await newsroomService.draftSignalById(String(req.params.id)));
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/signals/:id/discard */
export async function discardSignal(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await signalService.discard(String(req.params.id)));
  } catch (error) {
    next(error);
  }
}

// ——— Fuentes

/** GET /api/admin/sources?kind=&category= */
export async function listSources(req: Request, res: Response, next: NextFunction) {
  try {
    res
      .status(200)
      .json(await sourceService.list({ kind: q(req.query.kind), category: q(req.query.category) }));
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/sources */
export async function createSource(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await sourceService.create(req.body ?? {}));
  } catch (error) {
    next(error);
  }
}

/** PUT /api/admin/sources/:id */
export async function updateSource(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await sourceService.update(String(req.params.id), req.body ?? {}));
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/admin/sources/:id */
export async function deleteSource(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await sourceService.remove(String(req.params.id)));
  } catch (error) {
    next(error);
  }
}

// ——— Mesa de redacción

/** POST /api/admin/newsroom/run — body: { force? } */
export async function runNewsroom(req: Request, res: Response, next: NextFunction) {
  try {
    const run = await newsroomService.runCycle({
      trigger: "manual",
      force: req.body?.force === true,
    });
    res.status(200).json(run);
  } catch (error) {
    next(error);
  }
}

/** GET /api/admin/newsroom/runs?page= */
export async function listRuns(req: Request, res: Response, next: NextFunction) {
  try {
    res
      .status(200)
      .json(await newsroomService.listRuns({ page: req.query.page, limit: req.query.limit }));
  } catch (error) {
    next(error);
  }
}

// ——— Newsletters

/** GET /api/admin/newsletters?page= */
export async function listNewsletters(req: Request, res: Response, next: NextFunction) {
  try {
    res
      .status(200)
      .json(await newsletterService.list({ page: req.query.page, limit: req.query.limit }));
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/newsletters/preview — body: { edition } */
export async function previewNewsletter(req: Request, res: Response, next: NextFunction) {
  try {
    const edition = req.body?.edition as Edition;
    if (!EDITIONS.includes(edition)) throw new CustomError("Edición inválida", 400);
    res.status(201).json(await newsletterService.buildIssue(edition));
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/newsletters/:id/send */
export async function sendNewsletter(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await newsletterService.sendIssue(String(req.params.id)));
  } catch (error) {
    next(error);
  }
}
