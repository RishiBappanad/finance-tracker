import { Router } from "express";
import multer from "multer";
import path from "path";
import { mkdirSync } from "fs";
import { db } from "@workspace/db";
import { scannedReceipts, receiptItems, receiptTransactionMatches, bankTransactions } from "@workspace/db";
import { eq, and, gte, lte, like, sql } from "drizzle-orm";
import {
  CreateReceiptBody,
  UpdateReceiptBody,
  CreateReceiptItemBody,
  UpdateReceiptItemBody,
  ListReceiptsQueryParams,
  ListExpiringReceiptsQueryParams,
} from "@workspace/api-zod";
import { processReceipt } from "../services/receipt-ocr.js";
import { getAllCategoryNames } from "../lib/categories.js";
import { reconcileOneReceipt, computeReceiptMatch } from "../services/receipt-matcher.js";

// Ensure uploads directory exists
const uploadsDir = path.resolve(process.cwd(), "uploads");
mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${uniqueSuffix}-${file.originalname}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB max

const router = Router();

function serializeReceipt(r: any, matchId?: number | null) {
  return {
    id: r.id,
    sourceFilePath: r.sourceFilePath,
    ocrEngine: r.ocrEngine,
    storeName: r.storeName ?? null,
    storeAddress: r.storeAddress ?? null,
    purchaseDate: r.purchaseDate ?? null,
    subtotal: r.subtotal ?? null,
    tax: r.tax ?? null,
    total: r.total ?? null,
    paymentMethod: r.paymentMethod ?? null,
    returnWindowDays: r.returnWindowDays ?? null,
    returnDeadline: r.returnDeadline ?? null,
    processingStatus: r.processingStatus,
    ocrConfidence: r.ocrConfidence ?? null,
    notes: r.notes ?? null,
    matchId: matchId ?? null,
    createdAt: r.createdAt?.toISOString?.() ?? r.createdAt ?? "",
    updatedAt: r.updatedAt?.toISOString?.() ?? r.updatedAt ?? "",
  };
}

async function getMatchMap(receiptIds: number[]) {
  if (!receiptIds.length) return new Map<number, number>();
  const matchRows = await db
    .select({ receiptId: receiptTransactionMatches.receiptId, id: receiptTransactionMatches.id })
    .from(receiptTransactionMatches)
    .where(sql`${receiptTransactionMatches.receiptId} = ANY(${sql.raw(`ARRAY[${receiptIds.join(",")}]::int[]`)})`)
  return new Map(matchRows.map((m) => [m.receiptId, m.id]));
}

router.get("/expiring", async (req, res) => {
  const parsed = ListExpiringReceiptsQueryParams.safeParse(req.query);
  const days = parsed.success && parsed.data.days != null ? parsed.data.days : 14;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const todayStr = new Date().toISOString().slice(0, 10);

  const rows = await db
    .select()
    .from(scannedReceipts)
    .where(
      and(
        sql`${scannedReceipts.returnDeadline} IS NOT NULL`,
        gte(scannedReceipts.returnDeadline, todayStr),
        lte(scannedReceipts.returnDeadline, cutoffStr)
      )
    )
    .orderBy(scannedReceipts.returnDeadline);

  const mm = await getMatchMap(rows.map((r) => r.id));
  res.json(rows.map((r) => serializeReceipt(r, mm.get(r.id))));
});

router.get("/unmatched", async (_req, res) => {
  const matched = db
    .select({ id: receiptTransactionMatches.receiptId })
    .from(receiptTransactionMatches);

  const rows = await db
    .select()
    .from(scannedReceipts)
    .where(sql`${scannedReceipts.id} NOT IN (${matched})`)
    .orderBy(scannedReceipts.createdAt);

  res.json(rows.map((r) => serializeReceipt(r)));
});

router.get("/", async (req, res) => {
  const parsed = ListReceiptsQueryParams.safeParse(req.query);
  const params = parsed.success ? parsed.data : {};

  const conditions = [];
  if (params.status) conditions.push(eq(scannedReceipts.processingStatus, params.status));
  if (params.search) conditions.push(like(scannedReceipts.storeName, `%${params.search}%`));
  if (params.from) conditions.push(gte(scannedReceipts.purchaseDate, params.from));
  if (params.to) conditions.push(lte(scannedReceipts.purchaseDate, params.to));

  const rows = await db
    .select()
    .from(scannedReceipts)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(scannedReceipts.createdAt);

  const mm = await getMatchMap(rows.map((r) => r.id));
  res.json(rows.map((r) => serializeReceipt(r, mm.get(r.id))));
});

