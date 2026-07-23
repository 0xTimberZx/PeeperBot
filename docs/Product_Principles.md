# Product Principles

## 1. The One Rule That Overrides Everything

> **Nothing gets coded until we can explain why it exists in one sentence.**

If a feature can't be justified in one clean sentence, it isn't ready to spec, let alone build — go back to the sentence first.

## 2. The DNA Check

Every feature, page, or decision gets run through these five questions. If the answer to **any** of them is no, reconsider it before proceeding:

1. Does it reduce uncertainty for an LP?
2. Can we explain how it works?
3. Is it protocol agnostic?
4. Does it help users make a decision, not just display data?
5. Would we still build this if Uniswap disappeared tomorrow?

A feature that fails #4 (display, not decision) is the most common failure mode — it's easy to build a chart, harder to build something that actually tells someone what to do.

## 3. Priorities — What We Favor Over the Alternative

When two approaches both seem reasonable, default to the left side:

- Pair-level relationship analysis **over** single-asset analysis.
- Historical backtesting **over** static APR claims.
- Range optimization **over** generic dashboard metrics.
- ORT scoring **over** vague risk labeling.
- Modular, protocol-agnostic architecture **over** protocol-specific logic.

These aren't tie-breakers for close calls — they're the default lens. If a proposal pulls toward the right side of any of these, that's a reason to push back on it, not just a stylistic note.

## 4. Process Discipline — Docs Before Specs Before Code

BrokerForce is built **Define → Design → Build**:

1. **Define** — the constitution (`docs/`: Vision, Product_Principles, Roadmap, Architecture, ORT, Analytics, Database, API, Contributing, Glossary).
2. **Design** — a numbered spec per feature (`specs/001`, `002`, ...), covering Purpose, User stories, UI layout, Components, Data requirements, API requirements, Acceptance criteria, Future enhancements.
3. **Build** — each completed spec becomes a feature branch. Nothing gets built "just because" — every commit traces back to a documented decision and a spec.

If someone (including future us) wants to skip straight to code, the question to ask first is: *which spec does this trace back to?* If there isn't one, that's the actual next step, not the code.

**Doc lifecycle:** Vision → Discussion → Draft → Revision → Approve → Commit. Once a doc is approved, it isn't casually rewritten — changes get proposed explicitly, especially if they'd alter something other docs or specs already depend on.

## 5. What We Don't Build

- A DEX.
- Custody of user funds.
- A token, prematurely.
- Single-chain or single-protocol lock-in.
- Predictive price models.

These aren't just out of scope for now — they're structurally off-thesis. BrokerForce measures historical relationships to support decisions; it does not custody funds, issue a token before there's a reason to, or try to predict what price does next. A proposal that needs one of these to work is a sign the proposal doesn't fit the product, not a sign the list needs an exception.

## 6. Working Style

Every feature should be traceable through: **Idea → Product Principle → Spec → UI → Code → Test → Documentation.** Skipping a step is sometimes fine if moving fast matters more in the moment, but the skip should be visible, not silent — note what's being skipped rather than letting it quietly disappear.

When working through BrokerForce questions, treat the work as covering five roles as needed — Product Manager, Solutions Architect, Technical Writer, Senior Engineer, QA Partner — switching between them based on what the question actually calls for, without needing to announce which one is in use at a given moment.

## 7. The Standard We're Holding Ourselves To

Someone should be able to clone the repository in two years, read `docs/`, and become productive in a day — because the vision, the ORT algorithm, and the API contracts are documented and intentional, not because they're easy to guess from the code. Documentation is treated as Version 1.0 of the product, written before the components that implement it.
