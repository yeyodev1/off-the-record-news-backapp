import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import { uploadMiddleware } from "../middlewares/upload.middleware";
import * as adminController from "../controllers/admin.controller";
import * as articleController from "../controllers/article.controller";
import * as subscriberController from "../controllers/subscriber.controller";
import * as tipController from "../controllers/tip.controller";

const router = Router();

router.use(authMiddleware, adminMiddleware);

router.get("/stats", adminController.stats);

// Notas (from-text antes de /:id)
router.get("/articles", articleController.adminList);
router.post("/articles", articleController.create);
router.post("/articles/from-text", articleController.fromText);
router.get("/articles/:id", articleController.adminGet);
router.put("/articles/:id", articleController.update);
router.delete("/articles/:id", articleController.remove);
router.post("/articles/:id/publish", articleController.publish);
router.post("/articles/:id/reject", articleController.reject);
router.post("/articles/:id/rewrite", articleController.rewrite);
router.post("/articles/:id/retract", articleController.retract);
router.post("/articles/:id/wait", articleController.wait);
router.post("/articles/:id/updates/:updateId/publish", articleController.publishUpdate);
router.post("/articles/:id/updates/:updateId/reject", articleController.rejectUpdate);
router.post("/articles/:id/image", uploadMiddleware.single("image"), articleController.uploadImage);

// Señales
router.get("/signals", adminController.listSignals);
router.post("/signals/:id/draft", adminController.draftSignal);
router.post("/signals/:id/discard", adminController.discardSignal);

// Hechos
router.get("/stories", adminController.listStories);
router.get("/stories/:id", adminController.getStory);
router.post("/stories/:id/draft", adminController.draftStory);
router.post("/stories/:id/discard", adminController.discardStory);

// Telegram
router.get("/telegram", adminController.telegramTeam);
router.post("/telegram/configure", adminController.configureTelegram);
router.put("/telegram/members/:id", adminController.setTelegramRole);
router.delete("/telegram/members/:id", adminController.removeTelegramMember);

// Fuentes
router.get("/sources", adminController.listSources);
router.post("/sources", adminController.createSource);
router.put("/sources/:id", adminController.updateSource);
router.delete("/sources/:id", adminController.deleteSource);

// Mesa de redacción
router.post("/newsroom/run", adminController.runNewsroom);
router.get("/newsroom/runs", adminController.listRuns);

// Suscriptores
router.get("/subscribers", subscriberController.adminList);
router.post("/subscribers/:id/activate", subscriberController.activate);
router.post("/subscribers/:id/cancel", subscriberController.cancel);

// Denuncias
router.get("/tips", tipController.adminList);
router.put("/tips/:id", tipController.update);
router.post("/tips/:id/draft", tipController.draft);

// Newsletters
router.get("/newsletters", adminController.listNewsletters);
router.post("/newsletters/preview", adminController.previewNewsletter);
router.post("/newsletters/:id/send", adminController.sendNewsletter);

export default router;
