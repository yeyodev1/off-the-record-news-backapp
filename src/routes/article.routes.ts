import { Router } from "express";
import * as articleController from "../controllers/article.controller";

const router = Router();

// /top antes de /:slug para que no lo capture como slug.
router.get("/", articleController.list);
router.get("/top", articleController.top);
router.get("/:slug", articleController.bySlug);

export default router;
