import * as fs from "node:fs";
import * as path from "node:path";
import {HtmlExtractorService} from "../src/services/extractor.ts";
import {StatsScraperService} from "../src/services/statsScraper.ts";
import {mathOptimizer} from "../src/services/mathOptimizer.ts";
import {loadEventBundleForSource} from "../src/services/eventBundleLoader.ts";
import type {FantasyConfig} from "../src/types/player.ts";

const SNAPSHOT_DIR = path.join(process.cwd(), "fixtures", "regression");
const SNAPSHOT_PATH = path.join(SNAPSHOT_DIR, "epl-stage-2-2026.snapshot.json");
const SOURCE_FILE = "epl-stage-2-2026.html";

function ensureSnapshotDir() {
  if (!fs.existsSync(SNAPSHOT_DIR)) {
    fs.mkdirSync(SNAPSHOT_DIR, {recursive: true});
  }
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

async function buildCurrentSnapshot() {
  const extractor = new HtmlExtractorService();
  const stats = new StatsScraperService();
  const extraction = await extractor.extract(SOURCE_FILE);
  const {bundle} = await loadEventBundleForSource(SOURCE_FILE);
  const enrichedPlayers = await stats.enrichPlayersWithHistoricalStats(extraction.players);

  const config: FantasyConfig = {
    strategy: "Auto",
    minG2Players: "Auto",
    disableLLMEvaluation: true,
  };

  const topLineups = mathOptimizer.optimize(
    enrichedPlayers,
    extraction.teams,
    config,
    bundle,
  );

  return {
    eventSlug: SOURCE_FILE.replace(".html", ""),
    generatedAt: new Date().toISOString(),
    inputCounts: {
      players: extraction.players.length,
      teams: extraction.teams.length,
      overviewMostPicked: bundle?.overview?.mostPickedPlayers.length ?? 0,
      roleAssignments: bundle?.overview?.roleAssignments.length ?? 0,
      boosterAssignments: bundle?.overview?.boosterAssignments.length ?? 0,
      parsedMatches: bundle?.matches?.matches.length ?? 0,
      knownPairings:
        bundle?.matches?.matches.filter((match) => match.pairingKnown).length ?? 0,
    },
    topLineups: topLineups.slice(0, 10).map((lineup, rank) => ({
      rank: rank + 1,
      strategy: lineup.strategyUsed,
      totalPrice: lineup.totalPrice,
      expectedScore: round(lineup.expectedBaseScore),
      players: lineup.players.map((player) => player.name),
      teams: lineup.players.map((player) => player.team),
    })),
  };
}

function loadExistingSnapshot() {
  if (!fs.existsSync(SNAPSHOT_PATH)) return null;
  return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf-8"));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function main() {
  const shouldUpdate = process.argv.includes("--update");
  ensureSnapshotDir();

  const current = await buildCurrentSnapshot();
  const existing = loadExistingSnapshot();

  if (shouldUpdate || !existing) {
    fs.writeFileSync(SNAPSHOT_PATH, stableStringify(current), "utf-8");
    console.log(`Snapshot written: ${SNAPSHOT_PATH}`);
    return;
  }

  const currentForCompare = {...current, generatedAt: "__IGNORED__"};
  const existingForCompare = {...existing, generatedAt: "__IGNORED__"};

  if (stableStringify(currentForCompare) !== stableStringify(existingForCompare)) {
    console.error("Regression snapshot mismatch detected.");
    console.error(`Run with --update if the new output is expected.`);
    process.exit(1);
  }

  console.log("Regression snapshot check passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
