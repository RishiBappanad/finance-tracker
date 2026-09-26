import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CategoryCombobox } from "@/components/category-combobox";
import { Repeat, Plus, Trash2, Pencil, Pause, Play, RefreshCw, Loader2, CheckCircle2, AlertTriangle, Clock, ListChecks, Sparkles, X } from "lucide-react";
import { API_BASE, authFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

// Recurring items: a forecast of what's expected to happen (a bill, a paycheck, a
// chore) with a RANGE of days to do it in, matched against real transactions, and
// optionally turned into a to-do for each occurrence. Design:
// workspace-notes/RECURRING_AND_GOALS_SPEC.md, "Recurring Items".

// ── Types (the API's snake_case shape) ───────────────────────────────────────

type Cadence = "weekly" | "biweekly" | "semi_monthly" | "monthly" | "annually" | "custom";
type TodoDue = "window_end" | "expected_date";

interface TodoConfig {
  enabled: boolean;
  lead_days: number;
  due: TodoDue;
  title_template: string;
  notes_template: string;
  category: string;
  priority: number;
}

interface Occurrence {
  id: number;
  expected_date: string;
  window_start: string;
  window_end: string;
  status: "pending" | "matched" | "missed" | "skipped";
  matched_transaction_id: string | null;
  todo_id: number | null;
  todo_error: string | null;
  todo_closed_at: string | null;
}

interface RecurringItem {
  id: number;
  label: string;
  category: string | null;
  expected_amount: number | null;
  cadence: Cadence;
  interval_days: number | null;
  anchor_date: string;
  next_expected_date: string;
  window_before_days: number;
  window_after_days: number;
  merchant_hint: string | null;
  source: string;
  confirmed: boolean;
  is_active: boolean;
  todo_config: TodoConfig | null;
  next_occurrence: Occurrence | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const CADENCE_LABELS: Record<Cadence, string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  semi_monthly: "Twice a month",
  monthly: "Monthly",
  annually: "Yearly",
  custom: "Every N days",
};

const PLACEHOLDERS = ["label", "amount", "category", "expected_date", "window_start", "window_end", "window"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

function formatRange(start: string, end: string): string {
  if (start === end) return shortDate(start);
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  return sameMonth ? `${shortDate(start)}–${Number(end.slice(8))}` : `${shortDate(start)} – ${shortDate(end)}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysUntil(iso: string): number {
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${todayIso()}T00:00:00Z`)) / 86_400_000);
}

