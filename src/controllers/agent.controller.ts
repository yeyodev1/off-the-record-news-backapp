import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/AuthRequest";
import * as agentConfigService from "../services/agentConfig.service";

/** GET /api/admin/agents */
export async function list(_req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await agentConfigService.list());
  } catch (error) {
    next(error);
  }
}

/** PUT /api/admin/agents/:agent/:section — body: { rules: string[] } */
export async function save(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res
      .status(200)
      .json(
        await agentConfigService.save(
          String(req.params.agent),
          String(req.params.section),
          req.body,
          req.user?.userId,
        ),
      );
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/admin/agents/:agent/:section — vuelve al original. */
export async function reset(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res
      .status(200)
      .json(await agentConfigService.reset(String(req.params.agent), String(req.params.section)));
  } catch (error) {
    next(error);
  }
}