router.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return void res.status(400).json({ error: "No file provided" });
  }

  const filePath = `/uploads/${req.file.filename}`;
  const { storeName, purchaseDate, total, notes } = req.body;

  const [row] = await db
    .insert(scannedReceipts)
    .values({
      userId: req.user!.userId,
      sourceFilePath: filePath,
      ocrEngine: "manual",
      storeName: storeName || null,
      purchaseDate: purchaseDate || null,
      total: total ? parseFloat(total) : null,
      notes: notes || null,
      processingStatus: "completed",
    })
    .returning();

  res.status(201).json(serializeReceipt(row));
});

// POST /receipts/scan — upload + OCR extract, returns data for user verification (does NOT save)
router.post("/scan", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return void res.status(400).json({ error: "No file provided" });
  }

  const filePath = `uploads/${req.file.filename}`;

  try {
    const extraction = await processReceipt(filePath);
    res.json({
      filePath: `/uploads/${req.file.filename}`,
      extraction,
    });
  } catch (e: any) {
    // Even if OCR completely explodes, return a graceful response
    res.json({
      filePath: `/uploads/${req.file.filename}`,
      extraction: {
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
        error: `Processing failed: ${e.message}`,
      },
    });
  }
});

// GET /receipts/categories — same category list transactions use (defaults +
// user-created). Receipt items used to have their own separate, differently
// named list (e.g. "Gas" vs transactions' "Gas & Fuel") that never matched
// anything cash-flow reporting understood — this is the single shared list.
router.get("/categories", async (_req, res) => {
  res.json(await getAllCategoryNames());
});

// POST /receipts/confirm — user confirms extracted data, saves receipt + items
router.post("/confirm", async (req, res) => {
  const { filePath, storeName, storeAddress, purchaseDate, subtotal, tax, total, paymentMethod, returnWindowDays, notes, items } = req.body;

  if (!filePath) {
    return void res.status(400).json({ error: "filePath is required" });
  }

  const validCategories = await getAllCategoryNames();

  let returnDeadline: string | null = null;
  if (purchaseDate && returnWindowDays) {
    const d = new Date(purchaseDate);
    d.setDate(d.getDate() + returnWindowDays);
    returnDeadline = d.toISOString().slice(0, 10);
  }

  const [receipt] = await db
    .insert(scannedReceipts)
    .values({
      userId: req.user!.userId,
      sourceFilePath: filePath,
      ocrEngine: "gemini",
      storeName: storeName || null,
      storeAddress: storeAddress || null,
      purchaseDate: purchaseDate || null,
      subtotal: subtotal != null ? Number(subtotal) : null,
      tax: tax != null ? Number(tax) : null,
      total: total != null ? Number(total) : null,
      paymentMethod: paymentMethod || null,
      returnWindowDays: returnWindowDays || null,
      returnDeadline,
      notes: notes || null,
      processingStatus: "completed",
      ocrConfidence: 1.0, // User verified
    })
    .returning();

  // Save items if provided
  if (items && Array.isArray(items) && items.length > 0) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      // Silently drop an invalid/stale category rather than reject the whole
      // receipt over one bad item field — matches how the rest of this route
      // treats malformed optional fields (coerced to null, not a 400).
      const category = item.category && validCategories.includes(item.category) ? item.category : null;
      await db.insert(receiptItems).values({
        receiptId: receipt.id,
        description: item.description || "Unknown item",
        quantity: Number(item.quantity) || 1,
        unitPrice: Number(item.unitPrice) || 0,
        lineTotal: Number(item.lineTotal) || 0,
        category,
        sortOrder: i,
      });
    }
  }

  // Immediately try to match this receipt against the user's own unmatched
  // bank transactions — previously the only way a receipt got matched was a
  // separate manual trip to the Reconcile page (or its bulk "run" button),
  // so a receipt Gemini just parsed sat unmatched until the user remembered
  // to go do that. auto_matched creates a real match row; needs_review
  // candidates are returned as suggestions for the frontend to show without
  // committing to anything the user hasn't confirmed.
  const { outcome, createdMatch } = await reconcileOneReceipt(
    { id: receipt.id, total: receipt.total, purchaseDate: receipt.purchaseDate, storeName: receipt.storeName },
    req.user!.userId
  );

  res.status(201).json({
    ...serializeReceipt(receipt, createdMatch?.id ?? null),
    match: {
      status: outcome.status,
      suggestions: outcome.candidates.map((c) => ({
        bankTransactionId: c.transaction.id,
        merchantName: c.transaction.merchantName,
        amount: c.transaction.amount,
        date: c.transaction.date,
        confidenceScore: c.composite,
      })),
    },
  });
});

