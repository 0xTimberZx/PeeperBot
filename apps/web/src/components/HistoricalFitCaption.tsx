// The not-a-prediction framing [spec8 6a], one component so the wording
// can't drift between surfaces. The TEXT itself comes from the server
// response (caption field) -- this component owns only the presentation and
// the rule that suggestions never render without it.

interface HistoricalFitCaptionProps {
  caption: string;
}

export function HistoricalFitCaption({ caption }: HistoricalFitCaptionProps) {
  return <p className="font-body text-[11px] leading-relaxed text-ink-muted">{caption}</p>;
}
