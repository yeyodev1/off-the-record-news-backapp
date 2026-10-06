import { Router } from "express";
import * as modeController from "../controllers/mode.controller";

const router = Router();

router.post("/mode", modeController.track);

export default router;
