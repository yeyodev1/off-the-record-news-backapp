import { Router } from "express";
import * as proController from "../controllers/pro.controller";

const router = Router();

router.get("/teasers", proController.teasers);
router.post("/leads", proController.createLead);

export default router;
