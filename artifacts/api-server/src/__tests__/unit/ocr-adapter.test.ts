import { describe, it, expect } from "vitest";
import { getOcrAdapter, type OcrAdapter } from "../../services/ocr.js";

describe("getOcrAdapter — adapter selection", () => {
  it("returns tesseract adapter by default for unknown engine", () => {
    const adapter = getOcrAdapter("not-a-real-engine");
    expect(adapter.name).toBe("tesseract");
  });

  it("returns tesseract adapter when explicitly requested", () => {
    const adapter = getOcrAdapter("tesseract");
    expect(adapter.name).toBe("tesseract");
  });

  it("returns ollama adapter when requested", () => {
    const adapter = getOcrAdapter("ollama");
    expect(adapter.name).toBe("ollama");
  });

  it("returns the same object shape for all adapters (OcrAdapter contract)", () => {
    for (const engine of ["tesseract", "ollama"]) {
      const adapter = getOcrAdapter(engine);
      expect(adapter).toHaveProperty("name");
      expect(adapter).toHaveProperty("process");
      expect(typeof adapter.process).toBe("function");
    }
  });
});

describe("tesseract adapter — process()", () => {
  it("resolves with the full OcrResult shape", async () => {
    const adapter = getOcrAdapter("tesseract");
    const result = await adapter.process("/tmp/receipt.png");
    expect(result).toMatchObject({
      storeName: null,
      storeAddress: null,
      purchaseDate: null,
      subtotal: null,
      tax: null,
      total: null,
      paymentMethod: null,
      returnWindowDays: null,
      rawText: expect.any(String),
      confidence: expect.any(Number),
    });
  });

  it("stub confidence is 0 (not yet wired)", async () => {
    const adapter = getOcrAdapter("tesseract");
    const result = await adapter.process("/any/path.png");
    expect(result.confidence).toBe(0);
  });

  it("rawText contains the file path as reference", async () => {
    const adapter = getOcrAdapter("tesseract");
    const result = await adapter.process("/tmp/my-receipt.jpg");
    expect(result.rawText).toContain("/tmp/my-receipt.jpg");
  });

  it("confidence is in valid range [0, 1]", async () => {
    const adapter = getOcrAdapter("tesseract");
    const result = await adapter.process("any");
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});

describe("ollama adapter — process()", () => {
  it("resolves with the full OcrResult shape", async () => {
    const adapter = getOcrAdapter("ollama");
    const result = await adapter.process("/tmp/receipt.png");
    expect(result).toMatchObject({
      storeName: null,
      storeAddress: null,
      purchaseDate: null,
      subtotal: null,
      tax: null,
      total: null,
      paymentMethod: null,
      returnWindowDays: null,
      rawText: expect.any(String),
      confidence: expect.any(Number),
    });
  });

  it("stub confidence is 0", async () => {
    const adapter = getOcrAdapter("ollama");
    const result = await adapter.process("x");
    expect(result.confidence).toBe(0);
  });

  it("rawText contains the file path", async () => {
    const adapter = getOcrAdapter("ollama");
    const result = await adapter.process("/images/scan.png");
    expect(result.rawText).toContain("/images/scan.png");
  });
});

describe("OcrAdapter interface contract", () => {
  it("adapters are swappable — process() always returns a Promise", async () => {
    const adapters: OcrAdapter[] = [getOcrAdapter("tesseract"), getOcrAdapter("ollama")];
    for (const adapter of adapters) {
      const result = adapter.process("test.png");
      expect(result).toBeInstanceOf(Promise);
      await result; // must not throw
    }
  });

  it("adapters have distinct names", () => {
    const tesseract = getOcrAdapter("tesseract");
    const ollama = getOcrAdapter("ollama");
    expect(tesseract.name).not.toBe(ollama.name);
  });
});
