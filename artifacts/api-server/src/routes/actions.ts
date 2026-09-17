/**
 * Cross-Tracker Actions -- POST /actions/{name}/run, per
 * workspace-notes/ACTIONS_CONTRACT_SPEC.md. finance-tracker's first
 * action: sync-cpi, populating cpi_snapshots (lib/db/src/cpi-sync.ts)
 * from the BLS public API (services/bls.ts) so Advanced Goals' inflation
 * adjustment (goals-evaluation.ts's inflationAdjustReference) has data to
 * read without ever calling out to BLS inline on the event-triggered
 * evaluation path. Auth is the same requireAuth every other route uses
 * (mounted in routes/index.ts) -- who calls this and how often is
 * entirely external (a person, a script, GCP Cloud Scheduler), per the
 * Actions Contract.
 */
import { Router } from "express";
import { upsertCpiSnapshots } from "@workspace/db";
import { db } from "@workspace/db";
import { fetchCpiSeries } from "../services/bls.js";

const router = Router();

// POST /actions/sync-cpi/run -- fetches recent CPI-U data and upserts it
// into cpi_snapshots. Safe to call repeatedly (upsert-by-period, per
// upsertCpiSnapshots) and safe to call when nothing's changed (BLS simply
// returns the same figures again). CPI is not user-scoped -- this is one
// global sync, not per-user.
router.post("/sync-cpi/run", async (_req, res) => {
  const endYear = new Date().getUTCFullYear();
  const startYear = endYear - 1; // covers "same_period_last_year" (1 year back) plus buffer for late BLS revisions

  try {
    const points = await fetchCpiSeries(startYear, endYear);
    const written = await upsertCpiSnapshots(db, points);
    res.json({ status: "ok", summary: { checked: points.length, created: written, updated: 0, skipped: 0 } });
  } catch (e: any) {
    // A failed sync is a legitimate "nothing changed" outcome for an
    // Actions Contract action (e.g. BLS is temporarily unreachable), not
    // a 500 that should alarm whoever's watching a Cloud Scheduler job's
    // exit code -- but it's still worth surfacing clearly so a human
    // reviewing the response (or a monitoring integration on top of it,
    // once one exists) can tell a real sync failure apart from success.
    res.status(502).json({ status: "error", error: e?.message ?? "sync-cpi failed" });
  }
});

export default router;
