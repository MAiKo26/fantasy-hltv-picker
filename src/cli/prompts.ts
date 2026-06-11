import inquirer from "inquirer";
import type {Question} from "inquirer";
import {listSourceFiles} from "../services/extractor.ts";
import type {FantasyTeam, Strategy, ForcedTeam, MinTeamPlayers} from "../types/player.ts";

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
    default: 0,
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
  forcedTeam: string;
}

export interface MinTeamPlayersAnswers {
  minTeamPlayers: MinTeamPlayers;
}

export async function promptForForcedTeam(
  teams: FantasyTeam[],
): Promise<ForcedTeam | null> {
  const teamNames = teams.map((t) => t.name);

  const choices = ["None (let analyzer decide)", ...teamNames];

  const teamQuestion: Question<ForcedTeamAnswers> = {
    type: "rawlist",
    name: "forcedTeam",
    message: "Force a specific team into your lineup:",
    choices,
    default: 0,
  };

  const teamAnswers = await inquirer.prompt([teamQuestion]);

  if (teamAnswers.forcedTeam === "None (let analyzer decide)") {
    return null;
  }

  const countQuestion: Question<MinTeamPlayersAnswers> = {
    type: "rawlist",
    name: "minTeamPlayers",
    message: `Minimum number of ${teamAnswers.forcedTeam} players:`,
    choices: [
      "Auto (let analyzer decide)",
      "1 (at least 1 player)",
      "2 (at least 2 players)",
    ],
    default: 0,
  };

  const countAnswers = await inquirer.prompt([countQuestion]);

  const countMap: Record<string, MinTeamPlayers> = {
    "Auto (let analyzer decide)": "Auto",
    "1 (at least 1 player)": 1,
    "2 (at least 2 players)": 2,
  };

  return {
    name: teamAnswers.forcedTeam,
    minPlayers: countMap[countAnswers.minTeamPlayers] ?? "Auto",
  };
}

export interface ExcludedTeamsAnswers {
  excludedTeams: string[];
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
