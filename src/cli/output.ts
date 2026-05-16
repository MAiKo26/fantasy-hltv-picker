import chalk from "chalk";
import boxen from "boxen";
import ora, {type Ora} from "ora";
import type {
  AnalysisResult,
  ExtractionResult,
  Player,
} from "../types/player.ts";
import type {OptimizationDiagnostics} from "../services/mathOptimizer.ts";

export function printWelcome(): void {
  const title = chalk.cyan.bold("⚡ Fantasy HLTV Picker");
  const subtitle = chalk.gray(
    "Analyze and pick the best players for your fantasy team\n",
  );

  const welcomeBox = boxen(`${title}\n\n${subtitle}`, {
    padding: {top: 1, bottom: 1, left: 2, right: 2},
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
  const totalTeamSlots = result.teams.reduce(
    (sum, t) => sum + t.players.length,
    0,
  );
  const extractionPercent =
    totalTeamSlots > 0 ? Math.round((totalPlayers / totalTeamSlots) * 100) : 0;

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
      const rank =
        team.worldRank > 0
          ? chalk.yellow(`#${team.worldRank}`)
          : chalk.gray("NR");
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
      const level =
        player.cardLevel === "gold"
          ? chalk.yellow("●")
          : player.cardLevel === "silver"
            ? chalk.gray("●")
            : chalk.red("●");
      const price = chalk.green(`$${(player.price / 1000).toFixed(0)}k`);
      const rating = chalk.green(`★ ${player.stats.rating.toFixed(2)}`);
      return `  ${level} ${name} ${team} • ${price} ${rating}`;
    })
    .join("\n");

  const morePlayers =
    totalPlayers > 10
      ? chalk.gray(`\n  ... and ${totalPlayers - 10} more players`)
      : "";

  const footer = chalk.gray(
    `\nExtracted at: ${result.extractedAt.toLocaleString()}`,
  );

  const summaryBox = boxen(
    `${header}${statsLines}${teamsHeader}${teamsList}${playersHeader}${playersList}${morePlayers}${footer}`,
    {
      padding: {top: 1, bottom: 1, left: 2, right: 2},
      borderStyle: "single",
      borderColor: "cyan",
      title: "Extraction Results",
      titleAlignment: "center",
    },
  );

  console.log("\n" + summaryBox);
}

const BAR_WIDTH = 26;

export function createProgressBar(title: string) {
  console.log(chalk.bold.white(`\n  ${title}`));

  let barLineWritten = false;

  function renderBar(
    step: number,
    total: number,
    label: string,
    finished = false,
  ) {
    const safePct = total > 0 ? step / total : 0;
    const filled = Math.round(safePct * BAR_WIDTH);
    const empty = BAR_WIDTH - filled;
    const bar = chalk.cyan("█".repeat(filled)) + chalk.gray("░".repeat(empty));
    const pct = Math.round(safePct * 100)
      .toString()
      .padStart(3);
    const counter = chalk.gray(`${step}/${total}`);
    const labelText = finished ? chalk.green(label) : chalk.yellow(label);

    const line = `  ${bar} ${pct}% ${counter}  ${labelText}`;

    if (barLineWritten) {
      process.stdout.write("\x1b[1A\x1b[2K");
    }
    process.stdout.write(line + "\n");
    barLineWritten = true;
  }

  return {
    tick(step: number, total: number, label: string) {
      renderBar(step, total, label);
    },

    done(label = "Done", total = 1) {
      renderBar(total, total, `✓ ${label}`, true);
    },
  };
}

function formatPlayerLine(
  p: {name: string; team: string; rating: number},
): string {
  const name = chalk.white.bold(p.name);
  const team = chalk.cyan(`(${p.team})`);
  const rating = chalk.green(`★ ${p.rating.toFixed(2)}`);
  return `${name} ${team}  ${rating}`;
}

