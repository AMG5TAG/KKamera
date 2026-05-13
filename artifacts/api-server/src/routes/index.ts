import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import usersRouter from "./users.js";
import subscriptionsRouter from "./subscriptions.js";
import affiliatesRouter from "./affiliates.js";
import cloudConnectionsRouter from "./cloudConnections.js";
import uploadsRouter from "./uploads.js";
import feedbackRouter from "./feedback.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(subscriptionsRouter);
router.use(affiliatesRouter);
router.use(cloudConnectionsRouter);
router.use(uploadsRouter);
router.use(feedbackRouter);

export default router;
