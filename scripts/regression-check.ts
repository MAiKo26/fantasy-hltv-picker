import * as fs from "node:fs";
import * as path from "node:path";
import {HtmlExtractorService} from "../src/services/extractor.ts";
import {StatsScraperService} from "../src/services/statsScraper.ts";
import {mathOptimizer} from "../src/services/mathOptimizer.ts";
import {loadEventBundleForSource} from "../src/services/eventBundleLoader.ts";
import type {FantasyConfig, FantasyPlayer, FantasyTeam} from "../src/types/player.ts";

const SNAPSHOT_DIR = path.join(process.cwd(), "fixtures", "regression");
const SOURCE_DIR = path.join(process.cwd(), "source");

function ensureSnapshotDir() {
  if (!fs.existsSync(SNAPSHOT_DIR)) {
    fs.mkdirSync(SNAPSHOT_DIR, {recursive: true});
  }
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function listSourceFiles(): string[] {
  if (!fs.existsSync(SOURCE_DIR)) return [];
  return fs
    .readdirSync(SOURCE_DIR)
    .filter((file) => file.endsWith(".html"))
    .sort((a, b) => a.localeCompare(b));
}

function getSnapshotPath(sourceFile: string): string {
  const slug = sourceFile.replace(/\.html$/i, "");
  return path.join(SNAPSHOT_DIR, `${slug}.snapshot.json`);
}

async function getEventInput(
  sourceFile: string,
): Promise<{players: FantasyPlayer[]; teams: FantasyTeam[]; bundle?: Awaited<ReturnType<typeof loadEventBundleForSource>>["bundle"]}> {
  const extractor = new HtmlExtractorService();
  const stats = new StatsScraperService();
  const extraction = await extractor.extract(sourceFile);
  const {bundle} = await loadEventBundleForSource(sourceFile);
  const enrichedPlayers = await stats.enrichPlayersWithHistoricalStats(extraction.players);
  return {
    players: enrichedPlayers,
    teams: extraction.teams,
    bundle,
  };
}

async function buildCurrentSnapshot(sourceFile: string) {
  const {players, teams, bundle} = await getEventInput(sourceFile);

  const config: FantasyConfig = {
    strategy: "Auto",
    minG2Players: "Auto",
    disableLLMEvaluation: true,
  };

  const topLineups = mathOptimizer.optimize(players, teams, config, bundle);

  return {
    eventSlug: sourceFile.replace(".html", ""),
    generatedAt: new Date().toISOString(),
    inputCounts: {
      players: players.length,
      teams: teams.length,
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

function loadExistingSnapshot(snapshotPath: string) {
  if (!fs.existsSync(snapshotPath)) return null;
  return JSON.parse(fs.readFileSync(snapshotPath, "utf-8"));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function main() {
  const shouldUpdate = process.argv.includes("--update");
  const onlyEventArg = process.argv.find((arg) => arg.startsWith("--event="));
  const onlyEvent = onlyEventArg?.split("=")[1];
  ensureSnapshotDir();

  const sourceFiles = listSourceFiles().filter((file) =>
    onlyEvent ? file === onlyEvent : true,
  );
  if (sourceFiles.length === 0) {
    console.error("No source HTML files found for regression check.");
    process.exit(1);
  }

  let hasFailure = false;
  for (const sourceFile of sourceFiles) {
    const snapshotPath = getSnapshotPath(sourceFile);
    const current = await buildCurrentSnapshot(sourceFile);
    const existing = loadExistingSnapshot(snapshotPath);

    if (shouldUpdate || !existing) {
      fs.writeFileSync(snapshotPath, stableStringify(current), "utf-8");
      console.log(`Snapshot written: ${snapshotPath}`);
      continue;
    }

    const currentForCompare = {...current, generatedAt: "__IGNORED__"};
    const existingForCompare = {...existing, generatedAt: "__IGNORED__"};

    if (stableStringify(currentForCompare) !== stableStringify(existingForCompare)) {
      hasFailure = true;
      console.error(`Regression snapshot mismatch detected for ${sourceFile}.`);
    }
  }

  if (hasFailure) {
    console.error("Run with --update if the new output is expected.");
    process.exit(1);
  }

  console.log("Regression snapshot check passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
