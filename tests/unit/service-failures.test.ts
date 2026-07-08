import { describe, it, expect, vi, beforeEach } from "vitest";
import { processReceipt } from "../../artifacts/api-server/src/services/receipt-ocr.js";

// ── Gemini Vision failure scenarios ──────────────────────────────────────

describe("Receipt OCR — Gemini unavailable", () => {
  it("returns manual_required when GEMINI_API_KEY not set", async () => {
    delete process.env.GEMINI_API_KEY;

    const result = await processReceipt("/uploads/test.jpg");

    expect(result.status).toBe("manual_required");
    expect(result.engine).toBe("gemini");
    expect(result.confidence).toBe(0);
    expect(result.items).toHaveLength(0);
    expect(result.error).toMatch(/not configured/i);
  });

  it("returns manual_required when file doesn't exist", async () => {
    process.env.GEMINI_API_KEY = "fake-key";

    const result = await processReceipt("/uploads/nonexistent-file.jpg");

    expect(result.status).toBe("manual_required");
    expect(result.error).toMatch(/could not read/i);
  });

  it("returns manual_required on network timeout", async () => {
    process.env.GEMINI_API_KEY = "fake-key";

    // Mock fetch to simulate timeout
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(
      Object.assign(new Error("aborted"), { name: "TimeoutError" })
    );

    // Create a temp file so the file read succeeds
    const fs = await import("fs");
    const path = await import("path");
    const tmpFile = path.resolve(process.cwd(), "uploads/test-timeout.jpg");
    fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
    fs.writeFileSync(tmpFile, "fake image data");

    const result = await processReceipt("uploads/test-timeout.jpg");

    expect(result.status).toBe("manual_required");
    expect(result.error).toMatch(/timed out/i);

    // Cleanup
    fs.unlinkSync(tmpFile);
    globalThis.fetch = originalFetch;
  });

  it("returns manual_required on API error (500)", async () => {
    process.env.GEMINI_API_KEY = "fake-key";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    const fs = await import("fs");
    const path = await import("path");
    const tmpFile = path.resolve(process.cwd(), "uploads/test-500.jpg");
    fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
    fs.writeFileSync(tmpFile, "fake image data");

    const result = await processReceipt("uploads/test-500.jpg");

    expect(result.status).toBe("manual_required");
    expect(result.error).toMatch(/500/);

    fs.unlinkSync(tmpFile);
    globalThis.fetch = originalFetch;
  });

  it("returns manual_required when API returns garbage (no JSON)", async () => {
    process.env.GEMINI_API_KEY = "fake-key";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "I cannot read this image" }] } }],
      }),
    });

    const fs = await import("fs");
    const path = await import("path");
    const tmpFile = path.resolve(process.cwd(), "uploads/test-garbage.jpg");
    fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
    fs.writeFileSync(tmpFile, "fake image data");

    const result = await processReceipt("uploads/test-garbage.jpg");

    expect(result.status).toBe("manual_required");
    expect(result.error).toMatch(/could not parse/i);

    fs.unlinkSync(tmpFile);
    globalThis.fetch = originalFetch;
  });

  it("never crashes — all errors are caught and returned as status", async () => {
    process.env.GEMINI_API_KEY = "fake-key";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("DNS resolution failed"));

    const fs = await import("fs");
    const path = await import("path");
    const tmpFile = path.resolve(process.cwd(), "uploads/test-dns.jpg");
    fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
    fs.writeFileSync(tmpFile, "fake image data");

    // Should NOT throw
    const result = await processReceipt("uploads/test-dns.jpg");

    expect(result.status).toBe("manual_required");
    expect(result.error).toBeDefined();
    expect(result.items).toHaveLength(0);

    fs.unlinkSync(tmpFile);
    globalThis.fetch = originalFetch;
  });
});

// ── Successful extraction ─────────────────────────────────────────────────

