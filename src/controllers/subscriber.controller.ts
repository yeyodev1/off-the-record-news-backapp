import { Request, Response, NextFunction } from "express";
import { env } from "../config/env";
import * as subscriberService from "../services/subscriber.service";

const q = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** POST /api/subscribers — body: { email, name?, plan, editions, company? } */
export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await subscriberService.register(req.body ?? {}));
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/subscribers/unsubscribe/:token
 * Desde un correo (navegador) redirige al front; desde el API responde { message }.
 */
export async function unsubscribe(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await subscriberService.unsubscribe(String(req.params.token));
    if (req.accepts(["json", "html"]) === "html") {
      res.redirect(302, `${env.FRONTEND_URL.replace(/\/+$/, "")}/boletines?baja=1`);
      return;
    }
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

// ——— Admin

/** GET /api/admin/subscribers?status=&plan=&q=&page= */
export async function adminList(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await subscriberService.adminList({
      status: q(req.query.status),
      plan: q(req.query.plan),
      q: q(req.query.q),
      page: req.query.page,
      limit: req.query.limit,
    });
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/subscribers/:id/activate — body: { paidUntil, noExpiry } */
export async function activate(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await subscriberService.activate(String(req.params.id), req.body ?? {}));
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/subscribers/:id/cancel */
export async function cancel(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await subscriberService.cancel(String(req.params.id)));
  } catch (error) {
    next(error);
  }
}
