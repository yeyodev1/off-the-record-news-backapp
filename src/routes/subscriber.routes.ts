import { Router } from "express";
import * as subscriberController from "../controllers/subscriber.controller";

const router = Router();

router.post("/", subscriberController.register);
router.get("/unsubscribe/:token", subscriberController.unsubscribe);

export default router;
