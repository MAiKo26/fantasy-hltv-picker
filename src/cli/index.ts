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
} from "./output.ts";
import {
  promptForSourceFile,
  promptForStrategy,
  promptForMinG2Players,
  promptForDisableLLMEvaluation,
} from "./prompts.ts";
import {HtmlExtractorService} from "../services/extractor.ts";
import {FantasyAnalyzerService} from "../services/analyzer.ts";
import type {FantasyConfig, AnalysisResult} from "../types/player.ts";

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
  const disableLLMEvaluation = await promptForDisableLLMEvaluation();

  const config: FantasyConfig = {
    strategy,
    minG2Players: minG2Players ?? "Auto",
    disableLLMEvaluation,
  };

  console.log("\n📋 Configuration selected:");
  console.log(`   Strategy: ${config.strategy}`);
  console.log(`   Min G2 Players: ${config.minG2Players}`);
  console.log(`   LLM Evaluation: ${config.disableLLMEvaluation ? "Disabled" : "Enabled"}`);

  // ── Analysis: progress bars are rendered inside analyzer/llmSelector ───────
  const analyzer = new FantasyAnalyzerService();

  let analysisResult: AnalysisResult;
  try {
    analysisResult = await analyzer.analyze(
      result.players,
      result.teams,
      config,
      sourceFile,
    );

    printReasoningBox(analysisResult.reasoning);
    printFinalTeamBox(analysisResult);
    printAllLineupsRanking(analysisResult.allScoredLineups);
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
