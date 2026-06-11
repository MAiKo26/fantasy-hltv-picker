import {
  printWelcome,
  createSpinner,
  printSuccess,
  printError,
  printExtractionSummary,
  printRandomLineupPick,
  printGoodbye,
  printAllLineupsRanking,
  printTopRatedPlayers,
} from "./output.ts";
import {
  promptForSourceFile,
  promptForStrategy,
  promptForForcedTeam,
  promptForExcludedTeams,
} from "./prompts.ts";
import {mathOptimizer} from "../services/mathOptimizer.ts";
import {HtmlExtractorService} from "../services/extractor.ts";
import {FantasyAnalyzerService} from "../services/analyzer.ts";
import type {FantasyConfig, AnalysisResult} from "../types/player.ts";

export async function main(): Promise<void> {
  printWelcome();

  const teamsArg = process.argv.find((arg) => arg.startsWith("--teams="));
  const teamDisplayLimit =
    teamsArg != null ? parseInt(teamsArg.split("=")[1] ?? "", 10) || 50 : 50;

  let sourceFile: string;
  try {
    sourceFile = await promptForSourceFile();
  } catch {
    printError("Failed to get input. Exiting.");
    return;
  }

  const spinner = createSpinner("Extracting player data from HTML...");
  const extractor = new HtmlExtractorService();

  let result;
  try {
    result = await extractor.extract(sourceFile);
    spinner.succeed();
    printSuccess("Extraction complete!");
    printExtractionSummary(result, teamDisplayLimit);
  } catch (error) {
    spinner.fail();
    printError(
      `Extraction failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    printGoodbye();
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

  const config: FantasyConfig = {
    strategy,
    forcedTeam: forcedTeam ?? null,
    excludedTeams,
    lineupLimit: teamDisplayLimit > 0 ? teamDisplayLimit : undefined,
  };

  console.log("\n📋 Configuration selected:");
  console.log(`   Strategy: ${config.strategy}`);
  if (config.forcedTeam) {
    console.log(`   Forced team: ${config.forcedTeam.name} (min ${config.forcedTeam.minPlayers === "Auto" ? "auto" : config.forcedTeam.minPlayers})`);
  }
  if (config.excludedTeams && config.excludedTeams.length > 0) {
    console.log(`   Excluded teams: ${config.excludedTeams.join(", ")}`);
  }

  const detailed =
    process.argv.includes("--detailed") || process.argv.includes("-d");

  const analyzer = new FantasyAnalyzerService();

  let analysisResult: AnalysisResult;
  try {
    analysisResult = await analyzer.analyze(
      result.players,
      result.teams,
      config,
      sourceFile,
    );

    printTopRatedPlayers(mathOptimizer.getLatestDiagnostics().topPlayers, detailed);

    const limitedLineups = analysisResult.allScoredLineups
      .slice(0, teamDisplayLimit > 0 ? teamDisplayLimit : undefined);
    printRandomLineupPick(limitedLineups);
    printAllLineupsRanking(limitedLineups);
  } catch (error) {
    printError(
      `Analysis failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    printGoodbye();
    return;
  }

  printGoodbye();
}

main();
