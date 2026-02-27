import inquirer from "inquirer";
import type { Question } from "inquirer";
import { listSourceFiles } from "../services/extractor.ts";

export interface SourceFileAnswers {
  sourceFile: string;
}

export async function promptForSourceFile(): Promise<string> {
  const files = await listSourceFiles();

  if (files.length === 0) {
    throw new Error("No HTML files found in source/ folder. Please add HTML files to the source/ directory.");
  }

  const question: Question<SourceFileAnswers> = {
    type: "list",
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
