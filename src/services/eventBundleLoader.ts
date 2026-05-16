import * as fs from "node:fs";
import * as path from "node:path";
import type {EventBundleContext} from "../types/player.ts";
import {parseEventSlugFromFileName} from "../utils/normalize.ts";
import {matchesExtractor} from "./matchesExtractor.ts";

interface BundleLoadResult {
  bundle?: EventBundleContext;
  warnings: string[];
}

function getExistingFilePath(directory: string, fileName: string): string | null {
  const filePath = path.join(process.cwd(), directory, fileName);
  return fs.existsSync(filePath) ? filePath : null;
}

export async function loadEventBundleForSource(
  sourceFile: string,
): Promise<BundleLoadResult> {
  const eventSlug = parseEventSlugFromFileName(sourceFile);
  const targetFile = `${eventSlug}.html`;
  const warnings: string[] = [];

  let matches = undefined;

  const matchesPath = getExistingFilePath(path.join("source", "matches"), targetFile);

  if (matchesPath) {
    try {
      matches = await matchesExtractor.extract(targetFile);
      warnings.push(...matches.parseWarnings.map((w) => `[matches] ${w}`));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`[matches] Failed to parse file: ${message}`);
    }
  } else {
    warnings.push(`Missing optional matches file: source/matches/${targetFile}`);
  }

  if (!matches) {
    return {warnings};
  }

  return {
    bundle: {
      eventSlug,
      matches,
    },
    warnings,
  };
}
