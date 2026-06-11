# Fantasy HLTV Picker

You save an HLTV fantasy draft page as HTML. This tool extracts player cards, enriches them with historical stats, and brute-forces the optimal $1M lineup.

---

## Quick Start

### Prerequisites

You need either [**Bun**](https://bun.sh/) or [**Node.js 22+**](https://nodejs.org/) with [**pnpm**](https://pnpm.io/) / npm.

### Install & Run

```bash
# Clone the repo
git clone Github.com/maiko26/fantasy-hltv-picker
cd fantasy-hltv-picker

# Install dependencies
bun install       # if using Bun
# or: pnpm install

# Copy env file (edit if needed)
cp .env.example .env

# Run
bun index.ts      # if using Bun
# or: node index.ts
```

That's it. The CLI will tell you what to do next.

---

## Step-by-Step: Your First Event

### 1. Save the Fantasy Draft Page

Go to any HLTV fantasy event page (e.g. `https://www.hltv.org/fantasy/<id>/league/<leagueId>`).

**Right-click → Save As →** save the whole page as HTML into:

```
source/draft/<event-slug>.html
```

> **What is a slug?** A short, unique name for the event, like `epl-stage-2-2026` or `blast-rotterdam-playoffs`. Use the same slug across all files.

### 2. (Optional) Add Historical Stats

Download the [HLTV Top 20 Players (Last 12 Months)](https://www.hltv.org/stats) page and save it as:

```
source/last_12_months_top_20.html
```

If missing, the optimizer uses only the in-game card ratings.

### 3. Run the App

```bash
bun index.ts
```

The CLI will:

1. Show a list of files from `source/draft/` → pick one
2. Ask your team strategy (Auto / 2-2-1 / 2-1-1-1 / 1-1-1-1-1)
3. Ask if you want to force a specific team into your lineup
4. Output the top ranked lineups

---

## File Structure

```
source/
  draft/                       ← Your fantasy draft HTML files (required)
  last_12_months_top_20.html   ← HLTV stats page (optional, enrichment)
```

---

## Environment Variables (`.env`)

| Variable              | Required | Description                                            |
| --------------------- | -------- | ------------------------------------------------------ |
| `BLACKLISTED_PLAYERS` | No       | Comma-separated player names to exclude                |
| `SCORING_DIAGNOSTICS` | No       | Set to `true` for component-share debug output         |
| `WEIGHT_*`            | No       | 8 optimizer coefficients (see below)                   |
| `THRESHOLD_*`         | No       | 2 trigger thresholds for the gated benefits            |

---

## Scoring Weights Explained

The optimizer computes a score for every possible 5-player lineup, then ranks them. The score is a sum of components, each multiplied by its weight.

**Naming convention:** every weight ends in `Benefit` (adds to the score) or `Penalty` (subtracts from the score). Trigger-based benefits (`awp`, `survival`) are gated by `THRESHOLD_*` values.

### Player-Level Weights

#### 1. `WEIGHT_CARD_RATING_BENEFIT` (default `0.25`)

Adds the player's current in-game card rating × this weight. This is the primary signal — the most recent form on the actual card.

#### 2. `WEIGHT_HISTORICAL_TOP20_RATING_BENEFIT` (default `3`)

Adds the player's HLTV Top-20 12-month rating × this weight. Captures proven form over the last year, weighted heavily because the rating is itself a high-quality statistic.

#### 3. `WEIGHT_TOP_TEAM_RANK_BENEFIT` (default `0.5`)

Adds a log-scaled bonus for being on a top-ranked team. `log(1 + relativeRank)` × this weight, where `relativeRank` ∈ [0, 1] (1 = #1 team).

#### 4. `WEIGHT_AWPER_ROLE_BENEFIT` (default `0`) + `THRESHOLD_AWPER_ROLE_MIN_AWP_PER_ROUND` (default `0.25`)

Adds a flat bonus when the player's AWP kills per round is at or above the threshold. Default is 0 (no effect) — increase to favor dedicated AWPers.

#### 5. `WEIGHT_LOW_DEATH_RATE_BENEFIT` (default `0`) + `THRESHOLD_LOW_DEATH_RATE_MAX_DEATHS_PER_ROUND` (default `0.6`)

Adds a flat bonus when the player's deaths per round is at or below the threshold. Default is 0 (no effect) — increase to favor players who stay alive.

#### 6. `WEIGHT_CT_VS_T_RATING_IMBALANCE_PENALTY` (default `0.5`)

Subtracts `|ctRating − tRating|` × this weight. Penalizes one-sided players whose bad side might come up in the map pool.

### Lineup-Level Weights

#### 7. `WEIGHT_STACK_CORRELATION_BENEFIT` (default `0.5`)

When 2 players from the same team are in a lineup ("stacking"), rewards the lineup proportional to the average base score of the stacked players × `(count - 1)` × this weight. Same-team players get the same matchup result.

#### 8. `WEIGHT_TOP_RANKED_TEAM_STACK_BENEFIT` (default `0.25`)

Only applies in a **2-2-1** strategy. When both 2-player stacks come from top-ranked teams, adds the average relative-rank bonus × this weight. Extra reward for the proven high-upside "double-stack" structure.

---

## Summary: How the Score Is Calculated

```
Player base score = cardRating × cardRatingBenefit
                  + rating12mTop20 × historicalTop20RatingBenefit
                  + log(1 + relativeRank) × topTeamRankBenefit
                  + (awpPerRound >= threshold) ? awperRoleBenefit : 0
                  + (deathsPerRound <= threshold) ? lowDeathRateBenefit : 0
                  - |ctRating − tRating| × ctVsTRatingImbalancePenalty

Lineup score = Σ playerBaseScores
             + stackCorrelationEV      (sum over stacked teams)
             + stackRankBonus          (only if strategy is 2-2-1)
```

---

## Output

- **Top 3 lineups** with player names, prices, and scores
- **All lineups ranking** (top 30)
- **Top players by base rating** (with `--detailed` flag, a full score-component breakdown is shown)
- With `SCORING_DIAGNOSTICS=true`: component breakdown of each score

---

## Troubleshooting

| Problem             | Fix                                                             |
| ------------------- | --------------------------------------------------------------- |
| No files in prompt  | Put `.html` files in `source/draft/`                            |
| Unexpected rankings | Set `SCORING_DIAGNOSTICS=true` to see score breakdown           |