export function printFinalTeamBox(result: AnalysisResult): void {
  const top3Box = result.top3
    .map((lineup, idx) => {
      const rank = idx === 0 ? "🥇" : idx === 1 ? "🥈" : "🥉";
      const rankLabel = idx === 0 ? "RECOMMENDED" : `OPTION ${idx + 1}`;
      const scoreLabel = chalk.gray(`Score: ${lineup.score}`);

      const lines = lineup.players.map((p, i) => {
        const idxNum = chalk.gray(`${i + 1}.`);
        return `    ${idxNum} ${formatPlayerLine(p)}`;
      });

      const header = chalk.bold(`${rank} ${rankLabel} ${scoreLabel}`);
      const divider = chalk.gray("─".repeat(58));

      return `${header}\n${divider}\n${lines.join("\n")}\n${divider}\n${chalk.cyan("Reasoning:")} ${chalk.white(lineup.reasoning)}`;
    })
    .join("\n\n");

  const box = boxen(top3Box, {
    padding: {top: 1, bottom: 1, left: 2, right: 2},
    borderStyle: "double",
    borderColor: "green",
    title: "TOP 3 LINEUPS",
    titleAlignment: "center",
  });

  console.log("\n" + box);
}

export function printGoodbye(): void {
  console.log(chalk.cyan("\nThanks for using Fantasy HLTV Picker! 🎮\n"));
}

export function printAllLineupsRanking(
  allScoredLineups: Array<{
    players: Player[];
    lineupIndex: number;
    score: number;
    totalPrice: number;
  }>,
): void {
  const header = chalk.bold.underline("\n📊 ALL LINEUPS RANKING\n");

  const lines = allScoredLineups
    .map((lineup, idx) => {
      const rank = chalk.cyan(`${idx + 1}.`);
      const playerNames = lineup.players
        .map((p) => `${p.name} (${p.team})`)
        .join(" | ");
      const price = chalk.yellow(`$${(lineup.totalPrice / 1000).toFixed(0)}k`);
      const score = chalk.green(`Score ${lineup.score.toFixed(2)}`);

      return `${rank} ${playerNames} | ${price} | ${score}`;
    })
    .join("\n");

  const rankingBox = boxen(`${header}${lines}`, {
    padding: {top: 1, bottom: 1, left: 2, right: 2},
    borderStyle: "single",
    borderColor: "cyan",
    title: "LINEUP RANKINGS",
    titleAlignment: "center",
  });

  console.log("\n" + rankingBox);
}

export function printTopRatedPlayers(
  players: Array<{id: string; name: string; team: string; rating: number}>,
): void {
  const header = chalk.bold.underline("\n📊 TOP 20 BEST RATED PLAYERS\n");

  const lines = players
    .map((p, idx) => {
      const rank = chalk.cyan(`${idx + 1}.`);
      const name = chalk.white.bold(p.name);
      const team = chalk.gray(`[${p.team}]`);
      const rating = chalk.green(`★ ${p.rating.toFixed(2)}`);
      return `${rank} ${name} ${team} ${rating}`;
    })
    .join("\n");

  const box = boxen(`${header}${lines}`, {
    padding: {top: 1, bottom: 1, left: 2, right: 2},
    borderStyle: "single",
    borderColor: "yellow",
    title: "TOP 20 PLAYERS",
    titleAlignment: "center",
  });

  console.log("\n" + box);
}

export function printScoringDiagnostics(
  diagnostics: OptimizationDiagnostics,
): void {
  if (diagnostics.topLineups.length === 0) return;

  const lineupSection = diagnostics.topLineups
    .map((lineup) => {
      const shares = Object.entries(lineup.sharesPct)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([name, pct]) => `${name}:${pct.toFixed(1)}%`)
        .join(" | ");
      return `${lineup.rank}. ${lineup.playerNames.join(" | ")}\n   score=${lineup.totalScore.toFixed(2)}  shares -> ${shares}`;
    })
    .join("\n");

  const topPlayers = diagnostics.topPlayers
    .slice(0, 10)
    .map((player, idx) => {
      const parts = [
        `base:${player.baseSkillEV.toFixed(2)}`,
        `team:${player.teamOutcomeEV.toFixed(2)}`,
        `price:$${(player.price / 1000).toFixed(0)}k`,
      ].join(" ");
      return `${idx + 1}. ${player.name} [${player.team}] total:${player.total.toFixed(2)} ${parts}`;
    })
    .join("\n");

  const box = boxen(
    `${chalk.bold.underline("\nSCORING DIAGNOSTICS\n")}${chalk.cyan("Top lineup contribution shares")}\n${lineupSection}\n\n${chalk.cyan("Top projected players (component breakdown)")}\n${topPlayers}`,
    {
      padding: {top: 1, bottom: 1, left: 2, right: 2},
      borderStyle: "single",
      borderColor: "magenta",
      title: "MODEL DEBUG",
      titleAlignment: "center",
    },
  );

  console.log("\n" + box);
}
