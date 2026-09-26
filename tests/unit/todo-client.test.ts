import { describe, it, expect, vi } from "vitest";
import { createTodoClient } from "../../artifacts/api-server/src/services/todo-client.js";

const todo = { title: "Rent", notes: "n", category: "finance", priority: 1, due_at: "2026-09-05T23:59:59.000Z" };

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
}

describe("todo client", () => {
  it("upserts by source with the caller's own credential and reports created vs. updated", async () => {
    const fetchImpl = fakeFetch(201, { id: 7 });
    const client = createTodoClient({ baseUrl: "https://gw/todo/", authorization: "Bearer pat-123", fetchImpl });
    expect(await client.upsertBySource("finance", "recurring-1-2026-09-01", todo)).toEqual({ ok: true, id: 7, created: true });

    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe("https://gw/todo/todos/by-source/finance/recurring-1-2026-09-01"); // no double slash
    expect(init.method).toBe("PUT");
    expect(init.headers.Authorization).toBe("Bearer pat-123");
    expect(JSON.parse(init.body)).toEqual(todo);

    expect((await createTodoClient({ baseUrl: "x", authorization: "a", fetchImpl: fakeFetch(200, { id: 7 }) }).upsertBySource("finance", "s", todo))).toMatchObject({ ok: true, created: false });
  });

  it("encodes the source id into the path", async () => {
    const fetchImpl = fakeFetch(200, { id: 1 });
    await createTodoClient({ baseUrl: "https://gw", authorization: "a", fetchImpl }).upsertBySource("finance", "a/b c", todo);
    expect((fetchImpl as any).mock.calls[0][0]).toBe("https://gw/todos/by-source/finance/a%2Fb%20c");
  });

  it("reports failures instead of throwing", async () => {
    const bad = await createTodoClient({ baseUrl: "https://gw", authorization: "a", fetchImpl: fakeFetch(401, { error: "unauthorized" }) }).upsertBySource("finance", "s", todo);
    expect(bad).toEqual({ ok: false, error: "todo-tracker returned 401: unauthorized" });

    const down = createTodoClient({ baseUrl: "https://gw", authorization: "a", fetchImpl: vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch });
    const result = await down.upsertBySource("finance", "s", todo);
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("ECONNREFUSED");

    const noId = await createTodoClient({ baseUrl: "https://gw", authorization: "a", fetchImpl: fakeFetch(200, { nope: 1 }) }).upsertBySource("finance", "s", todo);
    expect(noId.ok).toBe(false);
  });

  it("marks a to-do done via PATCH, and treats an already-deleted to-do as done", async () => {
    const fetchImpl = fakeFetch(200, { id: 7 });
    expect(await createTodoClient({ baseUrl: "https://gw", authorization: "Bearer p", fetchImpl }).markDone(7)).toEqual({ ok: true, gone: false });
    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe("https://gw/todos/7");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ status: "done" });

    expect(await createTodoClient({ baseUrl: "https://gw", authorization: "a", fetchImpl: fakeFetch(404, { error: "Todo not found" }) }).markDone(7)).toEqual({ ok: true, gone: true });
    expect((await createTodoClient({ baseUrl: "https://gw", authorization: "a", fetchImpl: fakeFetch(500, {}) }).markDone(7)).ok).toBe(false);
  });
});
