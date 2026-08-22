# Fantasy HLTV Picker

You save an HLTV fantasy draft page as HTML. This tool extracts player cards, enriches them with historical stats, brute-forces the optimal $1M lineup — then **Monte-Carlo simulates the contest field** and hands you a consistency-ranked submission portfolio.

---

## Quick Start

### Prerequisites

You need either [**Bun**](https://bun.sh/) or [**Node.js 22+**](https://nodejs.org/).

```bash
bun install
cp .env.example .env
bun index.ts
```

### 1. Save the Fantasy Draft Page

On any HLTV fantasy page: **Right-click → Save As → HTML** into:

```
source/draft/<event-slug>.html
```

### 2. Refresh Historical Stats (automatic on new drafts)

The app launches a real Chrome window to download HLTV stats pages (Cloudflare-safe). It fetches every source in `src/services/historical-sources.json`:

| Source | Window | Filter | Why |
|---|---|---|---|
| MVP events | 1 month | Top30 | hottest form |
| MVP events | 3 months | Top20 | current class vs strong opponents |
| LAN | 3 months | Top50 | broad recency net |
| LAN | 6 months | Top30 | mid-horizon bridge |
| LAN | 12 months | Top10–50 | proven baseline at 4 opponent strengths |

```bash
bun run refresh-stats                      # everything
bun run refresh-stats -- --only=rating3mTop20MVPEvents   # one source
```

> Adding a new source = one JSON entry in `historical-sources.json` (window, matchType, rankingFilter, minMapCount, default weight). Everything else — scraper, scoring, env overrides, refresh worker — picks it up automatically.

### 3. Run & Pick a Mode

```
bun index.ts
```

| Mode | Objective | Use when |
|---|---|---|
| **Consistency** *(default)* | maximize P(top-30% of field) + P(beat median) | you want your stated goal: reliably above the median, never bottom-half |
| Max EV | highest expected score only | cash-style / single bracket pools |
| Ceiling | chase top-10% finishes | must-win GPPs |

---

## How the Engine Works

```
Stage 1  Extract draft HTML (prices, card stats) + enrich with 8 historical rating feeds
Stage 2  Score players → brute-force all valid $1M lineups (strategy / forced-team / field-split aware)
Stage 3  Monte-Carlo the contest:
           • every player gets σ from data confidence + cross-window form volatility
           • teammates share a correlated "team shock" (√0.09 shared variance)
           • the modeled field = weight-perturbed optimal lineups (sharp drafters)
             + softmax-random builds (casuals)
           • each candidate is ranked against that field 15k times
Stage 4  Portfolio assembly: greedy selection with pairwise-overlap caps (≤3 shared
         players) and per-player exposure caps (≤60%) across up to 5 entries
```

**Shrinkage:** short-window ratings are empirical-Bayes shrunk toward your own longer-horizon rating (`prior + (raw−prior)·n/(n+k)`), so a monster 8-map month doesn't outweigh a 300-map year.

**Uncertainty:** per-player σ grows when historical coverage is thin or the 1m/3m/6m/12m ratings disagree. The simulator uses it to model boom/bust.

---

## Should I Just Pick Lineup #1?

No. That was the old engine's whole weakness — #1 by expected score ignores variance and duplication.

- **Single entry** → play the **Recommended Lineup** (consistency-optimal, i.e., max P(top-30%)).
- **Multiple entries** → submit the **Portfolio**. Entries are overlap-capped and exposure-capped, so each additional lineup is a genuinely different shot instead of near-clones.
- The `P50 / P30 / P10` columns tell you what each build is *for*: high P50 = safe floor, high P10 = tournament swing.

---

## Tuning Weights (v7)

The old v4–v6 grid searches fit weights on all events and reported loss on the same events — overfit with 18 knobs and 13 events. v7 uses **walk-forward validation**: train on events `[0..k)`, freeze, predict event `k`; plus full-pipeline coordinate descent for lineup-level weights.

```bash
bun run optimize-weights-v7
```

Outputs held-out Spearman vs defaults, final weights, and a ready-to-paste `.env` block. Any weight can still be overridden manually via env vars (see `.env.example`). Legacy v4–v6 scripts are kept for reference but excluded from typecheck.

---

## Environment Variables

See [.env.example](./.env.example) for the full annotated list: source weights (`WEIGHT_HIST_*`), player/lineup weights, shrinkage controls, thresholds, blacklist.

## Diagnostics

- `SCORING_DIAGNOSTICS=true` → per-lineup score-component shares + top-player breakdowns (σ, data-confidence).
- Detailed output flag in CLI → per-player equation with every component's value×weight.

## Troubleshooting

| Problem | Fix |
|---|---|
| No files in prompt | Put `.html` files in `source/draft/` |
| Missing source warnings | Run `bun run refresh-stats` (or save pages manually into `source/`) |
| Cloudflare loop during refresh | Complete the check in the opened Chrome window, rerun |
| Weird rankings | `SCORING_DIAGNOSTICS=true`, inspect component contributions |
