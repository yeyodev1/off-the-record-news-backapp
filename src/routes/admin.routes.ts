import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import { uploadMiddleware } from "../middlewares/upload.middleware";
import * as adminController from "../controllers/admin.controller";
import * as articleController from "../controllers/article.controller";
import * as subscriberController from "../controllers/subscriber.controller";
import * as tipController from "../controllers/tip.controller";
import * as modeController from "../controllers/mode.controller";
import * as proController from "../controllers/pro.controller";
import * as trainingController from "../controllers/training.controller";
import * as agentController from "../controllers/agent.controller";

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
router.post("/articles/:id/lens", articleController.relens);
router.post("/articles/:id/updates/:updateId/publish", articleController.publishUpdate);
router.post("/articles/:id/updates/:updateId/reject", articleController.rejectUpdate);
router.post("/articles/:id/image", uploadMiddleware.single("image"), articleController.uploadImage);

// Modos de lectura
router.get("/modes/stats", modeController.stats);
router.get("/modes/golden", modeController.golden);

// OTR PRO: tráileres de portada y empresas interesadas
router.get("/pro/teasers", proController.adminTeasers);
router.post("/pro/teasers/from-text", proController.teaserFromText);
router.put("/pro/teasers/:id", proController.updateTeaser);
router.delete("/pro/teasers/:id", proController.removeTeaser);
router.get("/pro/leads", proController.adminLeads);
router.put("/pro/leads/:id", proController.setLeadStatus);

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
router.post("/sources/sync", adminController.syncSources);
router.post("/sources/import", adminController.importSources);
router.put("/sources/:id", adminController.updateSource);
router.delete("/sources/:id", adminController.deleteSource);

// Mesa de redacción
router.post("/newsroom/run", adminController.runNewsroom);
router.get("/newsroom/runs", adminController.listRuns);

// La mesa por dentro: proceso en vivo e instrucciones de la Mesa para la IA
router.get("/training/live", trainingController.live);
router.post("/training/try", trainingController.tryHeadline);
router.post("/training/chat", trainingController.chat);
router.post("/training/chat/apply", trainingController.applyChat);
router.get("/training/lessons", trainingController.listLessons);
router.post("/training/lessons", trainingController.createLesson);
router.put("/training/lessons/:id", trainingController.updateLesson);
router.delete("/training/lessons/:id", trainingController.removeLesson);
// Comportamiento base de cada agente: reglas editables por sección
router.get("/agents", agentController.list);
router.put("/agents/:agent/:section", agentController.save);
router.delete("/agents/:agent/:section", agentController.reset);

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
