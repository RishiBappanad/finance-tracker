import type { NodePgDatabase, NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import * as schema from "./schema";
import { domainEvents } from "./schema/domain_events";
import { evaluateGoalsForEvent } from "./goals-evaluation";

// insertDomainEvent is the one function in this file that's actually
// called with a db.transaction() callback's `tx` (BATCH_EVENTS_SPEC.md's
// batch route) as well as the plain `db` -- a PgTransaction isn't
// assignable to NodePgDatabase (it's missing `$client`, the live pool
// handle), so it needs this wider type. Nothing else here takes `tx`:
// evaluateGoalsForEvent/evaluateGoalsForDomainEvent always run after
// commit, on the plain `db` (see BATCH_EVENTS_SPEC.md's "All-or-nothing
// means the WRITES, not the side effects"), so their existing
// NodePgDatabase-only type is correct as-is.
export type DbOrTx = NodePgDatabase<typeof schema> | PgTransaction<NodePgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;

/**
 * Universal Event Contract backing-store writer -- the Drizzle sibling
 * of nutrition-insights' app/domain_events.py::log_domain_event(). Every
 * mutating route (create/update/delete) for an entity that should
 * appear in the Event Contract calls this, ideally as part of the same
 * unit of work as its actual write (this codebase doesn't wrap its own
 * writes in db.transaction() today -- see routes/*.ts -- so this simply
 * matches that existing sequential-await convention rather than
 * introducing transactions unprompted).
 *
 * `action` is "created" | "updated" | "deleted" -- combined with
 * `ownerType` into the stored eventType ("receipt_created", etc.),
 * matching the Core Event Shape's existing per-tracker event_type
 * convention. "met" | "exceeded" are two narrower actions added for
 * Goals (see goals-evaluation.ts's evaluateGoal) -- a goal doesn't get
 * created/updated/deleted when it transitions into or out of compliance,
 * so forcing that into one of the other three would misdescribe what
 * happened; combined with ownerType "goal" they produce eventType
 * "goal_met"/"goal_exceeded", additive and specific to that one caller.
 *
 * `occurredAt` is the entity's OWN business date if it has one (e.g. a
 * receipt's purchaseDate) -- pass it explicitly whenever the entity has
 * a meaningful date of its own; leave it undefined only for entities
 * with no such concept, where "when this happened" is genuinely just
 * "when this action was taken," and the column's own defaultNow() is
 * correct.
 *
 * After the insert, runs Goals' event-triggered evaluation
 * (evaluateGoalsForEvent) for every event EXCEPT one Goals logged
 * itself -- ownerType "goal" is the recursion guard, so a goal_met/
 * goal_exceeded event can never trigger re-evaluation of any goal. This
 * lives inside this function (rather than as a wrapper each route calls
 * separately) so every existing mutating route gets goal-checking for
 * free with no call-site changes, AND so tests/helpers/db-mock.ts's
 * existing no-op mock of this exact function continues to fully replace
 * this behavior in every mock-based test -- an app-layer wrapper tried
 * first sat outside that mock boundary and broke ~17 unrelated tests by
 * adding an unmocked `goals` table lookup to their DB-call sequence.
 *
 * Needs `.returning({ id })` (not just an insert) because Goals'
 * evaluation compares "with this event" vs. "without this event" -- see
 * goals-evaluation.ts's evaluateGoalTransition -- which requires knowing
 * the just-inserted row's own id to exclude it from the "before" query.
 */
// BATCH_EVENTS_SPEC.md's suggested default -- a plain constant, not
// configurable: large enough for a real bulk-log use case, small enough
// that a single request can't become a multi-minute transaction or an
// unbounded memory hold.
export const MAX_BATCH_SIZE = 200;

interface LogDomainEventParams {
  userId: number;
  ownerType: string;
  ownerId: string;
  action: "created" | "updated" | "deleted" | "met" | "exceeded";
  category?: string | null;
  amount?: number;
  label?: string | null;
  source?: string | null;
  sourceId?: string | null;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}

/** Just the insert half of logDomainEvent -- split out
 * (BATCH_EVENTS_SPEC.md) so a batch route can run N of these inside ONE
 * db.transaction(), with goal evaluation run afterward on the plain
 * `db`, not the transaction (see BATCH_EVENTS_SPEC.md's "All-or-nothing
 * means the WRITES, not the side effects" -- a goal_met/goal_exceeded
 * row from a batch write is best-effort, same as it already is for a
 * single write, not part of the batch's own atomic guarantee). Every
 * other existing call site keeps going through logDomainEvent below,
 * unchanged. */
export async function insertDomainEvent(
  db: DbOrTx,
  params: LogDomainEventParams,
): Promise<{ id: number; eventType: string }> {
  const eventType = `${params.ownerType}_${params.action}`;
  const [inserted] = await db
    .insert(domainEvents)
    .values({
      userId: params.userId,
      ownerType: params.ownerType,
      ownerId: params.ownerId,
      eventType,
      category: params.category ?? null,
      amount: params.amount ?? 0,
      label: params.label ?? null,
      source: params.source ?? null,
      sourceId: params.sourceId ?? null,
      metadataJson: JSON.stringify(params.metadata ?? {}),
      ...(params.occurredAt ? { occurredAt: params.occurredAt } : {}),
    })
    .returning({ id: domainEvents.id });
  return { id: inserted!.id, eventType };
}

/** Re-checks this event's own active goals (goals-evaluation.ts) against
 * the write that just happened -- the recursion guard (ownerType "goal"
 * never re-triggers) lives here, not in insertDomainEvent, since that
 * half has no opinion on what happens after its own insert. */
export async function evaluateGoalsForDomainEvent(
  db: NodePgDatabase<typeof schema>,
  params: LogDomainEventParams,
  inserted: { id: number; eventType: string },
): Promise<void> {
  if (params.ownerType === "goal") return;
  await evaluateGoalsForEvent(db, {
    id: inserted.id,
    userId: params.userId,
    category: params.category ?? null,
    eventType: inserted.eventType,
    ownerType: params.ownerType,
    action: params.action,
  });
}

export async function logDomainEvent(db: NodePgDatabase<typeof schema>, params: LogDomainEventParams): Promise<void> {
  const inserted = await insertDomainEvent(db, params);
  await evaluateGoalsForDomainEvent(db, params, inserted);
}
