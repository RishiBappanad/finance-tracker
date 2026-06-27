/**
 * OCR Service Adapter — modular document processor.
 *
 * This module is the single swap point for OCR engines.
 * Change `activeAdapter` or add a new OcrAdapter implementation
 * without touching any route handler.
 *
 * Supported (stub) engines: tesseract | ollama
 * Production wiring: install node-tesseract-ocr or call Ollama's local HTTP API.
 */

export interface OcrResult {
  storeName: string | null;
  storeAddress: string | null;
  purchaseDate: string | null; // YYYY-MM-DD
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  paymentMethod: string | null;
  returnWindowDays: number | null;
  rawText: string;
  confidence: number; // 0–1
}

export interface OcrAdapter {
  readonly name: string;
  process(filePath: string): Promise<OcrResult>;
}

// ── Tesseract stub ────────────────────────────────────────────────────────────
// Wire up: `npm install node-tesseract-ocr` and replace this body.
const tesseractAdapter: OcrAdapter = {
  name: "tesseract",
  async process(filePath: string): Promise<OcrResult> {
    // TODO: const text = await tesseract.recognize(filePath, { lang: "eng" });
    return {
      storeName: null,
      storeAddress: null,
      purchaseDate: null,
      subtotal: null,
      tax: null,
      total: null,
      paymentMethod: null,
      returnWindowDays: null,
      rawText: `[tesseract stub] would process: ${filePath}`,
      confidence: 0,
    };
  },
};

// ── Ollama (local vision LLM) stub ───────────────────────────────────────────
// Wire up: point OLLAMA_BASE_URL at your local Ollama instance.
const ollamaAdapter: OcrAdapter = {
  name: "ollama",
  async process(filePath: string): Promise<OcrResult> {
    const base = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
    // TODO: call POST ${base}/api/generate with model "llava" and base64 image
    void base;
    void filePath;
    return {
      storeName: null,
      storeAddress: null,
      purchaseDate: null,
      subtotal: null,
      tax: null,
      total: null,
      paymentMethod: null,
      returnWindowDays: null,
      rawText: `[ollama stub] would process: ${filePath}`,
      confidence: 0,
    };
  },
};

const ADAPTERS: Record<string, OcrAdapter> = {
  tesseract: tesseractAdapter,
  ollama: ollamaAdapter,
};

export function getOcrAdapter(engine: string): OcrAdapter {
  return ADAPTERS[engine] ?? tesseractAdapter;
}
