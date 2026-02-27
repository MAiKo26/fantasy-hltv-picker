import chalk from "chalk";
import boxen from "boxen";
import ora, { type Ora } from "ora";
import type { AnalysisResult, ExtractionResult } from "../types/player.ts";

export function printWelcome(): void {
  const title = chalk.cyan.bold("⚡ Fantasy HLTV Picker");
  const subtitle = chalk.gray("Analyze and pick the best players for your fantasy team\n");

  const welcomeBox = boxen(`${title}\n\n${subtitle}`, {
    padding: { top: 1, bottom: 1, left: 2, right: 2 },
    borderStyle: "round",
    borderColor: "cyan",
    titleAlignment: "center",
  });

  console.log(welcomeBox);
}

export function createSpinner(text: string): Ora {
  return ora({
    text: chalk.yellow(text),
    spinner: "material",
    color: "yellow",
  }).start();
}

export function printSuccess(message: string): void {
  console.log(chalk.green("✓") + " " + chalk.green(message));
}

export function printError(message: string): void {
  console.log(chalk.red("✗") + " " + chalk.red(message));
}

export function printExtractionSummary(result: ExtractionResult): void {
  const totalPlayers = result.players.length;
  const uniqueTeams = result.teams.length;
  const totalTeamSlots = result.teams.reduce((sum, t) => sum + t.players.length, 0);
  const extractionPercent = totalTeamSlots > 0 ? Math.round((totalPlayers / totalTeamSlots) * 100) : 0;

  const header = chalk.bold.underline("\n📊 Extraction Summary\n");

  const statsLines = [
    `${chalk.cyan("Players extracted:")} ${chalk.white(totalPlayers)}`,
    `${chalk.cyan("Teams found:")} ${chalk.white(uniqueTeams)}`,
    `${chalk.cyan("Extraction:")} ${chalk.green(extractionPercent + "%")}`,
    `${chalk.cyan("Source file:")} ${chalk.gray(result.sourceFile)}`,
  ].join("\n");

  const teamsHeader = chalk.bold.underline("\n🏆 Participating Teams\n");
  const teamsList = result.teams
    .sort((a, b) => a.worldRank - b.worldRank)
    .map((team) => {
      const rank = team.worldRank > 0 ? chalk.yellow(`#${team.worldRank}`) : chalk.gray("NR");
      const name = chalk.white.bold(team.name);
      const players = chalk.gray(`(${team.players.length} players)`);
      return `  ${rank} ${name} ${players}`;
    })
    .join("\n");

  const playersHeader = chalk.bold.underline("\n🎮 Extracted Players\n");
  const playersList = result.players
    .slice(0, 10)
    .map((player) => {
      const name = chalk.white.bold(player.name);
      const team = chalk.gray(`[${player.team}]`);
      const level = player.cardLevel === "gold" 
        ? chalk.yellow("●") 
        : player.cardLevel === "silver" 
          ? chalk.gray("●") 
          : chalk.red("●");
      const price = chalk.green(`$${(player.price / 1000).toFixed(0)}k`);
      const rating = chalk.green(`★ ${player.stats.rating.toFixed(2)}`);
      return `  ${level} ${name} ${team} • ${price} ${rating}`;
    })
    .join("\n");

  const morePlayers = totalPlayers > 10 ? chalk.gray(`\n  ... and ${totalPlayers - 10} more players`) : "";

  const footer = chalk.gray(`\nExtracted at: ${result.extractedAt.toLocaleString()}`);

  const summaryBox = boxen(
    `${header}${statsLines}${teamsHeader}${teamsList}${playersHeader}${playersList}${morePlayers}${footer}`,
    {
      padding: { top: 1, bottom: 1, left: 2, right: 2 },
      borderStyle: "single",
      borderColor: "cyan",
      title: "Extraction Results",
      titleAlignment: "center",
    }
  );

  console.log("\n" + summaryBox);
}

export function printResults(result: AnalysisResult): void {
  const header = chalk.bold.underline("\n📊 Top 5 Player Picks\n");

  const playerLines = result.players
    .map((player, index) => {
      const position = chalk.cyan(`${index + 1}.`);
      const name = chalk.white.bold(player.name);
      const team = chalk.gray(`[${player.team}]`);
      const role = chalk.yellow(player.role);
      const rating = chalk.green(`★ ${player.rating.toFixed(2)}`);

      return `${position} ${name} ${team} • ${role} ${rating}`;
    })
    .join("\n");

  const footer = chalk.gray(`\nAnalyzed at: ${result.analyzedAt.toLocaleString()}`) +
    "\n" + chalk.gray(`Source: ${result.sourceUrl}`);

  const resultsBox = boxen(`${header}${playerLines}${footer}`, {
    padding: { top: 1, bottom: 1, left: 2, right: 2 },
    borderStyle: "single",
    borderColor: "green",
    title: "Results",
    titleAlignment: "center",
  });

  console.log("\n" + resultsBox);
}

export function printGoodbye(): void {
  console.log(chalk.cyan("\nThanks for using Fantasy HLTV Picker! 🎮\n"));
}
