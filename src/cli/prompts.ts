import inquirer from "inquirer";
import type {Question} from "inquirer";
import {listSourceFiles} from "../services/extractor.ts";
import {
  draftSlugFromSourceFile,
  loadFieldSplit,
  mergeTeamsIntoFieldSplit,
  saveFieldSplit,
} from "../services/fieldSplitStore.ts";
import {runFieldSplitEditor, summarizeFieldSplit} from "./fieldSplitEditor.ts";
import type {
  FantasyTeam,
  Strategy,
  ForcedTeam,
  MinTeamPlayers,
} from "../types/player.ts";
import type {FieldSplitConfig} from "../types/fieldSplit.ts";

export type MainAction = "optimize" | "refresh" | "exit";

export interface MainActionAnswers {
  action: MainAction;
}

export async function promptForMainAction(): Promise<MainAction> {
  const question: Question<MainActionAnswers> = {
    type: "rawlist",
    name: "action",
    message: "What do you want to do?",
    choices: [
      {name: "Optimize a fantasy lineup", value: "optimize"},
      {name: "Refresh HLTV historical stats", value: "refresh"},
      {name: "Exit", value: "exit"},
    ],
  };

  const answers = await inquirer.prompt([question]);
  return answers.action;
}

export interface OptimizeOptionsAnswers {
  lineupDisplayLimit: number;
  detailedOutput: boolean;
}

export async function promptForOptimizeOptions(): Promise<OptimizeOptionsAnswers> {
  const question: Question<OptimizeOptionsAnswers> = {
    type: "rawlist",
    name: "lineupDisplayLimit",
    message: "How many lineups should be shown in the ranking?",
    choices: [
      {name: "Top 10", value: 10},
      {name: "Top 30 (default)", value: 30},
      {name: "Top 50", value: 50},
      {name: "Top 100", value: 100},
    ],
    default: 30,
  };

  const detailedQuestion: Question<{detailedOutput: boolean}> = {
    type: "confirm",
    name: "detailedOutput",
    message: "Show detailed player score breakdown?",
    default: false,
  };

  const limitAnswers = await inquirer.prompt([question]);
  const detailedAnswers = await inquirer.prompt([detailedQuestion]);

  return {
    lineupDisplayLimit: limitAnswers.lineupDisplayLimit,
    detailedOutput: detailedAnswers.detailedOutput,
  };
}

export interface SourceFileAnswers {
  sourceFile: string;
}

export async function promptForSourceFile(): Promise<string> {
  const files = await listSourceFiles();

  if (files.length === 0) {
    throw new Error(
      "No HTML files found in source/ folder. Please add HTML files to the source/ directory.",
    );
  }

  const question: Question<SourceFileAnswers> = {
    type: "rawlist",
    name: "sourceFile",
    message: "Select an HTML file to analyze:",
    choices: files,
  };

  const answers = await inquirer.prompt([question]);
  return answers.sourceFile;
}

export interface StrategyAnswers {
  strategy: Strategy;
}

export async function promptForStrategy(): Promise<Strategy> {
  const question: Question<StrategyAnswers> = {
    type: "rawlist",
    name: "strategy",
    message: "Select your team strategy:",
    choices: [
      "Auto (let analyzer decide)",
      "2-2-1 (2 Team X + 2 Team Y + 1 Team Z)",
      "2-1-1-1-1 (2 Team X + 3 Unique Teams)",
      "1-1-1-1-1 (5 Unique Teams)",
    ],
    default: "Auto (let analyzer decide)",
  };

  const answers = await inquirer.prompt([question]);

  const strategyMap: Record<string, Strategy> = {
    "Auto (let analyzer decide)": "Auto",
    "2-2-1 (2 Team X + 2 Team Y + 1 Team Z)": "2-2-1",
    "2-1-1-1-1 (2 Team X + 3 Unique Teams)": "2-1-1-1",
    "1-1-1-1-1 (5 Unique Teams)": "1-1-1-1-1",
  };

  return strategyMap[answers.strategy] ?? "Auto";
}

export interface ForcedTeamAnswers {
  forcedTeam: string[];
}

export interface MinTeamPlayersAnswers {
  minTeamPlayers: MinTeamPlayers;
}

