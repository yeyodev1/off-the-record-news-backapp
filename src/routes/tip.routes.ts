import { Router } from "express";
import * as tipController from "../controllers/tip.controller";

const router = Router();

router.post("/", tipController.create);

export default router;
