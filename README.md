# Fantasy HLTV Picker

Deterministic HLTV Fantasy lineup optimizer focused on "win vs field" decisions.

It combines:
- player card stats from your fantasy draft HTML,
- historical player ratings from local `stats/*.html`,
- optional event overview ownership data (`Most picked`, role/booster assignment counts),
- optional opening matchups for cannibalization/risk handling.

LLM scoring is disabled in normal workflow. This is a math-first pipeline.

## 1) Prerequisites

- [Bun](https://bun.sh/) installed.
- Dependencies installed:

```bash
bun install
```

## 2) Environment Variables

Create a `.env` file from `.env.example`:

```bash
cp .env.example .env
```

Current variables:
- `GEMINI_API_KEY` (required by env validation in current codebase, even if LLM is not used)
- `BLACKLISTED_PLAYERS` (optional comma-separated list, e.g. `player1,player2`)
- `SCORING_DIAGNOSTICS` (`true` or `false`; enables scoring share debug output)

## 3) Required and Optional Input Files

You manually fetch HTML snapshots per event. The app does the rest.

### Required (minimum)

1. Save fantasy draft/team selection page HTML to:
   - `source/<event-slug>.html`

This file contains:
- player names,
- prices,
- card-level stats,
- team names/ranks.

### Optional but recommended (for field-aware play)

2. Save event overview page HTML to:
   - `source-event-overview/<event-slug>.html`

Used for:
- most-picked player counts (ownership proxy),
- role assignment popularity,
- booster assignment popularity.

3. Save event/opening matches page HTML to:
   - `source-matches/<event-slug>.html`

Used for:
- direct matchup/cannibalization risk,
- bounded team outcome context.

### Very important naming rule

Use the same file name (same event slug) in all folders:
- `source/epl-stage-2-2026.html`
- `source-event-overview/epl-stage-2-2026.html`
- `source-matches/epl-stage-2-2026.html`

If optional files are missing, app still runs with graceful fallback.

## 4) Historical Stats Files

The optimizer enriches players from local files in `stats/`:
- `last_3_months_top_20.html`
- `last_6_months_top_30.html`
- `last_12_months_top_50.html`

If these are missing, enrichment degrades but execution continues.

## 5) Run the App

Run the interactive CLI:

```bash
bun run src/cli/index.ts
```

The CLI will:
1. ask you to choose a file from `source/`,
2. ask strategy constraints,
3. auto-load matching optional bundle files from:
   - `source-event-overview/`
   - `source-matches/`
4. produce ranked lineups.

## 6) What the Optimizer Does

Current optimizer flow:

1. **Base skill EV**
   - player rating + historical rating blend + small stat modifiers.

2. **Role EV**
   - expected role points with downside risk,
   - skill-gated so weak individual players cannot over-benefit from team context.

3. **Booster EV**
   - expected booster value from player profile,
   - lightly nudged by overview booster popularity priors.

4. **Team/matchup context**
   - opening-match opponent pairs add cannibalization penalty,
   - team outcome is bounded and used as contextual signal, not dominant driver.

5. **Field leverage**
   - most-picked counts transformed into ownership proxy,
   - player and lineup ownership leverage terms,
   - ownership target band control to avoid extreme over-fading.

6. **Diversity controls**
   - rank #1 remains top EV,
   - rank #2..#20 constrained for lower overlap with anchor lineup.

## 7) Output You Will See

- **Top 20 lineup rankings** with price and score.
- **Top 20 players by base rating score**.
- If `SCORING_DIAGNOSTICS=true`:
  - component-share diagnostics (base/role/team/leverage/risk contributions).

## 8) Regression and Backtest Utilities

### Regression snapshot check

Validate deterministic output for saved events:

```bash
bun run scripts/regression-check.ts
```

Update snapshots:

```bash
bun run scripts/regression-check.ts --update
```

Single event:

```bash
bun run scripts/regression-check.ts --update --event=epl-stage-2-2026.html
```

### Walk-forward backtest scaffold

Backtest/tune weight profiles against your historical labels:

```bash
bun run scripts/backtest-walk-forward.ts
```

Quick mode:

```bash
bun run scripts/backtest-walk-forward.ts --quick
```

Data files:
- template: `fixtures/backtest/events.sample.json`
- active dataset: `fixtures/backtest/events.json`
- output report: `fixtures/backtest/walk-forward-report.json`

## 9) Practical Workflow Per Event

1. Save draft HTML to `source/<slug>.html`.
2. Save overview HTML to `source-event-overview/<slug>.html`.
3. Save matches HTML to `source-matches/<slug>.html`.
4. (Optional) refresh `stats/*.html`.
5. Run `bun run src/cli/index.ts`.
6. Review top lineup and alternatives.
7. If model behavior drifts, enable diagnostics and run regression/backtest scripts.

## 10) Troubleshooting

- **No source files shown in prompt**
  - ensure `source/*.html` exists.
- **Bundle not loaded**
  - check same exact `<slug>.html` exists in optional folders.
- **Unexpected rankings**
  - set `SCORING_DIAGNOSTICS=true` and inspect component shares.
- **Determinism check fails**
  - inspect changed source/stats HTML or update snapshot intentionally.
