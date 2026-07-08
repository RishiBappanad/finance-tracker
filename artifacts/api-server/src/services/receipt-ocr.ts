/**
 * Receipt OCR Service — Gemini Vision primary, manual entry fallback.
 *
 * Priority:
 * 1. Gemini Vision (Google AI) — extracts store, date, items, total from image
 * 2. Manual entry — user enters items themselves
 *
 * Set GEMINI_API_KEY in env to enable Gemini Vision.
 * Without it, receipts are created with status "pending_manual" for user input.
 *
 * IMPORTANT: Results are NEVER auto-saved. They're returned as "pending_verification"
 * for the user to confirm/edit before committing to the database.
 */

import fs from "fs";
import path from "path";

export interface ExtractedItem {
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  category: string | null;
}

export interface ExtractionResult {
  status: "success" | "partial" | "failed" | "manual_required";
  engine: "gemini" | "manual";
  confidence: number; // 0-1
  storeName: string | null;
  storeAddress: string | null;
  purchaseDate: string | null; // YYYY-MM-DD
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  paymentMethod: string | null;
  items: ExtractedItem[];
  rawResponse: string | null;
  error: string | null;
}

// ── Gemini Vision adapter ─────────────────────────────────────────────────

async function extractWithGemini(filePath: string): Promise<ExtractionResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      status: "manual_required",
      engine: "gemini",
      confidence: 0,
      storeName: null,
      storeAddress: null,
      purchaseDate: null,
      subtotal: null,
      tax: null,
      total: null,
      paymentMethod: null,
      items: [],
      rawResponse: null,
      error: "GEMINI_API_KEY not configured",
    };
  }

  // Read image and convert to base64
  const absolutePath = path.resolve(process.cwd(), filePath.replace(/^\//, ""));
  let imageData: string;
  let mimeType: string;

  try {
    const buffer = fs.readFileSync(absolutePath);
    imageData = buffer.toString("base64");
    const ext = path.extname(absolutePath).toLowerCase();
    mimeType = ext === ".png" ? "image/png" : ext === ".pdf" ? "application/pdf" : "image/jpeg";
  } catch (e: any) {
    return {
      status: "failed",
      engine: "gemini",
      confidence: 0,
      storeName: null, storeAddress: null, purchaseDate: null,
      subtotal: null, tax: null, total: null, paymentMethod: null,
      items: [],
      rawResponse: null,
      error: `Could not read file: ${e.message}`,
    };
  }

  const prompt = `Analyze this receipt image and extract structured data. Return ONLY valid JSON with this exact schema, no other text:

{
  "storeName": "string or null",
  "storeAddress": "string or null",
  "purchaseDate": "YYYY-MM-DD or null",
  "subtotal": number or null,
  "tax": number or null,
  "total": number or null,
  "paymentMethod": "string or null",
  "items": [
    {
      "description": "item name",
      "quantity": 1,
      "unitPrice": 0.00,
      "lineTotal": 0.00
    }
  ]
}

Rules:
- Extract every line item visible on the receipt
- If quantity isn't shown, assume 1
- lineTotal = quantity * unitPrice
- Dates should be YYYY-MM-DD format
- All prices should be numbers (no $ sign)
- If you can't read a field, use null
- Do NOT hallucinate items that aren't on the receipt`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inlineData: { mimeType, data: imageData } },
            ],
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 4096,
          },
        }),
        signal: AbortSignal.timeout(30000), // 30s timeout
      }
    );

    if (!response.ok) {
      const err = await response.text();
      return {
        status: "failed",
        engine: "gemini",
        confidence: 0,
        storeName: null, storeAddress: null, purchaseDate: null,
        subtotal: null, tax: null, total: null, paymentMethod: null,
        items: [],
        rawResponse: err,
        error: `Gemini API error: ${response.status}`,
      };
    }

    const data = await response.json() as any;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    // Extract JSON from response (might have markdown code fences)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        status: "failed",
        engine: "gemini",
        confidence: 0.1,
        storeName: null, storeAddress: null, purchaseDate: null,
        subtotal: null, tax: null, total: null, paymentMethod: null,
        items: [],
        rawResponse: text,
        error: "Could not parse JSON from Gemini response",
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate and normalize items
    const items: ExtractedItem[] = (parsed.items ?? []).map((item: any) => ({
      description: String(item.description || "Unknown item"),
      quantity: Number(item.quantity) || 1,
      unitPrice: Number(item.unitPrice) || 0,
      lineTotal: Number(item.lineTotal) || Number(item.unitPrice) || 0,
      category: null, // User assigns categories
    }));

    // Calculate confidence based on how much data was extracted
    let confidenceScore = 0;
    if (parsed.storeName) confidenceScore += 0.2;
    if (parsed.purchaseDate) confidenceScore += 0.2;
    if (parsed.total) confidenceScore += 0.2;
    if (items.length > 0) confidenceScore += 0.3;
    if (parsed.tax != null) confidenceScore += 0.1;

    return {
      status: items.length > 0 ? "success" : "partial",
      engine: "gemini",
      confidence: confidenceScore,
      storeName: parsed.storeName ?? null,
      storeAddress: parsed.storeAddress ?? null,
      purchaseDate: parsed.purchaseDate ?? null,
      subtotal: parsed.subtotal != null ? Number(parsed.subtotal) : null,
      tax: parsed.tax != null ? Number(parsed.tax) : null,
      total: parsed.total != null ? Number(parsed.total) : null,
      paymentMethod: parsed.paymentMethod ?? null,
      items,
      rawResponse: text,
      error: null,
    };
  } catch (e: any) {
    // Network failure, timeout, etc — graceful degradation
    return {
      status: "failed",
      engine: "gemini",
      confidence: 0,
      storeName: null, storeAddress: null, purchaseDate: null,
      subtotal: null, tax: null, total: null, paymentMethod: null,
      items: [],
      rawResponse: null,
      error: e.name === "TimeoutError"
        ? "Gemini request timed out (30s)"
        : `Gemini unavailable: ${e.message}`,
    };
  }
}

// ── Main export ───────────────────────────────────────────────────────────

/**
 * Process a receipt image. Returns extraction result for user verification.
 * NEVER saves directly — always returns data for user to confirm.
 */
export async function processReceipt(filePath: string): Promise<ExtractionResult> {
  // Try Gemini first
  const result = await extractWithGemini(filePath);

  // If Gemini failed entirely, return manual_required status
  if (result.status === "failed" || result.status === "manual_required") {
    return {
      ...result,
      status: "manual_required",
    };
  }

  // Return for user verification (never auto-save)
  return result;
}
