import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import accountsRouter from "./accounts.js";
import transactionsRouter from "./transactions.js";
import receiptsRouter from "./receipts.js";
import matchesRouter from "./matches.js";
import dashboardRouter from "./dashboard.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/accounts", accountsRouter);
router.use("/transactions", transactionsRouter);
router.use("/receipts", receiptsRouter);
router.use("/reconcile", matchesRouter);
router.use("/matches", matchesRouter);
router.use("/dashboard", dashboardRouter);

export default router;
