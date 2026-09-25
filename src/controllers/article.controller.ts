import { Request, Response, NextFunction } from "express";
import * as articleService from "../services/article.service";

const q = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

// ——— Público

/** GET /api/articles?section=&tag=&page=&limit= */
export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await articleService.listPublished({
      section: q(req.query.section),
      tag: q(req.query.tag),
      page: req.query.page,
      limit: req.query.limit,
    });
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

/** GET /api/articles/top — portada. */
export async function top(_req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await articleService.getTop());
  } catch (error) {
    next(error);
  }
}

/** GET /api/articles/:slug */
export async function bySlug(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await articleService.getPublicBySlug(String(req.params.slug)));
  } catch (error) {
    next(error);
  }
}

// ——— Admin

/** GET /api/admin/articles?status=&section=&q=&page= */
export async function adminList(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await articleService.adminList({
      status: q(req.query.status),
      section: q(req.query.section),
      q: q(req.query.q),
      page: req.query.page,
      limit: req.query.limit,
    });
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

/** GET /api/admin/articles/:id */
export async function adminGet(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await articleService.getById(String(req.params.id)));
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/articles */
export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await articleService.createManual(req.body ?? {}));
  } catch (error) {
    next(error);
  }
}

/** PUT /api/admin/articles/:id */
export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await articleService.update(String(req.params.id), req.body ?? {}));
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/articles/:id/publish */
export async function publish(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await articleService.publish(String(req.params.id)));
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/articles/:id/reject */
export async function reject(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await articleService.reject(String(req.params.id)));
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/articles/:id/rewrite — body: { instructions } */
export async function rewrite(req: Request, res: Response, next: NextFunction) {
  try {
    const instructions = String(req.body?.instructions ?? "");
    res.status(200).json(await articleService.rewrite(String(req.params.id), instructions));
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/articles/:id/image — multipart `image`, body extra `credit` */
export async function uploadImage(req: Request, res: Response, next: NextFunction) {
  try {
    const credit = String(req.body?.credit ?? "");
    res.status(200).json(await articleService.setImage(String(req.params.id), req.file, credit));
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/admin/articles/:id */
export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await articleService.remove(String(req.params.id)));
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/articles/from-text — body: { text, sourceUrl? } */
export async function fromText(req: Request, res: Response, next: NextFunction) {
  try {
    const { text, sourceUrl } = req.body ?? {};
    res
      .status(201)
      .json(await articleService.fromText(String(text ?? ""), String(sourceUrl ?? "")));
  } catch (error) {
    next(error);
  }
}
