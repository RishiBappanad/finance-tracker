/**
 * The one place finance-tracker talks to todo-tracker over HTTP, per
 * workspace-notes/ACTIONS_CONTRACT_SPEC.md: a plain authenticated call, reusing
 * the credential the triggering request arrived with (in practice a personal
 * access token), no new auth mechanism.
 *
 *  - upsertBySource -> PUT /todos/by-source/:source/:source_id. todo-tracker
 *    overwrites title/notes/category/priority/due on EVERY such call (and leaves
 *    status alone), so callers must send an item once and remember its id rather
 *    than re-sending, or a person's edits to the to-do get reverted.
 *  - markDone -> PATCH /todos/:id {status: "done"}, the same request todo-tracker's
 *    own frontend makes when someone checks something off.
 *
 * Never throws: an action is best-effort across trackers (a todo-tracker outage
 * must not fail the rest of a sync run), so failures come back as `{ ok: false }`
 * for the caller to record and retry next run.
 */
import type { RenderedTodo } from "../lib/recurrence.js";

export type TodoResult<T> = ({ ok: true } & T) | { ok: false; error: string };

export interface TodoClient {
  upsertBySource(source: string, sourceId: string, todo: RenderedTodo): Promise<TodoResult<{ id: number; created: boolean }>>;
  markDone(todoId: number): Promise<TodoResult<{ gone: boolean }>>;
}

export interface TodoClientOptions {
  baseUrl: string; // e.g. https://<gateway>/todo -- `${baseUrl}/todos/...` must be todo-tracker's route
  authorization: string; // the full Authorization header value of the triggering request
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createTodoClient({ baseUrl, authorization, fetchImpl = fetch, timeoutMs = 5000 }: TodoClientOptions): TodoClient {
  const root = baseUrl.replace(/\/+$/, "");

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any } | { error: string }> {
    try {
      const res = await fetchImpl(`${root}${path}`, {
        method,
        headers: { Authorization: authorization, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    } catch (e: any) {
      return { error: e?.name === "TimeoutError" ? "todo-tracker timed out" : `todo-tracker unreachable: ${e?.message ?? e}` };
    }
  }

  return {
    async upsertBySource(source, sourceId, todo) {
      const r = await call("PUT", `/todos/by-source/${encodeURIComponent(source)}/${encodeURIComponent(sourceId)}`, todo);
      if ("error" in r) return { ok: false, error: r.error };
      if ((r.status === 200 || r.status === 201) && typeof r.json?.id === "number") return { ok: true, id: r.json.id, created: r.status === 201 };
      return { ok: false, error: `todo-tracker returned ${r.status}${r.json?.error ? `: ${r.json.error}` : ""}` };
    },

    async markDone(todoId) {
      const r = await call("PATCH", `/todos/${todoId}`, { status: "done" });
      if ("error" in r) return { ok: false, error: r.error };
      if (r.status === 200) return { ok: true, gone: false };
      // Someone deleted the to-do themselves: nothing left to close, and retrying can never succeed.
      if (r.status === 404) return { ok: true, gone: true };
      return { ok: false, error: `todo-tracker returned ${r.status}${r.json?.error ? `: ${r.json.error}` : ""}` };
    },
  };
}
