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

### 2. (Optional) Save Match Listings for Better Results

The optimizer can penalize players whose teams face each other (cannibalization). Save the event's match listing page:

| File                          | What it adds                                         |
| ----------------------------- | ---------------------------------------------------- |
| `source/matches/<slug>.html`  | Opening matchups → penalty if your players face each other |

If this file is missing, the app still runs — it just skips the matchup penalty.

**Where to get it:** Go to the event's match listing page → Save As

### 3. (Optional) Add Historical Stats

Download the [HLTV Top 50 Players (Last 12 Months)](https://www.hltv.org/stats) page and save it as:

```
source/last_12_months_top_50.html
```

If missing, the optimizer uses only the in-game card ratings.

### 4. Run the App

```bash
bun index.ts
```

The CLI will:

1. Show a list of files from `source/draft/` → pick one
2. Ask your team strategy (Auto / 2-2-1 / 2-1-1-1 / 1-1-1-1-1)
3. Ask if you want to force a specific team into your lineup
4. Auto-load matching `source/matches/<slug>.html` if it exists
5. Output the top ranked lineups

---

## File Structure

```
source/
  draft/                       ← Your fantasy draft HTML files (required)
  matches/                     ← Match listing HTML (optional, matchup risk)
  last_12_months_top_50.html   ← HLTV stats page (optional, enrichment)
```

---

## Environment Variables (`.env`)

| Variable              | Required | Description                                            |
| --------------------- | -------- | ------------------------------------------------------ |
| `BLACKLISTED_PLAYERS` | No       | Comma-separated player names to exclude                |
| `SCORING_DIAGNOSTICS` | No       | Set to `true` for component-share debug output         |
| `WEIGHT_*`            | No       | 9 optimizer coefficients (see below)                   |

---

## Scoring Weights Explained

The optimizer computes a score for every possible 5-player lineup, then ranks them. The score is a sum of components, each multiplied by its weight. Higher weight = more impact on the final pick.

### 1. `WEIGHT_HISTORICAL_12M` (default `0.15`)

**What it does:** Adds a bonus based on the player's HLTV rating over the last 12 months.

**Why 0.15?** Historical form predicts future performance better than in-game card stats alone, but the card rating is the primary signal. 0.15 gives it a meaningful nudge without overpowering the current form shown on the card.

---

---

### 2. `WEIGHT_TEAM_RANK_BONUS` (default `0.35`)

**What it does:** Gives a bonus to players on high-ranked teams (e.g. #1 Vitality > #30 Grayhound). Better teams win more rounds → more fantasy points.

**Why 0.35?** Team quality is a strong predictor of individual output, but a slightly reduced weight prevents top-team bias from crowding out value picks from mid-tier teams with similarly skilled players at lower prices.

---

### 3. `WEIGHT_AWP_BONUS` (default `0.01`)

**What it does:** A tiny flat bonus for AWPers (players with ≥0.25 AWP kills per round). AWPers tend to have higher frag potential.

**Why 0.01?** The bonus is intentionally tiny. AWP skill is already reflected in the player's rating. This is just a slight tiebreaker, not a major factor.

---

### 4. `WEIGHT_SURVIVAL_BONUS` (default `0.02`)

**What it does:** A small bonus for players who die infrequently (≤0.6 deaths per round). Players who survive more get more opportunities to score.

**Why 0.02?** Like the AWP bonus, survival is already baked into the rating. This is a minor tiebreaker.

---

### 5. `WEIGHT_SIDE_VARIANCE_PENALTY` (default `0.1`)

**What it does:** Penalizes players who perform very differently on CT vs T side. A one-sided player is riskier — if their bad side comes up in the map pool, they underperform.

**Why 0.1?** It's a moderate penalty — enough to avoid extreme one-trick ponies, but not so harsh that it eliminates talented but slightly unbalanced players.

---

### 6. `WEIGHT_TEAM_OUTCOME` (default `0.15`)

**What it does:** Rewards players whose team is favored to win their opening match. Winning teams generate more fantasy points across the board.

**Why 0.15?** Match outcomes are a real signal, but the raw score passes through a compression function (tanh + skill gate). A higher raw weight compensates for that compression so the component actually influences lineup selection, not just the final decimals.

---

### 7. `WEIGHT_STACK_CORRELATION` (default `0.05`)

**What it does:** When you pick 2 players from the same team ("stacking"), this rewards you if that team is expected to perform well. Both players benefit from the same team outcome.

**Why 0.05?** Stacking is a proven DFS strategy with a measurable correlation benefit. This weight makes stacking a genuine factor in lineup decisions without over-weighting any single team.

---

### 8. `WEIGHT_MATCHUP_RISK_PENALTY` (default `0.2`)

**What it does:** Penalizes lineups where your players face each other (e.g. picking players from two teams that play each other in round 1). One team's win is the other's loss — you're betting against yourself.

**Why 0.2?** Cannibalization is a real risk. This is the second-largest weight because having your own players compete directly is genuinely bad for your lineup's expected value.

---

### 9. `WEIGHT_STACK_RANK_BONUS` (default `0.12`)

**What it does:** Only applies in a **2-2-1** strategy. If both of your 2-player stacks are from top-ranked teams, you get an extra bonus on top of the stack correlation.

**Why 0.12?** Stacking two strong teams is a proven high-upside strategy (popular in real DFS). This weight rewards that specific lineup structure when it makes sense.

---

## Summary: How the Score Is Calculated

```
Final Score = baseSkillEV + teamOutcomeEV + stackCorrelationEV + stackRankBonus - matchupRiskPenalty
```

Where each `*EV` is the raw component value multiplied by its weight.

---

## Output

- **Top 3 lineups** with player names, prices, and scores
- **All lineups ranking** (top 20)
- **Top players by base rating**
- With `SCORING_DIAGNOSTICS=true`: component breakdown of each score

---

## Troubleshooting

| Problem             | Fix                                                             |
| ------------------- | --------------------------------------------------------------- |
| No files in prompt  | Put `.html` files in `source/draft/`                            |
| Bundle not loaded   | Same slug must exist in `source/matches/`                       |
| Unexpected rankings | Set `SCORING_DIAGNOSTICS=true` to see score breakdown           |
