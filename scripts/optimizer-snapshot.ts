import * as fs from "node:fs";
import * as path from "node:path";
import {HtmlExtractorService} from "../src/services/extractor.ts";
import {StatsScraperService} from "../src/services/statsScraper.ts";
import {mathOptimizer} from "../src/services/mathOptimizer.ts";

const DRAFT_DIR = path.join(process.cwd(), "source", "draft");
const SNAPSHOT_FILE = path.join(process.cwd(), ".cache", "optimizer-snapshot-cs-asia.json");

async function main() {
  const draftFile = "CS Asia Championships 2026.html";
  const draftPath = path.join(DRAFT_DIR, draftFile);
  if (!fs.existsSync(draftPath)) {
    console.error(`Draft not found: ${draftPath}`);
    process.exit(1);
  }

  console.log("Loading draft:", draftFile);
  const extractor = new HtmlExtractorService();
  const scraper = new StatsScraperService();
  const result = await extractor.extract(draftFile);
  const enriched = await scraper.enrichPlayersWithHistoricalStats(result.players);

  console.log("Running optimizer (this may take a moment)...");
  const lineups = mathOptimizer.optimize(
    enriched,
    result.teams,
    {strategy: "2-2-1"},
  );

  const snapshot = {
    generatedAt: new Date().toISOString(),
    event: draftFile,
    playerCount: enriched.length,
    teamCount: result.teams.length,
    lineupCount: lineups.length,
    topLineups: lineups.slice(0, 10).map(l => ({
      players: l.players.map(p => p.name).sort(),
      totalPrice: l.totalPrice,
      expectedBaseScore: l.expectedBaseScore,
      strategyUsed: l.strategyUsed,
      scoringBreakdown: l.scoringBreakdown,
    })),
  };

  fs.mkdirSync(path.dirname(SNAPSHOT_FILE), {recursive: true});
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
  console.log(`\nSnapshot saved to: ${SNAPSHOT_FILE}`);
  console.log(`Players: ${snapshot.playerCount}, Teams: ${snapshot.teamCount}, Lineups: ${snapshot.lineupCount}`);
  console.log("\nTop 5 lineups:");
  for (const l of snapshot.topLineups.slice(0, 5)) {
    console.log(`  [${l.expectedBaseScore.toFixed(2)}] ${l.players.join(" | ")}`);
  }
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
