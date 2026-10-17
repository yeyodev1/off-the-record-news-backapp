import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/AuthRequest";
import * as trainingService from "../services/training.service";
import * as lessonService from "../services/lesson.service";
import * as mesaChatService from "../services/mesaChat.service";

/** GET /api/admin/training/live?hours= */
export async function live(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await trainingService.live({ hours: req.query.hours }));
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/training/try — body: { title, summary?, sourceName? } */
export async function tryHeadline(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await trainingService.tryHeadline(req.body));
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/training/chat — body: { message, history? } */
export async function chat(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await mesaChatService.chat(req.body));
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/training/chat/apply — body: { proposal } */
export async function applyChat(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await mesaChatService.apply(req.body, req.user?.userId));
  } catch (error) {
    next(error);
  }
}

/** GET /api/admin/training/lessons */
export async function listLessons(_req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await lessonService.list());
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/training/lessons — body: { area, instruction, example? } */
export async function createLesson(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await lessonService.create(req.body, req.user?.userId));
  } catch (error) {
    next(error);
  }
}

/** PUT /api/admin/training/lessons/:id — body: { instruction?, area?, active? } */
export async function updateLesson(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await lessonService.update(String(req.params.id), req.body));
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/admin/training/lessons/:id */
export async function removeLesson(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await lessonService.remove(String(req.params.id));
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}