router.post("/", async (req, res) => {
  const parsed = CreateReceiptBody.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid input" });

  const { sourceFilePath, ocrEngine, sourceFileHash, storeName, purchaseDate, total, returnWindowDays, notes } = parsed.data;

  let returnDeadline: string | null = null;
  if (purchaseDate && returnWindowDays) {
    const d = new Date(purchaseDate);
    d.setDate(d.getDate() + returnWindowDays);
    returnDeadline = d.toISOString().slice(0, 10);
  }

  const [row] = await db
    .insert(scannedReceipts)
    .values({
      userId: req.user!.userId,
      sourceFilePath,
      sourceFileHash: sourceFileHash ?? null,
      ocrEngine,
      storeName: storeName ?? null,
      purchaseDate: purchaseDate ?? null,
      total: total ?? null,
      returnWindowDays: returnWindowDays ?? null,
      returnDeadline,
      notes: notes ?? null,
      processingStatus: "pending",
    })
    .returning();

  res.status(201).json(serializeReceipt(row));
});

router.get("/:receiptId", async (req, res) => {
  const id = Number(req.params.receiptId);
  const [row] = await db.select().from(scannedReceipts).where(eq(scannedReceipts.id, id)).limit(1);
  if (!row) return void res.status(404).json({ error: "Receipt not found" });

  const items = await db.select().from(receiptItems).where(eq(receiptItems.receiptId, id)).orderBy(receiptItems.sortOrder);

  // Embed the matched transaction (if any) directly, rather than just a
  // matchId — the receipt detail page needs to show what a receipt is
  // reconciled against, not just whether it is.
  const matchRows = await db
    .select({
      matchId: receiptTransactionMatches.id,
      matchMethod: receiptTransactionMatches.matchMethod,
      confirmed: receiptTransactionMatches.confirmed,
      transaction: bankTransactions,
    })
    .from(receiptTransactionMatches)
    .innerJoin(bankTransactions, eq(receiptTransactionMatches.bankTransactionId, bankTransactions.id))
    .where(eq(receiptTransactionMatches.receiptId, id))
    .limit(1);

  const match = matchRows[0]
    ? {
        matchId: matchRows[0].matchId,
        matchMethod: matchRows[0].matchMethod,
        confirmed: matchRows[0].confirmed,
        transaction: {
          id: matchRows[0].transaction.id,
          merchantName: matchRows[0].transaction.merchantName ?? matchRows[0].transaction.merchantNameRaw,
          amount: matchRows[0].transaction.amount,
          date: matchRows[0].transaction.date,
        },
      }
    : null;

  res.json({ ...serializeReceipt(row, match?.matchId ?? null), items, match });
});

// GET /receipts/:receiptId/suggestions — re-run the matcher for an already-
// saved, still-unmatched receipt (read-only, creates no match). Lets the
// receipt detail page show candidate transactions for the user to pick from
// when the automatic match at confirm-time didn't reach auto_matched
// confidence.
router.get("/:receiptId/suggestions", async (req, res) => {
  const id = Number(req.params.receiptId);
  const [row] = await db.select().from(scannedReceipts).where(eq(scannedReceipts.id, id)).limit(1);
  if (!row) return void res.status(404).json({ error: "Receipt not found" });

  const existingMatch = await db
    .select({ id: receiptTransactionMatches.id })
    .from(receiptTransactionMatches)
    .where(eq(receiptTransactionMatches.receiptId, id))
    .limit(1);
  if (existingMatch.length > 0) {
    return void res.json({ status: "auto_matched", suggestions: [] });
  }

  const outcome = await computeReceiptMatch(
    { id: row.id, total: row.total, purchaseDate: row.purchaseDate, storeName: row.storeName },
    req.user!.userId
  );

  res.json({
    status: outcome.status,
    suggestions: outcome.candidates.map((c) => ({
      bankTransactionId: c.transaction.id,
      merchantName: c.transaction.merchantName,
      amount: c.transaction.amount,
      date: c.transaction.date,
      confidenceScore: c.composite,
    })),
  });
});

