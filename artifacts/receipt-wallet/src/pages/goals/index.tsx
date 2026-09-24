import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CategoryCombobox } from "@/components/category-combobox";
import { MultiSelectFilter } from "@/components/multi-select-filter";
import {
  Target,
  Plus,
  Trash2,
  TrendingUp,
  TrendingDown,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Sparkles,
} from "lucide-react";
import { API_BASE, authFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

// ── Types ────────────────────────────────────────────────────────────────
// Mirrors workspace-notes/RECURRING_AND_GOALS_SPEC.md's Goal Query shape --
// the cross-tracker-standardized contract every tracker's own Goals
// implementation follows. This page covers the realistic common case (one
// category filter, one aggregation per side) for the Advanced form -- the
// full generic shape also allows arbitrary multi-filter arrays and
// non-category filter fields (amount/event_type/owner_type/metadata.*),
// which this UI doesn't expose a builder for (Tenet #2 -- no real request
// for that yet; the API itself already supports it for anyone posting raw
// JSON directly).

type Comparator = "lte" | "gte" | "eq" | "within_tolerance_percent";
type Severity = "warning" | "target";
type Aggregation = "sum" | "mean" | "median" | "min" | "max" | "count" | "percentile";
type Period = "daily" | "weekly" | "monthly";
type TimeWindowKind = "current_period" | "trailing" | "same_period_last_year" | "fixed_range" | "all_time";

interface FilterCondition {
  field: string;
  operator: string;
  value: string | number | (string | number)[];
}

interface TimeWindow {
  kind: TimeWindowKind;
  period?: Period;
  count?: number;
  start?: string;
  end?: string;
}

interface GoalQuery {
  aggregation: Aggregation;
  percentile?: number;
  filters: FilterCondition[];
  timeWindow: TimeWindow;
  // Multiplier on the evaluated value. On a reference_query it makes the goal a
  // ratio against another category: dining <= 0.3 x income.
  scale?: number;
}

interface Goal {
  id: number;
  label: string | null;
  severity: Severity;
  is_active: boolean;
  comparator: Comparator;
  tolerance_percent: number | null;
  measure_query: GoalQuery;
  reference_amount: number | null;
  reference_query: GoalQuery | null;
  reference_scale?: number | null;
  inflation_adjusted: boolean;
  notify_on_crossing: boolean;
}

interface GoalStatus {
  measure_value: number;
  reference_value: number;
  comparator: Comparator;
  tolerance_percent: number | null;
  percent: number;
  on_track: boolean;
  severity: Severity;
}

interface Preset {
  name: string;
  comparator: Comparator;
  period?: Period;
  tolerance_percent?: number;
  inflation_adjusted?: boolean;
  measure_query?: GoalQuery;
  reference_query?: GoalQuery;
}

// ── Helpers ──────────────────────────────────────────────────────────────

// Handles both shapes categoryFilters() (below) can produce: a single
// `eq` filter, or an `in` filter for a combined multi-category goal --
// joins the latter into one readable label ("Food & Dining + Groceries").
function categoryFromQuery(query: GoalQuery | null | undefined): string | null {
  const filter = query?.filters.find((f) => f.field === "category" && (f.operator === "eq" || f.operator === "in"));
  if (!filter) return null;
  if (Array.isArray(filter.value)) return filter.value.join(" + ");
  return typeof filter.value === "string" ? filter.value : null;
}

function comparatorLabel(comparator: Comparator, tolerancePercent: number | null): string {
  switch (comparator) {
    case "lte":
      return "at most";
    case "gte":
      return "at least";
    case "eq":
      return "exactly";
    case "within_tolerance_percent":
      return `within ±${tolerancePercent ?? 0}% of`;
  }
}

function periodLabel(period?: Period): string {
  switch (period) {
    case "daily":
      return "day";
    case "weekly":
      return "week";
    case "monthly":
      return "month";
    default:
      return "period";
  }
}

function formatMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

// "a computed baseline" for a trend on the same categories; "0.3 × Income" when
// the goal is compared against a computation on OTHER categories, or scaled.
function referenceText(goal: Goal): string {
  const scale = goal.reference_scale ?? 1;
  const measureCat = categoryFromQuery(goal.measure_query);
  const refCat = categoryFromQuery(goal.reference_query);
  if (refCat !== measureCat || scale !== 1) {
    return `${scale === 1 ? "" : `${scale} × `}${refCat ?? "every category"}`;
  }
  return "a computed baseline";
}

function goalSubtitle(goal: Goal): string {
  const period = goal.measure_query.timeWindow.period;
  if (goal.reference_query) {
    const ref = goal.reference_query;
    const baselineDesc =
      ref.timeWindow.kind === "current_period"
        ? `this same ${periodLabel(ref.timeWindow.period)}`
        : ref.timeWindow.kind === "trailing"
        ? `trailing ${ref.timeWindow.count}-${periodLabel(ref.timeWindow.period)} ${ref.aggregation}`
        : ref.timeWindow.kind === "same_period_last_year"
        ? `same ${periodLabel(ref.timeWindow.period)} ${ref.timeWindow.count === 1 ? "last year" : `${ref.timeWindow.count} years back`}`
        : ref.timeWindow.kind === "all_time"
        ? "all-time"
        : "a fixed range";
    return `${goal.measure_query.aggregation} per ${periodLabel(period)}, vs. ${baselineDesc}${goal.inflation_adjusted ? " (inflation-adjusted)" : ""}`;
  }
  return `${goal.measure_query.aggregation} per ${periodLabel(period)}`;
}

// ── Goal card ────────────────────────────────────────────────────────────

function GoalCard({ goal, status, onDelete }: { goal: Goal; status: GoalStatus | undefined; onDelete: (id: number) => void }) {
  const category = categoryFromQuery(goal.measure_query) ?? "Every category";
  const isWarning = goal.severity === "warning";

  return (
    <Card className="p-5 shadow-sm relative group">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div
            className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 ${
              status === undefined
                ? "bg-secondary"
                : status.on_track
                ? "bg-emerald-500/10"
                : isWarning
                ? "bg-amber-500/10"
                : "bg-destructive/10"
            }`}
          >
            <Target
              className={`h-4 w-4 ${
                status === undefined
                  ? "text-muted-foreground"
                  : status.on_track
                  ? "text-emerald-600"
                  : isWarning
                  ? "text-amber-600"
                  : "text-destructive"
              }`}
            />
          </div>
          <div className="min-w-0">
            <p className="font-medium text-foreground truncate">{goal.label || category}</p>
            <p className="text-xs text-muted-foreground truncate">{category}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Badge variant={isWarning ? "outline" : "secondary"} className="text-[10px]">
            {isWarning ? "Warning" : "Target"}
          </Badge>
          <Button
            variant="ghost"
            size="icon"
            className="opacity-0 group-hover:opacity-100 transition-opacity h-7 w-7"
            onClick={() => onDelete(goal.id)}
          >
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground mt-3">
        {comparatorLabel(goal.comparator, goal.tolerance_percent)}{" "}
        {goal.reference_query ? referenceText(goal) : formatMoney(goal.reference_amount ?? 0)} —{" "}
        {goalSubtitle(goal)}
      </p>

      <div className="mt-4">
        {status === undefined ? (
          <div className="h-2 w-full bg-secondary rounded-full animate-pulse" />
        ) : (
          <>
            <Progress
              value={Math.min(status.percent, 100)}
              className={status.on_track ? "" : isWarning ? "[&>div]:bg-amber-500" : "[&>div]:bg-destructive"}
            />
            <div className="flex items-center justify-between mt-2">
              <span className="text-sm font-mono">
                {formatMoney(status.measure_value)}{" "}
                <span className="text-muted-foreground">/ {formatMoney(status.reference_value)}</span>
              </span>
              <span
                className={`text-xs font-medium flex items-center gap-1 ${
                  status.on_track ? "text-emerald-600" : isWarning ? "text-amber-600" : "text-destructive"
                }`}
              >
                {status.on_track ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5" /> On track
                  </>
                ) : (
                  <>
                    {goal.comparator === "gte" ? <TrendingDown className="h-3.5 w-3.5" /> : <TrendingUp className="h-3.5 w-3.5" />}
                    {goal.comparator === "gte" ? "Below target" : "Over"}
                  </>
                )}
              </span>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

// ── Create goal dialog ───────────────────────────────────────────────────

const AGGREGATIONS: { value: Aggregation; label: string }[] = [
  { value: "sum", label: "Sum" },
  { value: "mean", label: "Average" },
  { value: "median", label: "Median" },
  { value: "min", label: "Minimum" },
  { value: "max", label: "Maximum" },
  { value: "count", label: "Count" },
  { value: "percentile", label: "Percentile" },
];

type BaselineKind = "current_period" | "trailing" | "same_period_last_year" | "all_time" | "fixed_range";

interface AdvancedFormState {
  // Independent category sets for each side of the comparison -- e.g.
  // "cap Food & Dining" measured against "my Income category went up,
  // so let this baseline reflect that" is a genuinely different category
  // on each side, not the same one over a different window. Each is
  // multi-select ([] = no category filter, i.e. every category; 1 value
  // -> an `eq` filter; 2+ -> an `in` filter) so "these categories
  // combined shouldn't exceed X" is expressible directly.
  measureCategories: string[];
  referenceCategories: string[];
  measureAggregation: Aggregation;
  measurePercentile: number;
  period: Period;
  comparator: Comparator;
  tolerancePercent: number;
  referenceMode: "fixed" | "computed";
  referenceAmount: number;
  refAggregation: Aggregation;
  refPercentile: number;
  baselineKind: BaselineKind;
  // Multiplier on the baseline. 1 = compare against it as-is; 0.3 with a
  // different baseline category = "no more than 30% of that category".
  scale: number;
  trailingCount: number;
  yearsBackCount: number;
  fixedStart: string;
  fixedEnd: string;
  inflationAdjusted: boolean;
  severity: Severity;
  notifyOnCrossing: boolean;
  label: string;
}

function defaultAdvancedForm(): AdvancedFormState {
  return {
    measureCategories: [],
    referenceCategories: [],
    measureAggregation: "sum",
    measurePercentile: 95,
    period: "monthly",
    comparator: "lte",
    tolerancePercent: 15,
    referenceMode: "fixed",
    referenceAmount: 0,
    refAggregation: "mean",
    refPercentile: 95,
    baselineKind: "trailing",
    scale: 1,
    trailingCount: 3,
    yearsBackCount: 1,
    fixedStart: "",
    fixedEnd: "",
    inflationAdjusted: false,
    severity: "target",
    notifyOnCrossing: true,
    label: "",
  };
}

function buildReferenceTimeWindow(form: AdvancedFormState): TimeWindow {
  switch (form.baselineKind) {
    case "current_period":
      return { kind: "current_period", period: form.period };
    case "trailing":
      return { kind: "trailing", period: form.period, count: form.trailingCount };
    case "same_period_last_year":
      return { kind: "same_period_last_year", period: form.period, count: form.yearsBackCount };
    case "all_time":
      return { kind: "all_time" };
    case "fixed_range":
      return { kind: "fixed_range", start: form.fixedStart, end: form.fixedEnd };
  }
}

// []  -> no category filter at all (every category counts)
// [c] -> a single `eq` filter, the common case
// [..]-> an `in` filter -- "these categories combined" (a real request:
//        e.g. Food & Dining + Groceries + Entertainment together capped
//        at one amount, not three separate goals).
function categoryFilters(categories: string[]): FilterCondition[] {
  if (categories.length === 0) return [];
  if (categories.length === 1) return [{ field: "category", operator: "eq", value: categories[0] }];
  return [{ field: "category", operator: "in", value: categories }];
}

function buildAdvancedPayload(form: AdvancedFormState) {
  const measure_query: GoalQuery = {
    aggregation: form.measureAggregation,
    ...(form.measureAggregation === "percentile" ? { percentile: form.measurePercentile } : {}),
    filters: categoryFilters(form.measureCategories),
    timeWindow: { kind: "current_period", period: form.period },
  };

  const base: Record<string, unknown> = {
    label: form.label || null,
    severity: form.severity,
    comparator: form.comparator,
    measure_query,
    notify_on_crossing: form.notifyOnCrossing,
    ...(form.comparator === "within_tolerance_percent" ? { tolerance_percent: form.tolerancePercent } : {}),
  };

  if (form.referenceMode === "fixed") {
    return { ...base, reference_amount: form.referenceAmount, reference_query: null, inflation_adjusted: false };
  }

  // Deliberately independent from measureCategories -- a baseline
  // computed from a DIFFERENT category (or set of categories) than
  // what's being measured is exactly the point (e.g. "let my food budget
  // flex with my income category," not just "flex with my own history").
  const reference_query: GoalQuery = {
    aggregation: form.refAggregation,
    ...(form.refAggregation === "percentile" ? { percentile: form.refPercentile } : {}),
    filters: categoryFilters(form.referenceCategories),
    timeWindow: buildReferenceTimeWindow(form),
    ...(form.scale !== 1 ? { scale: form.scale } : {}),
  };
  return { ...base, reference_query, reference_amount: null, inflation_adjusted: form.inflationAdjusted };
}

function applyPresetToAdvancedForm(preset: Preset, category: string): AdvancedFormState {
  const form = defaultAdvancedForm();
  // Every preset's own measure_query/reference_query share one category
  // by design (that's what a preset IS) -- start both sides there; the
  // user can then split referenceCategories off to something else.
  form.measureCategories = [category];
  form.referenceCategories = [category];
  form.comparator = preset.comparator;
  form.severity = "target";
  if (preset.tolerance_percent !== undefined) form.tolerancePercent = preset.tolerance_percent;
  if (preset.inflation_adjusted) form.inflationAdjusted = true;
  if (preset.measure_query) {
    form.measureAggregation = preset.measure_query.aggregation;
    if (preset.measure_query.percentile !== undefined) form.measurePercentile = preset.measure_query.percentile;
    if (preset.measure_query.timeWindow.period) form.period = preset.measure_query.timeWindow.period;
  }
  if (preset.reference_query) {
    form.referenceMode = "computed";
    form.refAggregation = preset.reference_query.aggregation;
    if (preset.reference_query.percentile !== undefined) form.refPercentile = preset.reference_query.percentile;
    const tw = preset.reference_query.timeWindow;
    form.baselineKind = tw.kind as BaselineKind;
    form.scale = preset.reference_query.scale ?? 1;
    if (tw.count !== undefined) {
      if (tw.kind === "trailing") form.trailingCount = tw.count;
      if (tw.kind === "same_period_last_year") form.yearsBackCount = tw.count;
    }
  } else {
    form.referenceMode = "fixed";
  }
  return form;
}

interface CreateGoalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: string[];
  onCreated: () => void;
}

function CreateGoalDialog({ open, onOpenChange, categories, onCreated }: CreateGoalDialogProps) {
  const { toast } = useToast();
  const [tab, setTab] = useState<"basic" | "presets" | "advanced">("basic");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [presets, setPresets] = useState<{ basic: Preset[]; advanced: Preset[] } | null>(null);
  const [presetCategory, setPresetCategory] = useState("");

  // Basic form
  const [basicCategory, setBasicCategory] = useState("");
  const [basicComparator, setBasicComparator] = useState<"lte" | "gte">("lte");
  const [basicAmount, setBasicAmount] = useState("");
  const [basicPeriod, setBasicPeriod] = useState<Period>("monthly");
  const [basicSeverity, setBasicSeverity] = useState<Severity>("target");

  // Advanced form
  const [advanced, setAdvanced] = useState<AdvancedFormState>(defaultAdvancedForm());

  useEffect(() => {
    if (open && !presets) {
      authFetch(`${API_BASE}/api/goals/presets`)
        .then((r) => r.json())
        .then(setPresets)
        .catch(() => {});
    }
  }, [open, presets]);

  useEffect(() => {
    if (open) {
      setTab("basic");
      setBasicCategory("");
      setBasicAmount("");
      setAdvanced(defaultAdvancedForm());
      setPresetCategory("");
    }
  }, [open]);

  const submitBasic = async () => {
    if (!basicCategory || !basicAmount) {
      toast({ title: "Missing info", description: "Pick a category and an amount.", variant: "destructive" });
      return;
    }
    setIsSubmitting(true);
    try {
      const res = await authFetch(`${API_BASE}/api/goals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: basicCategory,
          comparator: basicComparator,
          target_amount: Number(basicAmount),
          period: basicPeriod,
          severity: basicSeverity,
        }),
      });
      if (!res.ok) throw new Error();
      toast({ title: "Goal created" });
      onCreated();
      onOpenChange(false);
    } catch {
      toast({ title: "Error", description: "Could not create goal", variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  const submitAdvanced = async () => {
    // No category is a valid, meaningful choice here (unlike Basic/
    // Presets) -- an empty selection means "every category," e.g. "total
    // spending this month" -- so there's nothing to validate before
    // submitting; the server validates comparator/aggregation shape.
    setIsSubmitting(true);
    try {
      const res = await authFetch(`${API_BASE}/api/goals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildAdvancedPayload(advanced)),
      });
      if (!res.ok) throw new Error();
      toast({ title: "Goal created" });
      onCreated();
      onOpenChange(false);
    } catch {
      toast({ title: "Error", description: "Could not create goal", variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  const applyPreset = (preset: Preset) => {
    if (!presetCategory) {
      toast({ title: "Pick a category first", description: "Presets apply to one category at a time.", variant: "destructive" });
      return;
    }
    if (preset.measure_query || preset.reference_query) {
      setAdvanced(applyPresetToAdvancedForm(preset, presetCategory));
      setTab("advanced");
    } else {
      setBasicCategory(presetCategory);
      setBasicComparator(preset.comparator === "gte" ? "gte" : "lte");
      setBasicPeriod(preset.period ?? "monthly");
      setTab("basic");
    }
    toast({ title: `Applied "${preset.name}"`, description: "Review and fill in the remaining fields, then create." });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Goal</DialogTitle>
          <DialogDescription>Compare your spending against a hardcoded amount or a computed historical baseline.</DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList className="grid grid-cols-3 w-full">
            <TabsTrigger value="basic">Basic</TabsTrigger>
            <TabsTrigger value="presets">Presets</TabsTrigger>
            <TabsTrigger value="advanced">Advanced</TabsTrigger>
          </TabsList>

          {/* Basic */}
          <TabsContent value="basic" className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <Label>Category</Label>
              <CategoryCombobox
                categories={categories}
                value={basicCategory || null}
                onChange={setBasicCategory}
                placeholder="Choose a category"
                triggerClassName="w-full"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Comparator</Label>
                <Select value={basicComparator} onValueChange={(v) => setBasicComparator(v as "lte" | "gte")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="lte">At most</SelectItem>
                    <SelectItem value="gte">At least</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Amount</Label>
                <Input type="number" step="0.01" value={basicAmount} onChange={(e) => setBasicAmount(e.target.value)} placeholder="400" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Period</Label>
                <Select value={basicPeriod} onValueChange={(v) => setBasicPeriod(v as Period)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Severity</Label>
                <Select value={basicSeverity} onValueChange={(v) => setBasicSeverity(v as Severity)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="target">Target (hard cap)</SelectItem>
                    <SelectItem value="warning">Warning (soft alert)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={submitBasic} disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Create Goal
              </Button>
            </DialogFooter>
          </TabsContent>

          {/* Presets */}
          <TabsContent value="presets" className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <Label>Apply to category</Label>
              <CategoryCombobox
                categories={categories}
                value={presetCategory || null}
                onChange={setPresetCategory}
                placeholder="Choose a category"
                triggerClassName="w-full"
              />
            </div>
            {!presets ? (
              <div className="flex justify-center p-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">Basic</p>
                  <div className="space-y-2">
                    {presets.basic.map((p) => (
                      <Card
                        key={p.name}
                        className="p-3 shadow-none border cursor-pointer hover:bg-secondary/30 transition-colors flex items-center justify-between"
                        onClick={() => applyPreset(p)}
                      >
                        <span className="text-sm font-medium">{p.name}</span>
                        <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                      </Card>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide flex items-center gap-1">
                    <Sparkles className="h-3 w-3" /> Advanced
                  </p>
                  <div className="space-y-2">
                    {presets.advanced.map((p) => (
                      <Card
                        key={p.name}
                        className="p-3 shadow-none border cursor-pointer hover:bg-secondary/30 transition-colors flex items-center justify-between"
                        onClick={() => applyPreset(p)}
                      >
                        <span className="text-sm font-medium">{p.name}</span>
                        <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                      </Card>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </TabsContent>

          {/* Advanced */}
          <TabsContent value="advanced" className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <Label>Label (optional)</Label>
              <Input value={advanced.label} onChange={(e) => setAdvanced({ ...advanced, label: e.target.value })} placeholder="Dining budget" />
            </div>
            <Card className="p-3 shadow-none border space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">What's being measured</p>
              <div className="space-y-1.5">
                <Label className="text-xs">
                  Categories{" "}
                  <span className="text-muted-foreground font-normal normal-case">
                    (pick several to cap them combined — none picked means every category)
                  </span>
                </Label>
                <MultiSelectFilter
                  label="Every category"
                  options={categories}
                  selected={advanced.measureCategories}
                  onChange={(v) => setAdvanced({ ...advanced, measureCategories: v })}
                  className="w-full min-w-0"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Aggregation</Label>
                  <Select value={advanced.measureAggregation} onValueChange={(v) => setAdvanced({ ...advanced, measureAggregation: v as Aggregation })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AGGREGATIONS.map((a) => (
                        <SelectItem key={a.value} value={a.value}>
                          {a.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">This period</Label>
                  <Select value={advanced.period} onValueChange={(v) => setAdvanced({ ...advanced, period: v as Period })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="monthly">Monthly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {advanced.measureAggregation === "percentile" && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Percentile</Label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={advanced.measurePercentile}
                    onChange={(e) => setAdvanced({ ...advanced, measurePercentile: Number(e.target.value) })}
                  />
                </div>
              )}
            </Card>

            <Card className="p-3 shadow-none border space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Compared against</p>
              <div className="flex items-center gap-1 p-1 bg-secondary/40 rounded-lg w-fit">
                <button
                  type="button"
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                    advanced.referenceMode === "fixed" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground"
                  }`}
                  onClick={() => setAdvanced({ ...advanced, referenceMode: "fixed" })}
                >
                  Fixed amount
                </button>
                <button
                  type="button"
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                    advanced.referenceMode === "computed" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground"
                  }`}
                  onClick={() => setAdvanced({ ...advanced, referenceMode: "computed" })}
                >
                  Computed baseline
                </button>
              </div>

              {advanced.referenceMode === "fixed" ? (
                <div className="space-y-1.5">
                  <Label className="text-xs">Amount</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={advanced.referenceAmount || ""}
                    onChange={(e) => setAdvanced({ ...advanced, referenceAmount: Number(e.target.value) })}
                    placeholder="400"
                  />
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">
                        Baseline categories{" "}
                        <span className="text-muted-foreground font-normal">(can differ from what's measured)</span>
                      </Label>
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        className="h-auto p-0 text-xs"
                        onClick={() => setAdvanced({ ...advanced, referenceCategories: advanced.measureCategories })}
                      >
                        Same as measured
                      </Button>
                    </div>
                    <MultiSelectFilter
                      label="Every category"
                      options={categories}
                      selected={advanced.referenceCategories}
                      onChange={(v) => setAdvanced({ ...advanced, referenceCategories: v })}
                      className="w-full min-w-0"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Aggregation</Label>
                      <Select value={advanced.refAggregation} onValueChange={(v) => setAdvanced({ ...advanced, refAggregation: v as Aggregation })}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {AGGREGATIONS.map((a) => (
                            <SelectItem key={a.value} value={a.value}>
                              {a.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Baseline</Label>
                      <Select value={advanced.baselineKind} onValueChange={(v) => setAdvanced({ ...advanced, baselineKind: v as BaselineKind })}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="current_period">This same period</SelectItem>
                          <SelectItem value="trailing">Trailing periods</SelectItem>
                          <SelectItem value="same_period_last_year">Same period, years back</SelectItem>
                          <SelectItem value="all_time">All time</SelectItem>
                          <SelectItem value="fixed_range">Fixed date range</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">
                      Multiplier{" "}
                      <span className="text-muted-foreground font-normal">
                        (0.3 = "at most 30% of" the baseline — pair with different baseline categories for a ratio)
                      </span>
                    </Label>
                    <Input
                      type="number"
                      min={0}
                      step="any"
                      value={advanced.scale}
                      onChange={(e) => setAdvanced({ ...advanced, scale: Number(e.target.value) })}
                    />
                    {advanced.scale !== 1 && advanced.scale > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {advanced.measureCategories.join(" + ") || "Every category"} {comparatorLabel(advanced.comparator, advanced.tolerancePercent)}{" "}
                        {advanced.scale} × {advanced.referenceCategories.join(" + ") || "every category"}
                      </p>
                    )}
                  </div>
                  {advanced.refAggregation === "percentile" && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">Percentile</Label>
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        value={advanced.refPercentile}
                        onChange={(e) => setAdvanced({ ...advanced, refPercentile: Number(e.target.value) })}
                      />
                    </div>
                  )}
                  {advanced.baselineKind === "trailing" && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">Trailing how many {periodLabel(advanced.period)}s</Label>
                      <Input
                        type="number"
                        min={1}
                        value={advanced.trailingCount}
                        onChange={(e) => setAdvanced({ ...advanced, trailingCount: Number(e.target.value) })}
                      />
                    </div>
                  )}
                  {advanced.baselineKind === "same_period_last_year" && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">How many years back (averaged)</Label>
                      <Input
                        type="number"
                        min={1}
                        value={advanced.yearsBackCount}
                        onChange={(e) => setAdvanced({ ...advanced, yearsBackCount: Number(e.target.value) })}
                      />
                    </div>
                  )}
                  {advanced.baselineKind === "fixed_range" && (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs">From</Label>
                        <Input type="date" value={advanced.fixedStart} onChange={(e) => setAdvanced({ ...advanced, fixedStart: e.target.value })} />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">To</Label>
                        <Input type="date" value={advanced.fixedEnd} onChange={(e) => setAdvanced({ ...advanced, fixedEnd: e.target.value })} />
                      </div>
                    </div>
                  )}
                  {(advanced.baselineKind === "trailing" || advanced.baselineKind === "same_period_last_year") && (
                    <div className="flex items-center justify-between pt-1">
                      <Label className="text-xs">Inflation-adjust the baseline (monthly goals only)</Label>
                      <Switch
                        checked={advanced.inflationAdjusted}
                        onCheckedChange={(v) => setAdvanced({ ...advanced, inflationAdjusted: v })}
                      />
                    </div>
                  )}
                </div>
              )}
            </Card>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Comparator</Label>
                <Select value={advanced.comparator} onValueChange={(v) => setAdvanced({ ...advanced, comparator: v as Comparator })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="lte">At most</SelectItem>
                    <SelectItem value="gte">At least</SelectItem>
                    <SelectItem value="eq">Exactly</SelectItem>
                    <SelectItem value="within_tolerance_percent">Within a % band</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {advanced.comparator === "within_tolerance_percent" ? (
                <div className="space-y-1.5">
                  <Label>Tolerance ±%</Label>
                  <Input
                    type="number"
                    min={0}
                    value={advanced.tolerancePercent}
                    onChange={(e) => setAdvanced({ ...advanced, tolerancePercent: Number(e.target.value) })}
                  />
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label>Severity</Label>
                  <Select value={advanced.severity} onValueChange={(v) => setAdvanced({ ...advanced, severity: v as Severity })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="target">Target (hard cap)</SelectItem>
                      <SelectItem value="warning">Warning (soft alert)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
            {advanced.comparator === "within_tolerance_percent" && (
              <div className="space-y-1.5">
                <Label>Severity</Label>
                <Select value={advanced.severity} onValueChange={(v) => setAdvanced({ ...advanced, severity: v as Severity })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="target">Target (hard cap)</SelectItem>
                    <SelectItem value="warning">Warning (soft alert)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex items-center justify-between">
              <Label className="text-sm">Notify when this goal crosses</Label>
              <Switch checked={advanced.notifyOnCrossing} onCheckedChange={(v) => setAdvanced({ ...advanced, notifyOnCrossing: v })} />
            </div>

            <DialogFooter>
              <Button onClick={submitAdvanced} disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Create Goal
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ────────────────────────────────────────────────────────────

export default function Goals() {
  const { toast } = useToast();
  const [goals, setGoals] = useState<Goal[] | null>(null);
  const [statuses, setStatuses] = useState<Record<number, GoalStatus>>({});
  const [categories, setCategories] = useState<string[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const loadGoals = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await authFetch(`${API_BASE}/api/goals?active=true`);
      const list: Goal[] = await res.json();
      setGoals(list);

      const entries = await Promise.all(
        list.map(async (g) => {
          const r = await authFetch(`${API_BASE}/api/goals/${g.id}/status`);
          return [g.id, await r.json()] as const;
        })
      );
      setStatuses(Object.fromEntries(entries));
    } catch {
      toast({ title: "Error", description: "Could not load goals", variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadGoals();
    authFetch(`${API_BASE}/api/transactions/categories`)
      .then((r) => r.json())
      .then(setCategories)
      .catch(() => {});
  }, [loadGoals]);

  const handleDelete = async (id: number) => {
    try {
      const res = await authFetch(`${API_BASE}/api/goals/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setGoals((prev) => (prev ? prev.filter((g) => g.id !== id) : prev));
      toast({ title: "Goal deleted" });
    } catch {
      toast({ title: "Error", description: "Could not delete goal", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Goals</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Set a target, hardcoded or computed from your own history, and get flagged the moment it's crossed.
          </p>
        </div>
        <Button className="shrink-0 shadow-sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          New Goal
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center p-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : !goals || goals.length === 0 ? (
        <Card
          className="border-dashed border-2 shadow-none bg-transparent hover:bg-secondary/20 transition-colors cursor-pointer"
          onClick={() => setDialogOpen(true)}
        >
          <div className="p-12 text-center flex flex-col items-center">
            <div className="h-12 w-12 rounded-full bg-secondary flex items-center justify-center mb-4">
              <Target className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium text-foreground">No goals yet</h3>
            <p className="text-muted-foreground text-sm mt-1 max-w-sm">
              Cap your dining spend at $400/month, or compare it to your own trailing 3-month average — pick a category and set a goal.
            </p>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {goals.map((g) => (
            <GoalCard key={g.id} goal={g} status={statuses[g.id]} onDelete={handleDelete} />
          ))}
        </div>
      )}

      <CreateGoalDialog open={dialogOpen} onOpenChange={setDialogOpen} categories={categories} onCreated={loadGoals} />
    </div>
  );
}
