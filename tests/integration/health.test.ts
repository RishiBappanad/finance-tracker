import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../../artifacts/api-server/src/app.js";

describe("GET /api/healthz", () => {
  it("returns 200 with status ok", async () => {
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("responds with JSON content-type", async () => {
    const res = await request(app).get("/api/healthz");
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });

  it("returns 404 for unknown routes", async () => {
    const res = await request(app).get("/api/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("returns 404 for routes without /api prefix", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(404);
  });
});
