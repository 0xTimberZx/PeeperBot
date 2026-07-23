import type { BacktestExitEvent } from "@brokerforce/types";

// Per spec6.md: "visual timeline of the simulated period showing when the
// position was in vs. out of range, so the user sees the maintenance
// pattern, not just an aggregate percentage." Built purely from the exit/
// re-entry event list the backtest already returns -- flat colored segments
// on a time axis, in-range in the amber signal, out-of-range muted.
//
// Granularity honesty (spec acceptance criterion): the bar is labeled as
// daily-close resolution, so nobody reads intraday precision into it.

interface TimeInRangeTimelineProps {
  periodStart: string; // ISO dates
  periodEnd: string;
  exitTimeline: BacktestExitEvent[];
  timeInRangePct: number;
  /** The resolution this simulation actually ran on -- the label must state
   * the real one, never assume daily (Database.md §2's upgrade landed). */
  granularity: "daily" | "hourly";
}

interface Segment {
  fromPct: number;
  toPct: number;
  inRange: boolean;
  fromDate: string;
  toDate: string;
}

function buildSegments(props: TimeInRangeTimelineProps): Segment[] {
  const start = new Date(props.periodStart).getTime();
  const end = new Date(props.periodEnd).getTime();
  const span = Math.max(1, end - start);
  const pos = (iso: string) => Math.min(100, Math.max(0, ((new Date(iso).getTime() - start) / span) * 100));

  const events = [...props.exitTimeline].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );

  // Initial state: before the first event, the position is in range if the
  // first transition is an EXIT (you can only exit from inside). With no
  // events at all the whole period is one state -- the aggregate percentage
  // says which one.
  const first = events[0];
  let inRange = first ? first.type === "exit" : props.timeInRangePct >= 0.5;

  const segments: Segment[] = [];
  let cursorPct = 0;
  let cursorDate = props.periodStart;
  for (const ev of events) {
    const p = pos(ev.date);
    if (p > cursorPct) {
      segments.push({ fromPct: cursorPct, toPct: p, inRange, fromDate: cursorDate, toDate: ev.date });
    }
    inRange = ev.type === "re-entry";
    cursorPct = p;
    cursorDate = ev.date;
  }
  segments.push({ fromPct: cursorPct, toPct: 100, inRange, fromDate: cursorDate, toDate: props.periodEnd });
  return segments;
}

export function TimeInRangeTimeline(props: TimeInRangeTimelineProps) {
  const segments = buildSegments(props);

  return (
    <section className="border border-line bg-bg-panel p-5 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-sm text-ink">Time in range</h2>
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          based on {props.granularity} closes
        </span>
      </div>

      <div
        className="flex h-6 w-full border border-line overflow-hidden"
        role="img"
        aria-label={`In range ${(props.timeInRangePct * 100).toFixed(1)}% of the period; ${props.exitTimeline.filter((e) => e.type === "exit").length} exit(s).`}
      >
        {segments.map((s, i) => (
          <div
            key={i}
            title={`${s.inRange ? "In range" : "Out of range"}: ${s.fromDate} → ${s.toDate}`}
            style={{ width: `${s.toPct - s.fromPct}%` }}
            className={s.inRange ? "bg-signal/70" : "bg-line"}
          />
        ))}
      </div>

      <div className="flex items-center justify-between font-mono text-[10px] text-ink-muted">
        <span>{props.periodStart}</span>
        <span className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 bg-signal/70" /> in range
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 bg-line" /> out of range
          </span>
        </span>
        <span>{props.periodEnd}</span>
      </div>
    </section>
  );
}
