import {
  printWelcome,
  createSpinner,
  printSuccess,
  printError,
  printExtractionSummary,
  printGoodbye,
  printReasoningBox,
  printFinalTeamBox,
  printAllLineupsRanking,
  printTopRatedPlayers,
} from "./output.ts";
import {
  promptForSourceFile,
  promptForStrategy,
  promptForMinG2Players,
} from "./prompts.ts";
import {HtmlExtractorService} from "../services/extractor.ts";
import {FantasyAnalyzerService} from "../services/analyzer.ts";
import type {FantasyConfig, AnalysisResult} from "../types/player.ts";
import {loadEventBundleForSource} from "../services/eventBundleLoader.ts";
import chalk from "chalk";

export async function main(): Promise<void> {
  printWelcome();

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
    printExtractionSummary(result);
  } catch (error) {
    spinner.fail();
    printError(
      `Extraction failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    printGoodbye();
    return;
  }

  const strategy = await promptForStrategy();
  const minG2Players = await promptForMinG2Players(result.teams);
  const disableLLMEvaluation = true;

  const config: FantasyConfig = {
    strategy,
    minG2Players: minG2Players ?? "Auto",
    disableLLMEvaluation,
  };

  console.log("\n📋 Configuration selected:");
  console.log(`   Strategy: ${config.strategy}`);
  console.log(`   Min G2 Players: ${config.minG2Players}`);
  console.log("   LLM Evaluation: Disabled (deterministic math mode)");

  const bundleSpinner = createSpinner(
    "Loading optional event overview + matches bundle...",
  );
  const {bundle, warnings: bundleWarnings} = await loadEventBundleForSource(sourceFile);
  bundleSpinner.succeed();
  if (bundle) {
    printSuccess(
      `Loaded event bundle for ${bundle.eventSlug} (overview: ${bundle.overview ? "yes" : "no"}, matches: ${bundle.matches ? "yes" : "no"})`,
    );
  } else {
    printSuccess("No additional event bundle found. Running with draft-only data.");
  }
  const actionableWarnings = bundleWarnings.filter(
    (warning) => !warning.startsWith("Missing optional"),
  );
  if (actionableWarnings.length > 0) {
    console.log(chalk.yellow("\n⚠️  Bundle parser warnings:"));
    for (const warning of actionableWarnings) {
      console.log(chalk.yellow(`   - ${warning}`));
    }
  }

  // ── Analysis: progress bars are rendered inside analyzer/llmSelector ───────
  const analyzer = new FantasyAnalyzerService();

  let analysisResult: AnalysisResult;
  try {
    analysisResult = await analyzer.analyze(
      result.players,
      result.teams,
      config,
      sourceFile,
      bundle,
    );

    printReasoningBox(analysisResult.reasoning);
    printFinalTeamBox(analysisResult);
    printAllLineupsRanking(analysisResult.allScoredLineups);
    printTopRatedPlayers(analysisResult.top20ByRating);
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
