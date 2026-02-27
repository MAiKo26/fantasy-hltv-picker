/**
 * show-stats.ts — Debug script that shows exactly what StatsScraper does
 * when it parses each HTML file.
 *
 * Usage:  npx tsx scripts/show-stats.ts
 */

import {StatsScraperService} from "../src/services/statsScraper.ts";

const FILES = [
  {
    filename: "last_3_months_top_20.html",
    cacheKey: "debug_3m",
    label: "3-Month Top 20",
  },
  {
    filename: "last_6_months_top_30.html",
    cacheKey: "debug_6m",
    label: "6-Month Top 30",
  },
  {
    filename: "last_12_months_top_50.html",
    cacheKey: "debug_12m",
    label: "12-Month Top 50",
  },
] as const;

const scraper = new StatsScraperService();

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║            statsScraper.ts — Debug Run                  ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  for (const {filename, cacheKey, label} of FILES) {
    console.log(`━━━━ ${label} (${filename}) ━━━━\n`);

    const {stats, debugInfo} = await scraper.debugParse(filename, cacheKey);

    if (!debugInfo) {
      console.log("  [no debug info returned — file may not exist]\n");
      continue;
    }

    // ── Selector summary ──────────────────────────────────────────────
    console.log(
      "  SELECTOR:   table.stats-table.player-ratings-table tbody tr",
    );
    console.log(`  ROWS FOUND: ${debugInfo.totalRowsFound}`);
    console.log(`  PARSED OK:  ${debugInfo.validRowsParsed}`);
    console.log(
      `  SKIPPED:    ${debugInfo.skippedRows} (empty name or NaN rating)\n`,
    );

    // ── First 5 raw rows for inspection ───────────────────────────────
    console.log("  SAMPLE RAW ROWS (first 5):");
    for (const r of debugInfo.sampleRows) {
      const status = r.parsed ? "✅" : "❌";
      console.log(
        `    ${status}  name="${r.rawName}"  rating="${r.rawRating}"` +
          `  maps="${r.rawMaps}"  kd="${r.rawKd}"`,
      );
    }
    console.log();

    // ── Parsed output ──────────────────────────────────────────────────
    if (stats.length === 0) {
      console.log(
        "  ⚠️  NO PLAYERS PARSED — check selector or HTML structure\n",
      );
    } else {
      console.log(
        `  ALL ${stats.length} PARSED PLAYERS (rank → name: rating):`,
      );
      stats.forEach((s, i) => {
        const maps = s.maps !== undefined ? `  maps=${s.maps}` : "";
        const kd = s.kd !== undefined ? `  k/d=${s.kd}` : "";
        const rank = String(i + 1).padStart(3);
        console.log(
          `    ${rank}. ${s.name.padEnd(20)} rating=${s.rating}${maps}${kd}`,
        );
      });
      console.log();
    }
  }
}

main().catch(console.error);
