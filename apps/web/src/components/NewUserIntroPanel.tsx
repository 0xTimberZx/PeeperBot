import { Link } from "react-router-dom";

// Example pairs for a first visit -- blue-chip combinations that exist in
// any generated pair universe, so these links land on real pages, not 404s.
const EXAMPLE_PAIRS: [string, string][] = [
  ["BTC", "ETH"],
  ["ETH", "SOL"],
  ["ETH", "LINK"],
];

/**
 * spec1.md's empty/new-user state: shown when there's no personal history,
 * so a first-time visitor still lands on a page that explains the product
 * and gives them somewhere real to click -- never a mostly-blank dashboard.
 */
export function NewUserIntroPanel() {
  return (
    <section className="border border-line bg-bg-panel p-5">
      <h2 className="font-display text-sm text-ink">What is BrokerForce?</h2>
      <p className="font-body text-sm text-ink-muted mt-3 max-w-prose">
        BrokerForce evaluates concentrated-liquidity opportunities across DeFi and condenses each pair's
        volume, stability, volatility, and liquidity behavior into one decision number — the ORT score.
        Pick a pair to see its full statistical profile, its live pools, and what a position would have
        earned.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {EXAMPLE_PAIRS.map(([a, b]) => (
          <Link
            key={`${a}${b}`}
            to={`/pairs/${a}/${b}`}
            className="border border-line px-3 py-1.5 font-mono text-sm text-ink hover:border-signal"
          >
            {a}/{b}
          </Link>
        ))}
      </div>
    </section>
  );
}
