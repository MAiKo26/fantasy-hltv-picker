import { printWelcome, createSpinner, printSuccess, printError, printExtractionSummary, printGoodbye } from "./output.ts";
import { promptForSourceFile } from "./prompts.ts";
import { HtmlExtractorService } from "../services/extractor.ts";

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

  try {
    const result = await extractor.extract(sourceFile);
    spinner.succeed();
    printSuccess("Extraction complete!");
    printExtractionSummary(result);
  } catch (error) {
    spinner.fail();
    printError(`Extraction failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

  printGoodbye();
}

main();
