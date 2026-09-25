import express, { Application } from "express";
import authRoutes from "./auth.routes";
import healthRoutes from "./health.routes";
import cronRoutes from "./cron.routes";
import articleRoutes from "./article.routes";
import subscriberRoutes from "./subscriber.routes";
import tipRoutes from "./tip.routes";
import telegramRoutes from "./telegram.routes";
import adminRoutes from "./admin.routes";

function routerApi(app: Application) {
  const router = express.Router();
  app.use("/api", router);

  router.use("/health", healthRoutes);
  router.use("/auth", authRoutes);
  router.use("/cron", cronRoutes);
  router.use("/articles", articleRoutes);
  router.use("/subscribers", subscriberRoutes);
  router.use("/tips", tipRoutes);
  router.use("/telegram", telegramRoutes);
  router.use("/admin", adminRoutes);
}

export default routerApi;