router.patch("/:receiptId", async (req, res) => {
  const id = Number(req.params.receiptId);
  const parsed = UpdateReceiptBody.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid input" });

  const updates: Record<string, any> = { updatedAt: new Date() };
  const d = parsed.data;
  if (d.storeName !== undefined) updates.storeName = d.storeName;
  if (d.storeAddress !== undefined) updates.storeAddress = d.storeAddress;
  if (d.purchaseDate !== undefined) updates.purchaseDate = d.purchaseDate;
  if (d.subtotal !== undefined) updates.subtotal = d.subtotal;
  if (d.tax !== undefined) updates.tax = d.tax;
  if (d.total !== undefined) updates.total = d.total;
  if (d.paymentMethod !== undefined) updates.paymentMethod = d.paymentMethod;
  if (d.returnWindowDays !== undefined) {
    updates.returnWindowDays = d.returnWindowDays;
    if (d.returnWindowDays && updates.purchaseDate) {
      const dt = new Date(updates.purchaseDate);
      dt.setDate(dt.getDate() + d.returnWindowDays);
      updates.returnDeadline = dt.toISOString().slice(0, 10);
    }
  }
  if (d.notes !== undefined) updates.notes = d.notes;

  const [row] = await db.update(scannedReceipts).set(updates).where(eq(scannedReceipts.id, id)).returning();
  if (!row) return void res.status(404).json({ error: "Receipt not found" });

  const match = await db
    .select({ id: receiptTransactionMatches.id })
    .from(receiptTransactionMatches)
    .where(eq(receiptTransactionMatches.receiptId, id))
    .limit(1);

  res.json(serializeReceipt(row, match[0]?.id ?? null));
});

router.delete("/:receiptId", async (req, res) => {
  await db.delete(scannedReceipts).where(eq(scannedReceipts.id, Number(req.params.receiptId)));
  res.status(204).send();
});

router.get("/:receiptId/items", async (req, res) => {
  const items = await db
    .select()
    .from(receiptItems)
    .where(eq(receiptItems.receiptId, Number(req.params.receiptId)))
    .orderBy(receiptItems.sortOrder);
  res.json(items);
});

router.post("/:receiptId/items", async (req, res) => {
  const parsed = CreateReceiptItemBody.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid input" });

  if (parsed.data.category) {
    const validCategories = await getAllCategoryNames();
    if (!validCategories.includes(parsed.data.category)) {
      return void res.status(400).json({ error: "Invalid category", validCategories });
    }
  }

  const [item] = await db
    .insert(receiptItems)
    .values({ receiptId: Number(req.params.receiptId), ...parsed.data })
    .returning();

  res.status(201).json(item);
});

// PATCH /receipts/:receiptId/items/:itemId — edit a line item after the
// receipt has been saved (most commonly: re-assign its category). The
// confirm-time flow was the only way to set an item's category before this;
// there was no way to fix a miscategorized item afterward.
router.patch("/:receiptId/items/:itemId", async (req, res) => {
  const parsed = UpdateReceiptItemBody.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid input" });

  if (parsed.data.category) {
    const validCategories = await getAllCategoryNames();
    if (!validCategories.includes(parsed.data.category)) {
      return void res.status(400).json({ error: "Invalid category", validCategories });
    }
  }

  const [item] = await db
    .update(receiptItems)
    .set(parsed.data)
    .where(
      and(
        eq(receiptItems.id, Number(req.params.itemId)),
        eq(receiptItems.receiptId, Number(req.params.receiptId))
      )
    )
    .returning();

  if (!item) return void res.status(404).json({ error: "Item not found" });
  res.json(item);
});

export default router;
