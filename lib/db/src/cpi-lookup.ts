/**
 * Read side of the cpi_snapshots cache -- used only by goals-evaluation.ts
 * for inflation-adjusting a reference value. Write side (the sync action)
 * is cpi-sync.ts; kept separate since only POST /actions/sync-cpi/run
 * ever writes here, while this read path runs on every goal evaluation
 * that has inflation_adjusted: true.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import * as schema from "./schema";
import { cpiSnapshots } from "./schema/cpi_snapshots";

type Database = NodePgDatabase<typeof schema>;

/** The cached CPI-U index value for the month `monthStartDate`
 * ("YYYY-MM-01") falls in, or null if that month hasn't been synced yet.
 * A missing snapshot is an ordinary, expected condition (this cache is
 * populated on an external schedule -- see cpi-sync.ts), not an error. */
export async function cpiIndexForMonth(db: Database, monthStartDate: string): Promise<number | null> {
  const [row] = await db.select().from(cpiSnapshots).where(eq(cpiSnapshots.period, monthStartDate));
  return row?.indexValue ?? null;
}
