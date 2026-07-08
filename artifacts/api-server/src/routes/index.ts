import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import accountsRouter from "./accounts.js";
import transactionsRouter from "./transactions.js";
import receiptsRouter from "./receipts.js";
import matchesRouter from "./matches.js";
import dashboardRouter from "./dashboard.js";
import categoriesRouter from "./categories.js";
import { requireAuth } from "../middlewares/auth.js";

const router: IRouter = Router();

// Public routes
router.use(healthRouter);
router.use("/auth", authRouter);

// Protected routes — require authentication
router.use("/accounts", requireAuth, accountsRouter);
router.use("/transactions", requireAuth, transactionsRouter);
router.use("/receipts", requireAuth, receiptsRouter);
router.use("/reconcile", requireAuth, matchesRouter);
router.use("/matches", requireAuth, matchesRouter);
router.use("/dashboard", requireAuth, dashboardRouter);
router.use("/categories", requireAuth, categoriesRouter);

export default router;
