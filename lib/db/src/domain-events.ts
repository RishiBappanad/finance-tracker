import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { domainEvents } from "./schema/domain_events";
import { evaluateGoalsForEvent } from "./goals-evaluation";

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
export async function logDomainEvent(
  db: NodePgDatabase<typeof schema>,
  params: {
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
): Promise<void> {
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

  if (params.ownerType === "goal") return;
  await evaluateGoalsForEvent(db, {
    id: inserted!.id,
    userId: params.userId,
    category: params.category ?? null,
    eventType,
    ownerType: params.ownerType,
  });
}
