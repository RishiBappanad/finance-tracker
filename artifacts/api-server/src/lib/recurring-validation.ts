/**
 * Request-body validation for /recurring-items -- returns a parsed value or an
 * error string, never throws, matching the project's other validators
 * (calendarValidation.ts, goals.ts). Field names are snake_case on the wire.
 */
import {
  CADENCES,
  TODO_DUE_CHOICES,
  defaultTodoConfig,
  isDateString,
  isValidCadence,
  validateTemplate,
  type Cadence,
  type TodoConfig,
} from "./recurrence.js";

export const MAX_WINDOW_BEFORE_DAYS = 31;
export const MAX_WINDOW_AFTER_DAYS = 60;

const TODO_CONFIG_KEYS = ["enabled", "lead_days", "due", "title_template", "notes_template", "category", "priority"];

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Validates a todo_config from a request and fills the gaps from the defaults, so a
 * client can send just `{ "enabled": true }` (or `{}`) and get a working config.
 * `null` means "no to-do sync".
 */
export function parseTodoConfig(input: unknown, expectedAmount: number | null): TodoConfig | null | string {
  if (input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) return "todo_config must be an object or null";
  const raw = input as Record<string, unknown>;
  const unknownKey = Object.keys(raw).find((k) => !TODO_CONFIG_KEYS.includes(k));
  if (unknownKey) return `todo_config.${unknownKey} is not a known field (allowed: ${TODO_CONFIG_KEYS.join(", ")})`;

  const config = { ...defaultTodoConfig(expectedAmount), ...raw } as TodoConfig;
  if (typeof config.enabled !== "boolean") return "todo_config.enabled must be a boolean";
  if (!isInt(config.lead_days, 0, 60)) return "todo_config.lead_days must be an integer from 0 to 60";
  if (!(TODO_DUE_CHOICES as readonly string[]).includes(config.due)) return `todo_config.due must be one of: ${TODO_DUE_CHOICES.join(", ")}`;
  if (typeof config.title_template !== "string" || !config.title_template.trim()) return "todo_config.title_template is required";
  if (typeof config.notes_template !== "string") return "todo_config.notes_template must be a string";
  if (typeof config.category !== "string" || !config.category.trim() || config.category.length > 60) return "todo_config.category must be 1-60 characters";
  if (!isInt(config.priority, 1, 9)) return "todo_config.priority must be an integer from 1 to 9";
  return validateTemplate(config.title_template, "todo_config.title_template", 200) ?? validateTemplate(config.notes_template, "todo_config.notes_template", 1000) ?? config;
}

export interface ItemFields {
  label: string;
  category: string | null;
  expectedAmount: number | null;
  cadence: Cadence;
  intervalDays: number | null;
  anchorDate: string;
  windowBeforeDays: number;
  windowAfterDays: number;
  merchantHint: string | null;
  isActive: boolean;
  confirmed: boolean;
  todoConfig: TodoConfig | null;
}

/**
 * Parses only the fields present in `body`, so it serves both POST (caller then
 * requires the mandatory ones) and PATCH. Returns the parsed subset, or an error.
 */
export function parseItemFields(body: Record<string, unknown>, expectedAmountForTodoDefaults: number | null): Partial<ItemFields> | string {
  const out: Partial<ItemFields> = {};

  if (body.label !== undefined) {
    if (typeof body.label !== "string" || !body.label.trim() || body.label.length > 120) return "label must be 1-120 characters";
    out.label = body.label.trim();
  }
  if (body.category !== undefined) {
    if (body.category !== null && (typeof body.category !== "string" || body.category.length > 60)) return "category must be a string or null";
    out.category = body.category as string | null;
  }
  if (body.expected_amount !== undefined) {
    if (body.expected_amount !== null && (typeof body.expected_amount !== "number" || !Number.isFinite(body.expected_amount))) return "expected_amount must be a number or null";
    out.expectedAmount = body.expected_amount as number | null;
  }
  if (body.cadence !== undefined) {
    if (!isValidCadence(body.cadence)) return `cadence must be one of: ${CADENCES.join(", ")}`;
    out.cadence = body.cadence;
  }
  if (body.interval_days !== undefined) {
    if (body.interval_days !== null && !isInt(body.interval_days, 1, 366)) return "interval_days must be an integer from 1 to 366 (or null)";
    out.intervalDays = body.interval_days as number | null;
  }
  if (body.anchor_date !== undefined) {
    if (!isDateString(body.anchor_date)) return "anchor_date must be a real YYYY-MM-DD date";
    out.anchorDate = body.anchor_date;
  }
  if (body.window_before_days !== undefined) {
    if (!isInt(body.window_before_days, 0, MAX_WINDOW_BEFORE_DAYS)) return `window_before_days must be an integer from 0 to ${MAX_WINDOW_BEFORE_DAYS}`;
    out.windowBeforeDays = body.window_before_days;
  }
  if (body.window_after_days !== undefined) {
    if (!isInt(body.window_after_days, 0, MAX_WINDOW_AFTER_DAYS)) return `window_after_days must be an integer from 0 to ${MAX_WINDOW_AFTER_DAYS}`;
    out.windowAfterDays = body.window_after_days;
  }
  if (body.merchant_hint !== undefined) {
    if (body.merchant_hint !== null && (typeof body.merchant_hint !== "string" || body.merchant_hint.length > 120)) return "merchant_hint must be a string of at most 120 characters, or null";
    out.merchantHint = typeof body.merchant_hint === "string" && body.merchant_hint.trim() ? body.merchant_hint.trim() : null;
  }
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== "boolean") return "is_active must be a boolean";
    out.isActive = body.is_active;
  }
  if (body.confirmed !== undefined) {
    if (typeof body.confirmed !== "boolean") return "confirmed must be a boolean";
    out.confirmed = body.confirmed;
  }
  if (body.todo_config !== undefined) {
    const parsed = parseTodoConfig(body.todo_config, out.expectedAmount ?? expectedAmountForTodoDefaults);
    if (typeof parsed === "string") return parsed;
    out.todoConfig = parsed;
  }
  return out;
}

/** Cross-field rules that need the merged (existing + changed) item. */
export function checkItemConsistency(item: Pick<ItemFields, "cadence" | "intervalDays">): string | null {
  if (item.cadence === "custom" && (item.intervalDays === null || item.intervalDays === undefined)) return "interval_days is required when cadence is custom";
  return null;
}
