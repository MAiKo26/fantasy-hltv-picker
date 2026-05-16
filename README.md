# Fantasy HLTV Picker

You save the HLTV fantasy draft page as HTML. This tool extracts player cards, enriches them with historical stats, evaluates role/booster/ownership potential, and brute-forces the optimal $1M lineup.

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

### 2. (Optional) Save More Context for Better Results

These files make the optimizer "field-aware" — it'll know which players are popular and which teams face each other:

| File                          | What it adds                                                    |
| ----------------------------- | --------------------------------------------------------------- |
| `source/overview/<slug>.html` | Most-picked player counts, role & booster assignment popularity |
| `source/matches/<slug>.html`  | Opening matchups → cannibalization penalties                    |

Same slug in all folders. If a file is missing, the app still runs — it just has less information.

**Where to get them:**

- **Overview:** On the fantasy event page, click the "Event overview" tab → Save As
- **Matches:** Go to the event's match listing page → Save As

### 3. (Optional) Add Historical Stats

The optimizer enriches every player with their 12-month HLTV rating. Download these from HLTV stats and save as:

```
source/stats/last_12_months_top_50.html
source/stats/last_6_months_top_30.html
source/stats/last_3_months_top_20.html
```

If these are missing, the optimizer still runs — it just uses card stats only.

### 4. Run the App

```bash
bun index.ts
```

The CLI will:

1. Show a list of files from `source/draft/` → pick one
2. Ask your team strategy (Auto / 2-2-1 / 2-1-1-1 / 1-1-1-1-1)
3. Ask if you want to force a specific team into your lineup
4. Auto-load matching files from `source/overview/` and `source/matches/`
5. Output the top ranked lineups

---

## File Structure

```
source/
  draft/              ← Your fantasy draft HTML files (required)
  overview/           ← Event overview HTML (optional, ownership data)
  matches/            ← Match listing HTML (optional, matchup risk)
  stats/              ← Historical stats HTML (optional, enrichment)
```

All files use the same slug name so related files are matched automatically.

---

## Environment Variables (`.env`)

| Variable              | Required | Description                                            |
| --------------------- | -------- | ------------------------------------------------------ |
| `BLACKLISTED_PLAYERS` | No       | Comma-separated player names to exclude                |
| `SCORING_DIAGNOSTICS` | No       | Set to `true` for component-share debug output         |
| `WEIGHT_*`            | No       | 15 optimizer coefficients (see `.env.example` for all) |

---

## What the Optimizer Does

The pipeline evaluates every valid 5-player combination under budget ($1M) and team constraints (max 2 per team):

| Component          | What it models                                                     |
| ------------------ | ------------------------------------------------------------------ |
| **Base Skill**     | Player rating + historical 12m rating + team rank + stat modifiers |
| **Role EV**        | Expected role points from 12 fantasy roles, skill-gated            |
| **Booster EV**     | Expected booster value from player profile + event popularity      |
| **Field Leverage** | Ownership proxy from most-picked → fade popular chalk              |
| **Matchup Risk**   | Cannibalization penalty when players face each other               |

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
| Bundle not loaded   | Same slug must exist in `source/overview/` or `source/matches/` |
| Unexpected rankings | Set `SCORING_DIAGNOSTICS=true` to see score breakdown           |
