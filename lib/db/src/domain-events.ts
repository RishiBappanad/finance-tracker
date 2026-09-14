import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { domainEvents } from "./schema/domain_events";

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
 * convention.
 *
 * `occurredAt` is the entity's OWN business date if it has one (e.g. a
 * receipt's purchaseDate) -- pass it explicitly whenever the entity has
 * a meaningful date of its own; leave it undefined only for entities
 * with no such concept, where "when this happened" is genuinely just
 * "when this action was taken," and the column's own defaultNow() is
 * correct.
 */
export async function logDomainEvent(
  db: NodePgDatabase<typeof schema>,
  params: {
    userId: number;
    ownerType: string;
    ownerId: string;
    action: "created" | "updated" | "deleted";
    category?: string | null;
    amount?: number;
    label?: string | null;
    source?: string | null;
    sourceId?: string | null;
    metadata?: Record<string, unknown>;
    occurredAt?: Date;
  }
): Promise<void> {
  await db.insert(domainEvents).values({
    userId: params.userId,
    ownerType: params.ownerType,
    ownerId: params.ownerId,
    eventType: `${params.ownerType}_${params.action}`,
    category: params.category ?? null,
    amount: params.amount ?? 0,
    label: params.label ?? null,
    source: params.source ?? null,
    sourceId: params.sourceId ?? null,
    metadataJson: JSON.stringify(params.metadata ?? {}),
    ...(params.occurredAt ? { occurredAt: params.occurredAt } : {}),
  });
}
