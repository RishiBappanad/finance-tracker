import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { todayIso, parse, addDays, weekBounds, friendlyDate } from "@/lib/day-utils";

export { todayIso, addDays, weekBounds, friendlyDate };

// Day-by-day navigation for the Transactions page's Daily view -- the same
// idea as nutrition-insights' dashboard date bar (previous / next day, a date
// label, a jump back to Today), plus a week strip: one button per day of the
// selected date's week (Sunday to Saturday), each showing that day's spend, so
// the week reads like a small calendar and any day is one click away.
//
// Dates are plain "YYYY-MM-DD" strings in the user's local calendar, the same
// shape the API's `date` field uses, so there's no timezone conversion to get
// wrong between what's shown here and what the list filters on.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface DayNavigatorProps {
  date: string;
  onChange: (date: string) => void;
  /** Spend per day ("YYYY-MM-DD" -> dollars) for the week strip; days absent read as $0. */
  weekSpend: Record<string, number>;
}

export function DayNavigator({ date, onChange, weekSpend }: DayNavigatorProps) {
  const today = todayIso();
  const isToday = date === today;
  const { start } = weekBounds(date);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => onChange(addDays(date, -1))} aria-label="Previous day">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-border min-w-[140px] justify-center">
          <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-sm font-medium">{friendlyDate(date)}</span>
        </div>
        <Button variant="outline" size="icon" className="h-8 w-8" disabled={isToday || date > today} onClick={() => onChange(addDays(date, 1))} aria-label="Next day">
          <ChevronRight className="h-4 w-4" />
        </Button>
        {!isToday && (
          <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => onChange(today)}>
            Today
          </Button>
        )}
        <Input
          type="date"
          value={date}
          max={today}
          onChange={(e) => e.target.value && onChange(e.target.value)}
          className="w-auto h-8 text-xs bg-secondary/30 border-transparent ml-auto"
          aria-label="Jump to date"
        />
      </div>

      <div className="grid grid-cols-7 gap-1.5">
        {days.map((day, i) => {
          const future = day > today;
          const selected = day === date;
          const spend = weekSpend[day] ?? 0;
          return (
            <button
              key={day}
              type="button"
              disabled={future}
              onClick={() => onChange(day)}
              className={
                "rounded-md border px-1 py-2 text-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed " +
                (selected ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-secondary/50")
              }
            >
              <div className={"text-[10px] uppercase tracking-wide " + (selected ? "text-primary-foreground/80" : "text-muted-foreground")}>{WEEKDAYS[i]}</div>
              <div className="text-sm font-semibold leading-tight">{parse(day).getDate()}</div>
              <div className={"text-[10px] font-mono " + (selected ? "text-primary-foreground/80" : "text-muted-foreground")}>
                {future ? "" : spend > 0 ? `$${Math.round(spend)}` : "–"}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
