// The quote-currency lens: USD (the default, whole-universe view) vs Gold
// (only pairs denominated in tokenized gold -- one side is XAUT/PAXG). Shared
// across the Dashboard rankings and Search so the toggle looks and behaves
// identically wherever the lens applies. Purely a filter control; it owns no
// data, just reports the selected lens up to the parent.

export type QuoteLens = "usd" | "gold";

interface QuoteLensToggleProps {
  value: QuoteLens;
  onChange: (lens: QuoteLens) => void;
  // Optional caption for context ("denominate in") -- omitted where the
  // surrounding copy already makes the meaning obvious.
  label?: string;
}

const OPTIONS: { lens: QuoteLens; text: string }[] = [
  { lens: "usd", text: "USD" },
  { lens: "gold", text: "Gold" },
];

export function QuoteLensToggle({ value, onChange, label }: QuoteLensToggleProps) {
  return (
    <div className="flex items-center gap-2">
      {label && (
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">{label}</span>
      )}
      <div
        role="group"
        aria-label="Quote currency"
        className="inline-flex border border-line divide-x divide-line"
      >
        {OPTIONS.map((o) => {
          const active = o.lens === value;
          return (
            <button
              key={o.lens}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(o.lens)}
              className={
                "px-2.5 py-1 font-mono text-[11px] uppercase tracking-wide transition-colors " +
                (active ? "bg-ink text-bg-deep" : "text-ink-muted hover:text-ink")
              }
            >
              {o.text}
            </button>
          );
        })}
      </div>
    </div>
  );
}
