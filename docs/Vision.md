# Vision

## 1. Why BrokerForce Exists

Concentrated liquidity gave LPs more control and more ways to get it wrong. Choosing a pair and a range today is mostly guesswork dressed up as a UI — APR snapshots, gut feel, and copying whatever range looks busy on a chart. There is no common layer that tells an LP, in plain terms, whether a pair is statistically worth the risk.

BrokerForce exists to be that layer.

## 2. Mission

BrokerForce is a protocol-agnostic analytics platform that helps liquidity providers discover, evaluate, and optimize concentrated liquidity opportunities across the decentralized finance ecosystem.

## 3. The Problem

LPs are asked to make a precise decision — which pair, which range, for how long — with imprecise tools. Most existing dashboards show what already happened (APR, TVL, volume) without explaining the underlying relationship between the two assets being paired. As a result:

- Pair selection is driven by hype or familiarity, not historical relationship quality.
- Range selection is guesswork, often copied from whatever range looks active.
- Risk is described in adjectives ("high," "degen," "safe") instead of measured.
- Every protocol presents data differently, so comparing opportunities across DEXs means manually reconciling formats.

The result is capital allocated on vibes, in a strategy that punishes vibes.

## 4. Our Solution

BrokerForce treats every asset pair as its own statistical object — not two tokens, but one relationship with its own historical correlation, volatility, range behavior, and fee opportunity. It backtests that relationship instead of trusting a current APR figure, and compresses what it finds into a single comparable score: ORT (Opportunity, Risk, Time).

This turns three hard questions — *should I LP this pair, what range, for how long* — into something an LP can answer in minutes instead of guessing in seconds.

## 5. Product Philosophy

- Pair-level relationship analysis over single-asset analysis.
- Historical backtesting over static APR claims.
- Range optimization over generic dashboard metrics.
- ORT scoring over vague risk labeling.
- Modular, protocol-agnostic architecture over protocol-specific logic.

BrokerForce measures historical relationships to support better decisions. It does not predict prices, and it never will — that would compromise the structural, explainable nature of everything else it does.

## 6. What We Don't Build

- A DEX.
- A custodian of user funds.
- A token, at least not prematurely.
- Single-chain or single-protocol tooling that can't generalize.
- Predictive price models.

If Uniswap disappeared tomorrow, BrokerForce should still have a reason to exist.

## 7. Success Looks Like...

An LP opens BrokerForce before opening a position, not after losing money in one. They can name the pair, see its historical relationship, understand the suggested range and how long they'd likely stay in it, and trust the ORT score enough to act on it — or to walk away. Over time, BrokerForce becomes the place serious LPs check first, the way traders check a chart before a trade.
