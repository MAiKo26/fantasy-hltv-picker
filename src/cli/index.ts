import { printWelcome, createSpinner, printSuccess, printError, printExtractionSummary, printGoodbye } from "./output.ts";
import { promptForSourceFile, promptForStrategy, promptForMinG2Players } from "./prompts.ts";
import { HtmlExtractorService } from "../services/extractor.ts";
import type { FantasyConfig } from "../types/player.ts";

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
    printError(`Extraction failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    printGoodbye();
    return;
  }

  const strategy = await promptForStrategy();
  const minG2Players = await promptForMinG2Players(result.teams);

  const config: FantasyConfig = {
    strategy,
    minG2Players: minG2Players ?? "Auto",
  };

  console.log("\n📋 Configuration selected:");
  console.log(`   Strategy: ${config.strategy}`);
  console.log(`   Min G2 Players: ${config.minG2Players}`);

  // TODO: Pass config to analyzer

  printGoodbye();
}

main();
