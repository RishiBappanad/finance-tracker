/**
 * Write side of the cpi_snapshots cache -- separate from goals-baseline.ts
 * (which only reads this cache) since only POST /actions/sync-cpi/run
 * (routes/actions.ts) ever calls this; the event-triggered evaluation
 * path never writes here.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "./schema";
import { cpiSnapshots } from "./schema/cpi_snapshots";

type Database = NodePgDatabase<typeof schema>;

export interface CpiSnapshotInput {
  period: string; // "YYYY-MM-01"
  indexValue: number;
}

/** Upserts each snapshot by `period` -- safe to call repeatedly with
 * overlapping ranges (the Actions Contract's own requirement that an
 * action be safe to call repeatedly), since BLS may revise a recent
 * month's figure between two syncs and the later value should win. */
export async function upsertCpiSnapshots(db: Database, snapshots: CpiSnapshotInput[]): Promise<number> {
  let written = 0;
  for (const snapshot of snapshots) {
    await db
      .insert(cpiSnapshots)
      .values({ period: snapshot.period, indexValue: snapshot.indexValue })
      .onConflictDoUpdate({
        target: cpiSnapshots.period,
        set: { indexValue: snapshot.indexValue, fetchedAt: sql`now()` },
      });
    written++;
  }
  return written;
}
