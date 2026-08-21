import readline from "node:readline/promises";
import {stdin as input, stdout as output} from "node:process";
import chalk from "chalk";
import type {FieldSplitConfig} from "../types/fieldSplit.ts";
import {normalizeTeamName} from "../utils/normalize.ts";
import {buildInitialTeamSides} from "../services/fieldSplitStore.ts";

interface TeamEntry {
  index: number;
  name: string;
  key: string;
  side: number;
}

function buildTeamEntries(
  teamNames: string[],
  sideCount: number,
  existingSides?: Record<string, number>,
): TeamEntry[] {
  const initialSides =
    existingSides ?? buildInitialTeamSides(teamNames, sideCount);

  return teamNames.map((name, index) => {
    const key = normalizeTeamName(name);
    const side = initialSides[key] ?? index % sideCount;
    const clampedSide =
      side >= 0 && side < sideCount ? side : index % sideCount;
    return {
      index: index + 1,
      name,
      key,
      side: clampedSide,
    };
  });
}

function renderFieldSplitEditor(
  entries: TeamEntry[],
  sideCount: number,
): string {
  const lines: string[] = [];
  lines.push(
    chalk.bold.cyan(
      `\nField split editor — ${sideCount} side${sideCount === 1 ? "" : "s"}`,
    ),
  );
  lines.push(
    chalk.gray(
      "Commands: <team#> cycle side | <team#> <side#> move | r reset | d done\n",
    ),
  );

  for (let side = 0; side < sideCount; side++) {
    const teamsOnSide = entries
      .filter((entry) => entry.side === side)
      .map((entry) => `${entry.index}. ${entry.name}`)
      .join(", ");
    lines.push(
      chalk.yellow.bold(`Side ${side + 1}`) +
        chalk.gray(` (${entries.filter((e) => e.side === side).length})`) +
        `: ${teamsOnSide || chalk.gray("(empty)")}`,
    );
  }

  lines.push(chalk.gray("\nTeams:"));
  for (const entry of entries) {
    lines.push(
      chalk.white(`  ${entry.index}. ${entry.name}`) +
        chalk.gray(` → Side ${entry.side + 1}`),
    );
  }

  return lines.join("\n");
}

export async function runFieldSplitEditor(
  teamNames: string[],
  sideCount: number,
  existingSides?: Record<string, number>,
): Promise<Omit<FieldSplitConfig, "draftSlug" | "savedAt">> {
  if (sideCount <= 1) {
    return {sideCount: 1, teamSides: {}};
  }

  const entries = buildTeamEntries(teamNames, sideCount, existingSides);
  const rl = readline.createInterface({input, output});

  try {
    while (true) {
      console.log(renderFieldSplitEditor(entries, sideCount));
      const answer = (await rl.question(chalk.cyan("> "))).trim().toLowerCase();

      if (answer === "d" || answer === "done") {
        break;
      }

      if (answer === "r" || answer === "reset") {
        const resetSides = buildInitialTeamSides(teamNames, sideCount);
        for (const entry of entries) {
          entry.side = resetSides[entry.key] ?? 0;
        }
        continue;
      }

      const parts = answer.split(/\s+/).filter(Boolean);
      const teamNumber = Number.parseInt(parts[0] ?? "", 10);
      const entry = entries.find((item) => item.index === teamNumber);
      if (!entry) {
        console.log(chalk.red("Unknown team number."));
        continue;
      }

      if (parts.length === 1) {
        entry.side = (entry.side + 1) % sideCount;
        continue;
      }

      const sideNumber = Number.parseInt(parts[1] ?? "", 10);
      if (
        !Number.isFinite(sideNumber) ||
        sideNumber < 1 ||
        sideNumber > sideCount
      ) {
        console.log(
          chalk.red(`Side must be between 1 and ${sideCount}.`),
        );
        continue;
      }

      entry.side = sideNumber - 1;
    }
  } finally {
    rl.close();
  }

  const teamSides: Record<string, number> = {};
  for (const entry of entries) {
    teamSides[entry.key] = entry.side;
  }

  return {sideCount, teamSides};
}

export function summarizeFieldSplit(
  config: FieldSplitConfig,
  teamNames: string[],
): string {
  const counts = Array.from({length: config.sideCount}, () => 0);
  for (const teamName of teamNames) {
    const side = config.teamSides[normalizeTeamName(teamName)];
    if (side != null && side >= 0 && side < config.sideCount) {
      counts[side] = (counts[side] ?? 0) + 1;
    }
  }
  return counts.map((count, index) => `Side ${index + 1}: ${count} teams`).join(" | ");
}
