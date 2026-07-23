// Persistent, site-wide not-financial-advice disclaimer + data-source
// attribution. A disclaimer that only lives in docs/legal/ protects nobody --
// it has to be where users actually are, on every page. Kept deliberately
// quiet (muted, hairline-ruled, no accent) so it reads as a standing legal
// notice, not a call to action, but it is always present. Full text:
// docs/legal/DISCLAIMER.md and TERMS.md.
//
// Attribution is not just courtesy: CoinGecko's free/demo API terms REQUIRE
// visible attribution with a link back, and we source all price/market data
// from it. Third-party providers are credited distinctly here; the line below
// them states plainly which layers are BrokerForce's own computation, so the
// boundary between sourced data and our analysis is never ambiguous.

// Grouped by what each provider supplies (price / pools / Fear & Greed) rather
// than a flat list, so the credit reads as a sentence and the sourced-vs-ours
// boundary stays legible. A new provider is one <SourceLink> in the right group.
function SourceLink({ label, href }: { label: string; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="text-ink-muted underline decoration-line underline-offset-2 hover:text-ink focus-visible:text-ink outline-none focus-visible:ring-1 focus-visible:ring-line"
    >
      {label}
    </a>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-line mt-16">
      <div className="max-w-5xl mx-auto px-6 md:px-10 py-6 space-y-4">
        <div className="space-y-1">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            Informational only — not financial advice
          </p>
          <p className="font-body text-xs text-ink-muted max-w-prose leading-relaxed">
            BrokerForce is an analytics tool. ORT scores, rankings, and metrics are for general
            information only and are not investment, trading, legal, or tax advice, nor a
            recommendation to buy, sell, or hold any asset. Data may be inaccurate, delayed, or
            incomplete; DeFi carries risk of total loss. Do your own research — any decision is
            your own, made at your own risk.
          </p>
        </div>

        <div className="space-y-1 pt-3 border-t border-line">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">Data sources</p>
          <p className="font-body text-xs text-ink-muted max-w-prose leading-relaxed">
            Price &amp; market data by <SourceLink label="CoinGecko" href="https://www.coingecko.com" /> ·
            pool &amp; liquidity data by{" "}
            <SourceLink label="GeckoTerminal" href="https://www.geckoterminal.com" /> · Crypto Fear &amp;
            Greed by <SourceLink label="Alternative.me" href="https://alternative.me/crypto/fear-and-greed-index/" />,{" "}
            <SourceLink label="CoinMarketCap" href="https://coinmarketcap.com" /> &amp;{" "}
            <SourceLink label="CFGI" href="https://cfgi.io" />.{" "}
            <span className="italic">
              ORT scores, quadrant labels, range fits, and regime annotation are BrokerForce&rsquo;s own
              analysis, computed from the sourced data above.
            </span>
          </p>
        </div>
      </div>
    </footer>
  );
}
