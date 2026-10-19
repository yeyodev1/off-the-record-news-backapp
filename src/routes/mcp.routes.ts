import { Router } from "express";
import * as mcpController from "../controllers/mcp.controller";

const router = Router();

router.post("/:token", mcpController.handle);
router.get("/:token", mcpController.notAllowed);
router.delete("/:token", mcpController.notAllowed);

export default router;
