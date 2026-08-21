import fs from "node:fs";
import path from "node:path";
import type {FieldSplitConfig} from "../types/fieldSplit.ts";
import {normalizeTeamName} from "../utils/normalize.ts";
import {parseEventSlugFromFileName} from "../utils/normalize.ts";

const CACHE_DIR = path.join(process.cwd(), ".cache", "field-splits");

function configPathForSlug(slug: string): string {
  return path.join(CACHE_DIR, `${slug}.json`);
}

export function draftSlugFromSourceFile(sourceFile: string): string {
  return parseEventSlugFromFileName(path.basename(sourceFile));
}

export function loadFieldSplit(slug: string): FieldSplitConfig | null {
  const filePath = configPathForSlug(slug);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as FieldSplitConfig;
    if (
      typeof parsed.sideCount !== "number" ||
      typeof parsed.teamSides !== "object" ||
      parsed.teamSides == null
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveFieldSplit(config: FieldSplitConfig): void {
  fs.mkdirSync(CACHE_DIR, {recursive: true});
  fs.writeFileSync(
    configPathForSlug(config.draftSlug),
    JSON.stringify(config, null, 2),
    "utf-8",
  );
}

export function mergeTeamsIntoFieldSplit(
  config: FieldSplitConfig,
  teamNames: string[],
): FieldSplitConfig {
  const mergedSides: Record<string, number> = {...config.teamSides};
  const sideCounts = Array.from({length: config.sideCount}, () => 0);

  for (const teamName of teamNames) {
    const key = normalizeTeamName(teamName);
    const side = mergedSides[key];
    if (side != null && side >= 0 && side < config.sideCount) {
      sideCounts[side] = (sideCounts[side] ?? 0) + 1;
    }
  }

  for (const teamName of teamNames) {
    const key = normalizeTeamName(teamName);
    if (mergedSides[key] != null) continue;

    let targetSide = 0;
    let minCount = sideCounts[0] ?? 0;
    for (let side = 1; side < config.sideCount; side++) {
      const count = sideCounts[side] ?? 0;
      if (count < minCount) {
        minCount = count;
        targetSide = side;
      }
    }

    mergedSides[key] = targetSide;
    sideCounts[targetSide] = (sideCounts[targetSide] ?? 0) + 1;
  }

  return {
    ...config,
    teamSides: mergedSides,
  };
}

export function buildInitialTeamSides(
  teamNames: string[],
  sideCount: number,
): Record<string, number> {
  const teamSides: Record<string, number> = {};
  teamNames.forEach((teamName, index) => {
    teamSides[normalizeTeamName(teamName)] = index % sideCount;
  });
  return teamSides;
}
