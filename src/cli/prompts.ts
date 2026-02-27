import inquirer from "inquirer";
import type {Question} from "inquirer";
import {listSourceFiles} from "../services/extractor.ts";
import type {FantasyTeam, Strategy, MinG2Players} from "../types/player.ts";

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

export interface FantasyUrlAnswers {
  fantasyUrl: string;
}

export async function promptForFantasyUrl(): Promise<string> {
  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "fantasyUrl",
      message: "Enter Fantasy HLTV link to analyze:",
      default: "https://www.hltv.org/fantasy",
      validate: (input: string): true | string => {
        const url = input.trim();
        if (!url) {
          return "Please enter a valid URL";
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          return "Please enter a valid URL starting with http:// or https://";
        }
        return true;
      },
      filter: (input: string): string => input.trim(),
    },
  ]);

  return answers.fantasyUrl;
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

export interface MinG2PlayersAnswers {
  minG2Players: MinG2Players;
}

export async function promptForMinG2Players(
  teams: FantasyTeam[],
): Promise<MinG2Players | null> {
  const teamNames = teams.map((t) => t.name);
  const hasG2 = teamNames.includes("G2");

  if (!hasG2) {
    return null;
  }

  const question: Question<MinG2PlayersAnswers> = {
    type: "rawlist",
    name: "minG2Players",
    message: "Minimum number of G2 players in your team:",
    choices: [
      "Auto (let analyzer decide)",
      "1 (at least 1 G2 player)",
      "2 (at least 2 G2 players)",
    ],
    default: 0,
  };

  const answers = await inquirer.prompt([question]);

  const g2Map: Record<string, MinG2Players> = {
    "Auto (let analyzer decide)": "Auto",
    "1 (at least 1 G2 player)": 1,
    "2 (at least 2 G2 players)": 2,
  };

  return g2Map[answers.minG2Players] ?? "Auto";
}

export interface DisableLLMEvaluationAnswers {
  disableLLMEvaluation: boolean;
}

export async function promptForDisableLLMEvaluation(): Promise<boolean> {
  const question: Question<DisableLLMEvaluationAnswers> = {
    type: "confirm",
    name: "disableLLMEvaluation",
    message: "Disable Stage 3 (LLM Evaluation)?",
    default: true,
  };

  const answers = await inquirer.prompt([question]);
  return answers.disableLLMEvaluation;
}
