import {
  printWelcome,
  createSpinner,
  printSuccess,
  printError,
  printExtractionSummary,
  printRecommendedLineup,
  printPortfolio,
  printGoodbye,
  printAllLineupsRanking,
  printTopRatedPlayers,
} from "./output.ts";
import {
  promptForMainAction,
  promptForOptimizeOptions,
  promptForSourceFile,
  promptForStrategy,
  promptForForcedTeam,
  promptForExcludedTeams,
  promptForFieldSplit,
} from "./prompts.ts";
import {mathOptimizer} from "../services/mathOptimizer.ts";
import {HtmlExtractorService} from "../services/extractor.ts";
import {FantasyAnalyzerService} from "../services/analyzer.ts";
import {refreshHistoricalSources} from "../services/sourceRefresher.ts";
import {isFirstTimeDraft, markDraftUsed} from "../services/draftRegistry.ts";
import type {FantasyConfig, AnalysisResult} from "../types/player.ts";
import {summarizeFieldSplit} from "./fieldSplitEditor.ts";

async function runRefresh(): Promise<boolean> {
  try {
    await refreshHistoricalSources();
    printSuccess("Historical stats are up to date.");
    return true;
  } catch (error) {
    printError(
      error instanceof Error ? error.message : "Unknown refresh error",
    );
    return false;
  }
}

async function runOptimize(): Promise<void> {
  let sourceFile: string;
  try {
    sourceFile = await promptForSourceFile();
  } catch {
    printError("Failed to get input. Exiting.");
    return;
  }

  if (isFirstTimeDraft(sourceFile)) {
    console.log(
      `\nNew draft detected: ${sourceFile}\nRefreshing HLTV stats before optimization...`,
    );
    const refreshed = await runRefresh();
    if (refreshed) {
      markDraftUsed(sourceFile);
    } else {
      printError(
        "Stats refresh failed. Continuing with existing source files if available.",
      );
    }
  }

  const {lineupDisplayLimit, detailedOutput, mode} =
    await promptForOptimizeOptions();

  const spinner = createSpinner("Extracting player data from HTML...");
  const extractor = new HtmlExtractorService();

  let result;
  try {
    result = await extractor.extract(sourceFile);
    spinner.succeed();
    printSuccess("Extraction complete!");
    printExtractionSummary(result, lineupDisplayLimit);
  } catch (error) {
    spinner.fail();
    printError(
      `Extraction failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    return;
  }

  const strategy = await promptForStrategy();
  const forcedTeam = await promptForForcedTeam(result.teams);
  const rawExcludedTeams = await promptForExcludedTeams(result.teams);
  const forcedTeamName = forcedTeam?.name ?? null;
  const excludedTeams =
    forcedTeamName != null
      ? rawExcludedTeams.filter((name) => name !== forcedTeamName)
      : rawExcludedTeams;

  const fieldSplit = await promptForFieldSplit(result.teams, sourceFile);

  const config: FantasyConfig = {
    strategy,
    forcedTeam: forcedTeam ?? null,
    excludedTeams,
    lineupLimit: lineupDisplayLimit > 0 ? lineupDisplayLimit : undefined,
    fieldSplit,
    mode,
  };

  console.log("\n📋 Configuration selected:");
  console.log(`   Strategy: ${config.strategy}`);
  console.log(`   Mode: ${mode}`);
  console.log(`   Lineups shown: ${lineupDisplayLimit}`);
  console.log(`   Detailed output: ${detailedOutput ? "yes" : "no"}`);
  if (config.forcedTeam) {
    console.log(`   Forced team: ${config.forcedTeam.name} (min ${config.forcedTeam.minPlayers === "Auto" ? "auto" : config.forcedTeam.minPlayers})`);
  }
  if (config.excludedTeams && config.excludedTeams.length > 0) {
    console.log(`   Excluded teams: ${config.excludedTeams.join(", ")}`);
  }
  if (config.fieldSplit && config.fieldSplit.sideCount > 1) {
    console.log(
      `   Field split: ${config.fieldSplit.sideCount} sides (${summarizeFieldSplit(config.fieldSplit, result.teams.map((team) => team.name))})`,
    );
  } else {
    console.log("   Field split: disabled");
  }

  const analyzer = new FantasyAnalyzerService();

  let analysisResult: AnalysisResult;
  try {
    analysisResult = await analyzer.analyze(
      result.players,
      result.teams,
      config,
      sourceFile,
    );

    printTopRatedPlayers(
      mathOptimizer.getLatestDiagnostics().topPlayers,
      detailedOutput,
    );

    const limitedLineups = analysisResult.allScoredLineups
      .slice(0, lineupDisplayLimit > 0 ? lineupDisplayLimit : undefined);

    const portfolioEntry = analysisResult.portfolio[0] ??
      analysisResult.allScoredLineups[0];
    if (portfolioEntry) {
      printRecommendedLineup(
        portfolioEntry,
        analysisResult.mode,
        analysisResult.recommendation,
      );
    }
    printPortfolio(analysisResult.portfolio);
    printAllLineupsRanking(limitedLineups);
  } catch (error) {
    printError(
      `Analysis failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

export async function main(): Promise<void> {
  printWelcome();

  while (true) {
    let action;
    try {
      action = await promptForMainAction();
    } catch {
      printError("Failed to get input. Exiting.");
      break;
    }

    if (action === "exit") {
      break;
    }
    if (action === "refresh") {
      await runRefresh();
      continue;
    }
    await runOptimize();
  }

  printGoodbye();
}

main();
