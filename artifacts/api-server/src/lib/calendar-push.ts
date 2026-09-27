/**
 * The ONE place finance-tracker calls into trackstack-ui/calendar-client. Every
 * calendar-worthy write imports this single `pushCalendarEntry`, rather than each
 * call site constructing its own pusher -- this is the reusable convention any
 * future push site here (a new entity type) or in another tracker (its own
 * language's client, its own copy of this same shape) should follow. See
 * workspace-notes/CALENDAR_INTEGRATION_SPEC.md, "One push wrapper per tracker".
 *
 * Built once, lazily (first real call, not module load, so a request-less test
 * import never touches env), from CALENDAR_API_URL -- the gateway's real public
 * URL, same convention as TRACKSTACK_AUTH_URL, never a new internal-only address.
 * Memoized so a missing env var is discovered once, not re-checked per call.
 *
 * Calendar integration is OPTIONAL, per the spec: a tracker (or, here, a single
 * entity type) that never pushes just doesn't appear on the calendar. Absent
 * CALENDAR_API_URL, or with no Authorization header to forward, this is a silent
 * no-op -- exactly like the underlying client's own "never throws" contract, so a
 * caller never has to special-case "is calendar integration configured".
 */
import { createCalendarPusher, type CalendarEntryInput, type PushCalendarEntry } from "trackstack-ui/calendar-client";

const TRACKER_NAME = "finance";

let pusher: PushCalendarEntry | null | undefined; // undefined = not yet built; null = CALENDAR_API_URL isn't configured

function getPusher(): PushCalendarEntry | null {
  if (pusher === undefined) {
    const calendarBaseUrl = process.env.CALENDAR_API_URL;
    pusher = calendarBaseUrl ? createCalendarPusher({ calendarBaseUrl, tracker: TRACKER_NAME }) : null;
  }
  return pusher;
}

/** Resolves to whether the push was attempted and accepted -- never throws, never blocks its caller past the underlying client's own short timeout. */
export async function pushCalendarEntry(authHeader: string | undefined, entry: CalendarEntryInput): Promise<boolean> {
  const push = getPusher();
  if (!push || !authHeader) return false;
  return push(authHeader, entry);
}

/** Test-only: forces the next call to rebuild the pusher from the current env. */
export function _resetCalendarPusherForTests(): void {
  pusher = undefined;
}
