import { Request, Response, NextFunction } from "express";
import { CustomError } from "../errors/customError.error";
import * as telegramService from "../services/telegram.service";

/**
 * POST /api/telegram/webhook
 * Se procesa antes de responder: en Vercel la función se congela al enviar la
 * respuesta. Los errores internos no salen como 5xx para que Telegram no reintente.
 */
export async function webhook(req: Request, res: Response, next: NextFunction) {
  try {
    if (!telegramService.isValidSecret(req.headers["x-telegram-bot-api-secret-token"])) {
      throw new CustomError("No autorizado", 401);
    }
    await telegramService.handleUpdate(req.body ?? {});
    res.status(200).json({ ok: true });
  } catch (error) {
    next(error);
  }
}
