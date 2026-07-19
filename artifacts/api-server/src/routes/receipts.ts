import { Router } from "express";
import multer from "multer";
import path from "path";
import { mkdirSync } from "fs";
import { db } from "@workspace/db";
import { scannedReceipts, receiptItems, receiptTransactionMatches } from "@workspace/db";
import { eq, and, gte, lte, like, sql } from "drizzle-orm";
import {
  CreateReceiptBody,
  UpdateReceiptBody,
  CreateReceiptItemBody,
  ListReceiptsQueryParams,
  ListExpiringReceiptsQueryParams,
} from "@workspace/api-zod";
import { processReceipt } from "../services/receipt-ocr.js";

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

// POST /receipts/confirm — user confirms extracted data, saves receipt + items
router.post("/confirm", async (req, res) => {
  const { filePath, storeName, storeAddress, purchaseDate, subtotal, tax, total, paymentMethod, returnWindowDays, notes, items } = req.body;

  if (!filePath) {
    return void res.status(400).json({ error: "filePath is required" });
  }

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
      await db.insert(receiptItems).values({
        receiptId: receipt.id,
        description: item.description || "Unknown item",
        quantity: Number(item.quantity) || 1,
        unitPrice: Number(item.unitPrice) || 0,
        lineTotal: Number(item.lineTotal) || 0,
        category: item.category || null,
        sortOrder: i,
      });
    }
  }

  res.status(201).json(serializeReceipt(receipt));
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
  const match = await db
    .select({ id: receiptTransactionMatches.id })
    .from(receiptTransactionMatches)
    .where(eq(receiptTransactionMatches.receiptId, id))
    .limit(1);

  res.json({ ...serializeReceipt(row, match[0]?.id ?? null), items });
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

  const [item] = await db
    .insert(receiptItems)
    .values({ receiptId: Number(req.params.receiptId), ...parsed.data })
    .returning();

  res.status(201).json(item);
});

export default router;