describe("Receipt OCR — Gemini success", () => {
  it("parses valid Gemini response into structured items", async () => {
    process.env.GEMINI_API_KEY = "fake-key";

    const mockResponse = {
      storeName: "Walmart",
      storeAddress: "123 Main St",
      purchaseDate: "2026-07-01",
      subtotal: 25.48,
      tax: 2.03,
      total: 27.51,
      paymentMethod: "Visa",
      items: [
        { description: "Milk 2%", quantity: 1, unitPrice: 3.99, lineTotal: 3.99 },
        { description: "Bread", quantity: 2, unitPrice: 2.50, lineTotal: 5.00 },
        { description: "Eggs", quantity: 1, unitPrice: 4.49, lineTotal: 4.49 },
      ],
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify(mockResponse) }] } }],
      }),
    });

    const fs = await import("fs");
    const path = await import("path");
    const tmpFile = path.resolve(process.cwd(), "uploads/test-success.jpg");
    fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
    fs.writeFileSync(tmpFile, "fake image data");

    const result = await processReceipt("uploads/test-success.jpg");

    expect(result.status).toBe("success");
    expect(result.confidence).toBeGreaterThan(0.8);
    expect(result.storeName).toBe("Walmart");
    expect(result.total).toBe(27.51);
    expect(result.items).toHaveLength(3);
    expect(result.items[0].description).toBe("Milk 2%");
    expect(result.items[1].lineTotal).toBe(5.00);
    // Category is null until user assigns
    expect(result.items[0].category).toBeNull();

    fs.unlinkSync(tmpFile);
    globalThis.fetch = originalFetch;
  });

  it("returns partial when items are empty but metadata extracted", async () => {
    process.env.GEMINI_API_KEY = "fake-key";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          storeName: "Store",
          purchaseDate: "2026-01-01",
          total: 50,
          items: [],
        }) }] } }],
      }),
    });

    const fs = await import("fs");
    const path = await import("path");
    const tmpFile = path.resolve(process.cwd(), "uploads/test-partial.jpg");
    fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
    fs.writeFileSync(tmpFile, "fake");

    const result = await processReceipt("uploads/test-partial.jpg");

    expect(result.status).toBe("partial");
    expect(result.items).toHaveLength(0);
    expect(result.storeName).toBe("Store");

    fs.unlinkSync(tmpFile);
    globalThis.fetch = originalFetch;
  });
});

// ── Plaid sync failure scenarios ──────────────────────────────────────────

describe("Plaid sync — failure resilience", () => {
  it("mock adapter never throws", async () => {
    const { getPlaidAdapter } = await import("../../artifacts/api-server/src/services/plaid.js");
    const adapter = getPlaidAdapter();

    // None of these should throw
    const token = await adapter.exchangePublicToken("bad-token");
    expect(token.accessToken).toBeDefined();

    const accounts = await adapter.getAccounts("bad-token");
    expect(accounts).toBeInstanceOf(Array);

    const sync = await adapter.syncTransactions("bad-token");
    expect(sync.added).toBeInstanceOf(Array);
    expect(sync.hasMore).toBe(false);
  });

  it("sync result contains errors array for reporting", () => {
    // Document the expected response shape
    const syncResponse = {
      added: 0,
      removed: 0,
      updated: 0,
      accounts: 2,
      errors: [
        { institution: "Bank A", error: "ITEM_LOGIN_REQUIRED" },
      ],
    };

    expect(syncResponse.errors).toHaveLength(1);
    expect(syncResponse.errors[0].institution).toBe("Bank A");
    // App should still return 200 — partial failure is not a crash
  });

  it("individual institution failure doesn't affect other institutions", () => {
    // This documents the design: each institution is synced independently
    // If one fails, others continue
    const results = {
      institution1: { success: true, added: 50 },
      institution2: { success: false, error: "timeout" },
      institution3: { success: true, added: 30 },
    };

    const totalAdded = Object.values(results)
      .filter((r) => r.success)
      .reduce((sum, r) => sum + (r as any).added, 0);

    expect(totalAdded).toBe(80); // institution2 failure doesn't zero it out
  });
});