export async function promptForForcedTeam(
  teams: FantasyTeam[],
): Promise<ForcedTeam | null> {
  const teamNames = teams.map((t) => t.name);

  const teamQuestion: Question<ForcedTeamAnswers> = {
    type: "checkbox",
    name: "forcedTeam",
    message:
      "Force a specific team into your lineup (pick one, or leave empty to skip):",
    choices: teamNames,
  };

  let selected: string[] = [];
  while (selected.length !== 1) {
    if (selected.length > 1) {
      console.log(
        "You can only force one team. Please pick a single team or leave it empty.",
      );
    }
    const teamAnswers = await inquirer.prompt([teamQuestion]);
    selected = teamAnswers.forcedTeam ?? [];
    if (selected.length === 0) {
      return null;
    }
  }

  const forcedTeamName = selected[0]!;

  const countQuestion: Question<MinTeamPlayersAnswers> = {
    type: "rawlist",
    name: "minTeamPlayers",
    message: `Minimum number of ${forcedTeamName} players:`,
    choices: [
      "Auto (let analyzer decide)",
      "1 (at least 1 player)",
      "2 (at least 2 players)",
    ],
    default: "Auto (let analyzer decide)",
  };

  const countAnswers = await inquirer.prompt([countQuestion]);

  const countMap: Record<string, MinTeamPlayers> = {
    "Auto (let analyzer decide)": "Auto",
    "1 (at least 1 player)": 1,
    "2 (at least 2 players)": 2,
  };

  return {
    name: forcedTeamName,
    minPlayers: countMap[countAnswers.minTeamPlayers] ?? "Auto",
  };
}

export interface ExcludedTeamsAnswers {
  excludedTeams: string[];
}

export async function promptForFieldSplit(
  teams: FantasyTeam[],
  sourceFile: string,
): Promise<FieldSplitConfig | null> {
  const slug = draftSlugFromSourceFile(sourceFile);
  const teamNames = teams.map((team) => team.name);
  const cached = loadFieldSplit(slug);

  if (cached && cached.sideCount > 1) {
    const reconfigureQuestion: Question<{reconfigure: boolean}> = {
      type: "confirm",
      name: "reconfigure",
      message: `Reconfigure saved field split (${cached.sideCount} sides)?`,
      default: false,
    };

    const {reconfigure} = await inquirer.prompt([reconfigureQuestion]);
    if (!reconfigure) {
      const merged = mergeTeamsIntoFieldSplit(cached, teamNames);
      if (merged !== cached) {
        saveFieldSplit(merged);
      }
      console.log(
        `Using saved field split: ${summarizeFieldSplit(merged, teamNames)}`,
      );
      return merged;
    }
  }

  const sideCountQuestion: Question<{sideCount: number}> = {
    type: "rawlist",
    name: "sideCount",
    message: "How many sides should the field be split into?",
    choices: [
      {name: "1 — no split (default)", value: 1},
      {name: "2 sides", value: 2},
      {name: "3 sides", value: 3},
      {name: "4 sides", value: 4},
      {name: "5 sides", value: 5},
      {name: "6 sides", value: 6},
    ],
    default: 0,
  };

  const {sideCount} = await inquirer.prompt([sideCountQuestion]);
  if (sideCount <= 1) {
    if (cached && cached.sideCount > 1) {
      console.log("Field split disabled for this run (saved split kept).");
    }
    return null;
  }

  const existingSides =
    cached && cached.sideCount === sideCount ? cached.teamSides : undefined;
  const editorResult = await runFieldSplitEditor(
    teamNames,
    sideCount,
    existingSides,
  );

  const config: FieldSplitConfig = {
    draftSlug: slug,
    sideCount: editorResult.sideCount,
    teamSides: editorResult.teamSides,
    savedAt: new Date().toISOString(),
  };

  saveFieldSplit(config);
  console.log(
    `Saved field split for "${slug}": ${summarizeFieldSplit(config, teamNames)}`,
  );
  return config;
}

export async function promptForExcludedTeams(
  teams: FantasyTeam[],
): Promise<string[]> {
  const teamNames = teams.map((t) => t.name);

  const question: Question<ExcludedTeamsAnswers> = {
    type: "checkbox",
    name: "excludedTeams",
    message: "Exclude teams you don't want in your lineup:",
    choices: teamNames,
  };

  const answers = await inquirer.prompt([question]);
  return answers.excludedTeams ?? [];
}