function money(amount: number): string {
  const text = `$${Math.abs(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return amount < 0 ? `+${text}` : text;
}

function describeRange(item: RecurringItem): string {
  const b = item.window_before_days;
  const a = item.window_after_days;
  if (a === 0 && b === 0) return "on the day";
  if (b === 0) return `up to ${a} day${a === 1 ? "" : "s"} after`;
  if (a === 0) return `up to ${b} day${b === 1 ? "" : "s"} before`;
  return `${b} before to ${a} after`;
}

// ── Form ─────────────────────────────────────────────────────────────────────

interface ItemForm {
  label: string;
  category: string;
  direction: "out" | "in";
  amount: string;
  cadence: Cadence;
  intervalDays: string;
  anchorDate: string;
  before: string;
  after: string;
  merchantHint: string;
  todoEnabled: boolean;
  leadDays: string;
  due: TodoDue;
  titleTemplate: string;
  notesTemplate: string;
  todoCategory: string;
  priority: string;
}

function emptyForm(): ItemForm {
  return {
    label: "", category: "", direction: "out", amount: "", cadence: "monthly", intervalDays: "30", anchorDate: todayIso(), before: "0", after: "0",
    merchantHint: "", todoEnabled: false, leadDays: "0", due: "window_end", titleTemplate: "{label}", notesTemplate: "Anytime {window}", todoCategory: "finance", priority: "1",
  };
}

function formFromItem(item: RecurringItem): ItemForm {
  const todo = item.todo_config;
  return {
    label: item.label,
    category: item.category ?? "",
    direction: (item.expected_amount ?? 0) < 0 ? "in" : "out",
    amount: item.expected_amount === null ? "" : String(Math.abs(item.expected_amount)),
    cadence: item.cadence,
    intervalDays: String(item.interval_days ?? 30),
    anchorDate: item.anchor_date,
    before: String(item.window_before_days),
    after: String(item.window_after_days),
    merchantHint: item.merchant_hint ?? "",
    todoEnabled: !!todo?.enabled,
    leadDays: String(todo?.lead_days ?? 0),
    due: todo?.due ?? "window_end",
    titleTemplate: todo?.title_template ?? "{label}",
    notesTemplate: todo?.notes_template ?? (item.expected_amount === null ? "Anytime {window}" : "About {amount} · anytime {window}"),
    todoCategory: todo?.category ?? "finance",
    priority: String(todo?.priority ?? 1),
  };
}

function expectedAmountOf(form: ItemForm): number | null {
  if (form.amount.trim() === "") return null;
  const n = Number(form.amount);
  return Number.isFinite(n) ? (form.direction === "in" ? -Math.abs(n) : Math.abs(n)) : null;
}

function todoConfigOf(form: ItemForm): TodoConfig | null {
  if (!form.todoEnabled) return null;
  return {
    enabled: true,
    lead_days: Number(form.leadDays) || 0,
    due: form.due,
    title_template: form.titleTemplate,
    notes_template: form.notesTemplate,
    category: form.todoCategory,
    priority: Number(form.priority) || 1,
  };
}

function payloadOf(form: ItemForm) {
  return {
    label: form.label,
    category: form.category || null,
    expected_amount: expectedAmountOf(form),
    cadence: form.cadence,
    interval_days: form.cadence === "custom" ? Number(form.intervalDays) || null : null,
    anchor_date: form.anchorDate,
    window_before_days: Number(form.before) || 0,
    window_after_days: Number(form.after) || 0,
    merchant_hint: form.merchantHint || null,
    todo_config: todoConfigOf(form),
  };
}

interface ItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: RecurringItem | null;
  categories: string[];
  onSaved: () => void;
}

function ItemDialog({ open, onOpenChange, editing, categories, onSaved }: ItemDialogProps) {
  const { toast } = useToast();
  const [form, setForm] = useState<ItemForm>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [notesTouched, setNotesTouched] = useState(false);
  const [preview, setPreview] = useState<{ todo: { title: string; notes: string | null; due_at: string } | null; create_on?: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const lastTemplate = useRef<"titleTemplate" | "notesTemplate">("titleTemplate");

  const set = (patch: Partial<ItemForm>) => setForm((prev) => ({ ...prev, ...patch }));

  useEffect(() => {
    if (open) {
      setForm(editing ? formFromItem(editing) : emptyForm());
      setNotesTouched(!!editing);
      setPreview(null);
      setPreviewError(null);
    }
  }, [open, editing]);

  // The notes template's sensible default depends on whether there's an amount, until the person edits it.
  useEffect(() => {
    if (!notesTouched) set({ notesTemplate: form.amount.trim() === "" ? "Anytime {window}" : "About {amount} · anytime {window}" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.amount, notesTouched]);

  // Live preview, rendered by the server's own template engine so it can't disagree with what gets created.
  useEffect(() => {
    if (!open || !form.todoEnabled) return;
    const handle = setTimeout(() => {
      authFetch(`${API_BASE}/api/recurring-items/todo-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: form.label || "Example",
          expected_amount: expectedAmountOf(form),
          category: form.category || null,
          expected_date: form.anchorDate || todayIso(),
          window_before_days: Number(form.before) || 0,
          window_after_days: Number(form.after) || 0,
          todo_config: todoConfigOf(form),
        }),
      })
        .then(async (r) => {
          const body = await r.json();
          if (!r.ok) throw new Error(body.error ?? "Invalid to-do settings");
          setPreview(body);
          setPreviewError(null);
        })
        .catch((e) => setPreviewError(e.message));
    }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, form]);

  const insertPlaceholder = (name: string) => {
    const key = lastTemplate.current;
    setForm((prev) => ({ ...prev, [key]: `${prev[key]}{${name}}` }));
    if (key === "notesTemplate") setNotesTouched(true);
  };

  const submit = async () => {
    if (!form.label.trim()) {
      toast({ title: "Give it a name", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const res = await authFetch(`${API_BASE}/api/recurring-items${editing ? `/${editing.id}` : ""}`, {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        // Saving an edited suggestion is accepting it.
        body: JSON.stringify({ ...payloadOf(form), ...(editing && !editing.confirmed ? { confirmed: true } : {}) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not save");
      // Saving also tries to send the to-do right away when the range is already open.
      const sync = body.todo_sync as { created: number; failed: number; skippedReason?: string } | null;
      const todoNote = sync?.created
        ? "The to-do is on your list."
        : sync?.skippedReason
        ? `The to-do wasn't sent: ${sync.skippedReason}.`
        : sync?.failed
        ? "Sending the to-do failed; it will retry on the next sync."
        : undefined;
      toast({ title: editing ? "Saved" : "Recurring item added", description: todoNote });
      onSaved();
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? (editing.confirmed ? "Edit recurring item" : "Review suggestion") : "New recurring item"}</DialogTitle>
          <DialogDescription>Something expected on a schedule, with a range of days you have to do it in.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={form.label} onChange={(e) => set({ label: e.target.value })} placeholder="Rent" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Expected amount (optional)</Label>
              <div className="flex gap-2">
                <Select value={form.direction} onValueChange={(v) => set({ direction: v as "out" | "in" })}>
                  <SelectTrigger className="w-[92px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="out">Out</SelectItem>
                    <SelectItem value="in">In</SelectItem>
                  </SelectContent>
                </Select>
                <Input type="number" min="0" step="0.01" value={form.amount} onChange={(e) => set({ amount: e.target.value })} placeholder="1800" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Category (optional)</Label>
              <CategoryCombobox categories={categories} value={form.category || null} onChange={(v) => set({ category: v })} placeholder="Choose a category" triggerClassName="w-full" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Repeats</Label>
              <Select value={form.cadence} onValueChange={(v) => set({ cadence: v as Cadence })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(CADENCE_LABELS) as Cadence[]).map((c) => <SelectItem key={c} value={c}>{CADENCE_LABELS[c]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {form.cadence === "custom" ? (
              <div className="space-y-1.5">
                <Label>Every how many days</Label>
                <Input type="number" min="1" value={form.intervalDays} onChange={(e) => set({ intervalDays: e.target.value })} />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label>{form.cadence === "semi_monthly" ? "First date" : "Due on"}</Label>
                <Input type="date" value={form.anchorDate} onChange={(e) => set({ anchorDate: e.target.value })} />
              </div>
            )}
          </div>
          {form.cadence === "custom" && (
            <div className="space-y-1.5">
              <Label>Starting</Label>
              <Input type="date" value={form.anchorDate} onChange={(e) => set({ anchorDate: e.target.value })} />
            </div>
          )}

          <Card className="p-3 shadow-none border space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Days to do it</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Days before the date</Label>
                <Input type="number" min="0" max="31" value={form.before} onChange={(e) => set({ before: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Days after the date</Label>
                <Input type="number" min="0" max="60" value={form.after} onChange={(e) => set({ after: e.target.value })} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Doing it anywhere in this range counts as on time — e.g. rent due the 1st, paid the 1st through the 5th is 0 before, 4 after.
            </p>
          </Card>

          <div className="space-y-1.5">
            <Label>What the bank calls it (optional)</Label>
            <Input value={form.merchantHint} onChange={(e) => set({ merchantHint: e.target.value })} placeholder="Oak Street Apartments" />
            <p className="text-xs text-muted-foreground">Used to recognize the real transaction. Defaults to the name.</p>
          </div>

          <Card className="p-3 shadow-none border space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Add a to-do for each occurrence</p>
                <p className="text-xs text-muted-foreground">Appears in your to-do list when the range opens, and is checked off when the transaction shows up.</p>
              </div>
              <Switch checked={form.todoEnabled} onCheckedChange={(v) => set({ todoEnabled: v })} />
            </div>

            {form.todoEnabled && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Add it this many days before the range opens</Label>
                    <Input type="number" min="0" max="60" value={form.leadDays} onChange={(e) => set({ leadDays: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Due at</Label>
                    <Select value={form.due} onValueChange={(v) => set({ due: v as TodoDue })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="window_end">End of the range</SelectItem>
                        <SelectItem value="expected_date">The date itself</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">To-do title</Label>
                  <Input value={form.titleTemplate} onFocus={() => (lastTemplate.current = "titleTemplate")} onChange={(e) => set({ titleTemplate: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">To-do notes</Label>
                  <Input
                    value={form.notesTemplate}
                    onFocus={() => (lastTemplate.current = "notesTemplate")}
                    onChange={(e) => { set({ notesTemplate: e.target.value }); setNotesTouched(true); }}
                  />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {PLACEHOLDERS.map((p) => (
                    <button key={p} type="button" onClick={() => insertPlaceholder(p)} className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-secondary hover:bg-secondary/70">{`{${p}}`}</button>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">To-do category</Label>
                    <Input value={form.todoCategory} onChange={(e) => set({ todoCategory: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Priority (1–9)</Label>
                    <Input type="number" min="1" max="9" value={form.priority} onChange={(e) => set({ priority: e.target.value })} />
                  </div>
                </div>

                <div className="rounded-md bg-secondary/40 p-3 text-sm">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1 flex items-center gap-1"><ListChecks className="h-3 w-3" /> Preview</p>
                  {previewError ? (
                    <p className="text-destructive text-xs">{previewError}</p>
                  ) : preview?.todo ? (
                    <>
                      <p className="font-medium">{preview.todo.title}</p>
                      {preview.todo.notes && <p className="text-xs text-muted-foreground">{preview.todo.notes}</p>}
                      <p className="text-xs text-muted-foreground mt-1">Due {shortDate(preview.todo.due_at.slice(0, 10))}{preview.create_on ? ` · added ${shortDate(preview.create_on)}` : ""}</p>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">…</p>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">Each to-do is created once. Edits you make to it in your to-do list are kept, and changing this template only affects future ones.</p>
              </div>
            )}
          </Card>
        </div>

        <DialogFooter>
          <Button onClick={submit} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {editing && !editing.confirmed ? "Accept" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Cards ────────────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<Occurrence["status"], { label: string; className: string }> = {
  pending: { label: "Upcoming", className: "text-muted-foreground" },
  matched: { label: "Done", className: "text-emerald-600" },
  missed: { label: "Missed", className: "text-destructive" },
  skipped: { label: "Skipped", className: "text-muted-foreground" },
};

function OccurrenceHistory({ itemId }: { itemId: number }) {
  const [rows, setRows] = useState<Occurrence[] | null>(null);
  useEffect(() => {
    authFetch(`${API_BASE}/api/recurring-items/${itemId}/occurrences?limit=12`).then((r) => r.json()).then(setRows).catch(() => setRows([]));
  }, [itemId]);
  if (!rows) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground mt-3" />;
  if (rows.length === 0) return <p className="text-xs text-muted-foreground mt-3">No occurrences yet — run a sync.</p>;
  return (
    <div className="mt-3 border-t border-border pt-2 space-y-1">
      {rows.map((o) => (
        <div key={o.id} className="flex items-center justify-between text-xs">
          <span>{formatRange(o.window_start, o.window_end)}</span>
          <span className="flex items-center gap-2">
            {o.todo_id !== null && <ListChecks className={`h-3 w-3 ${o.todo_closed_at ? "text-emerald-600" : "text-muted-foreground"}`} aria-label="to-do" />}
            {o.todo_error && <span title={o.todo_error}><AlertTriangle className="h-3 w-3 text-amber-600" /></span>}
            <span className={STATUS_STYLE[o.status].className}>{STATUS_STYLE[o.status].label}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function ItemCard({ item, onEdit, onToggle, onDelete }: { item: RecurringItem; onEdit: () => void; onToggle: () => void; onDelete: () => void }) {
  const [showHistory, setShowHistory] = useState(false);
  const next = item.next_occurrence;
  const inDays = next ? daysUntil(next.window_start) : null;

  return (
    <Card className={`p-4 shadow-sm ${item.is_active ? "" : "opacity-60"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium truncate">{item.label}</p>
          <p className="text-xs text-muted-foreground truncate">
            {CADENCE_LABELS[item.cadence]}{item.cadence === "custom" ? ` (${item.interval_days}d)` : ""}
            {item.expected_amount !== null && ` · ${money(item.expected_amount)}`}
            {item.category && ` · ${item.category}`}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {item.todo_config?.enabled && <Badge variant="secondary" className="text-[10px]"><ListChecks className="h-3 w-3 mr-1" />To-do</Badge>}
          {!item.is_active && <Badge variant="outline" className="text-[10px]">Paused</Badge>}
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onEdit} aria-label="Edit"><Pencil className="h-3.5 w-3.5" /></Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onToggle} aria-label={item.is_active ? "Pause" : "Resume"}>
            {item.is_active ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onDelete} aria-label="Delete"><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button>
        </div>
      </div>

      <div className="mt-3 text-sm">
        {!item.is_active ? (
          <span className="text-muted-foreground">Paused</span>
        ) : next ? (
          <span className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
            {inDays !== null && inDays > 0 ? `Opens in ${inDays} day${inDays === 1 ? "" : "s"}` : "Open now"} · {formatRange(next.window_start, next.window_end)}
            <span className="text-xs text-muted-foreground">({describeRange(item)})</span>
          </span>
        ) : (
          <span className="text-muted-foreground">Next: {shortDate(item.next_expected_date)} — run a sync to schedule it</span>
        )}
      </div>

      <button type="button" className="mt-2 text-xs text-muted-foreground hover:text-foreground underline" onClick={() => setShowHistory(!showHistory)}>
        {showHistory ? "Hide history" : "History"}
      </button>
      {showHistory && <OccurrenceHistory itemId={item.id} />}
    </Card>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Recurring() {
  const { toast } = useToast();
  const [items, setItems] = useState<RecurringItem[] | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<RecurringItem | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/recurring-items`);
      if (!res.ok) throw new Error();
      setItems(await res.json());
    } catch {
      toast({ title: "Error", description: "Could not load recurring items", variant: "destructive" });
      setItems([]);
    }
  }, [toast]);

  useEffect(() => {
    load();
    authFetch(`${API_BASE}/api/transactions/categories`).then((r) => r.json()).then(setCategories).catch(() => {});
  }, [load]);

  const patch = async (item: RecurringItem, body: Record<string, unknown>) => {
    const res = await authFetch(`${API_BASE}/api/recurring-items/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) toast({ title: "Error", description: (await res.json().catch(() => ({}))).error ?? "Could not update", variant: "destructive" });
    await load();
  };

  const remove = async (item: RecurringItem) => {
    const res = await authFetch(`${API_BASE}/api/recurring-items/${item.id}`, { method: "DELETE" });
    if (!res.ok) toast({ title: "Error", description: "Could not delete", variant: "destructive" });
    else toast({ title: "Deleted", description: `${item.label} — to-dos already created are left in your list.` });
    await load();
  };

  const runSync = async () => {
    setSyncing(true);
    try {
      const res = await authFetch(`${API_BASE}/api/actions/sync-recurring/run`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Sync failed");
      const s = body.steps;
      const parts = [
        `${s.matched} matched`,
        `${s.missed} missed`,
        `${s.todos.created} to-do${s.todos.created === 1 ? "" : "s"} added`,
        s.todos.completed ? `${s.todos.completed} completed` : null,
        s.plaid.suggested ? `${s.plaid.suggested} new suggestion${s.plaid.suggested === 1 ? "" : "s"}` : null,
      ].filter(Boolean);
      const notes = [s.todos.skippedReason ? `To-dos skipped: ${s.todos.skippedReason}.` : null, s.todos.failed ? `${s.todos.failed} to-do${s.todos.failed === 1 ? "" : "s"} failed and will retry.` : null, ...s.errors].filter(Boolean);
      toast({ title: "Sync complete", description: [parts.join(", "), ...notes].join(" ") });
      await load();
    } catch (e: any) {
      toast({ title: "Sync failed", description: e.message, variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  };

  const openNew = () => { setEditing(null); setDialogOpen(true); };
  const openEdit = (item: RecurringItem) => { setEditing(item); setDialogOpen(true); };

  const suggestions = (items ?? []).filter((i) => !i.confirmed && i.is_active);
  const confirmed = (items ?? []).filter((i) => i.confirmed);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Recurring</h1>
          <p className="text-muted-foreground mt-1 text-sm">Bills, paychecks and chores on a schedule — with the days you have to do them in, matched to real transactions.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="shrink-0 bg-card" onClick={runSync} disabled={syncing}>
            {syncing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            Sync now
          </Button>
          <Button className="shrink-0 shadow-sm" onClick={openNew}><Plus className="h-4 w-4 mr-2" />New</Button>
        </div>
      </div>

      {items === null ? (
        <div className="flex justify-center p-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          {suggestions.length > 0 && (
            <section className="space-y-3">
              <p className="text-sm font-medium flex items-center gap-1.5"><Sparkles className="h-4 w-4" /> Found in your bank data</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {suggestions.map((s) => (
                  <Card key={s.id} className="p-4 shadow-sm border-dashed">
                    <p className="font-medium">{s.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {CADENCE_LABELS[s.cadence]}{s.expected_amount !== null && ` · ${money(s.expected_amount)}`} · next around {shortDate(s.next_expected_date)}
                    </p>
                    <div className="flex gap-2 mt-3">
                      <Button size="sm" onClick={() => patch(s, { confirmed: true })}><CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />Track it</Button>
                      <Button size="sm" variant="outline" onClick={() => openEdit(s)}><Pencil className="h-3.5 w-3.5 mr-1.5" />Edit first</Button>
                      <Button size="sm" variant="ghost" onClick={() => patch(s, { is_active: false })}><X className="h-3.5 w-3.5 mr-1.5" />Dismiss</Button>
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          )}

          {confirmed.length === 0 ? (
            <Card className="border-dashed border-2 shadow-none bg-transparent hover:bg-secondary/20 transition-colors cursor-pointer" onClick={openNew}>
              <div className="p-12 text-center flex flex-col items-center">
                <div className="h-12 w-12 rounded-full bg-secondary flex items-center justify-center mb-4"><Repeat className="h-6 w-6 text-muted-foreground" /></div>
                <h3 className="text-lg font-medium text-foreground">Nothing recurring yet</h3>
                <p className="text-muted-foreground text-sm mt-1 max-w-sm">Add rent with a 1st-to-5th window and a to-do that appears on the 1st, or let your bank data suggest what repeats.</p>
              </div>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {confirmed.map((item) => (
                <ItemCard key={item.id} item={item} onEdit={() => openEdit(item)} onToggle={() => patch(item, { is_active: !item.is_active })} onDelete={() => remove(item)} />
              ))}
            </div>
          )}
        </>
      )}

      <ItemDialog open={dialogOpen} onOpenChange={setDialogOpen} editing={editing} categories={categories} onSaved={load} />
    </div>
  );
}
