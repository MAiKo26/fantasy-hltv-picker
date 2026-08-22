import chalk from "chalk";
import boxen from "boxen";
import ora, {type Ora} from "ora";
import type {
  ExtractionResult,
  Player,
  PortfolioEntry,
  OptimizationMode,
} from "../types/player.ts";
import type {
  OptimizationDiagnostics,
  PlayerScoreDiagnostics,
} from "../services/mathOptimizer.ts";

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

export function printExtractionSummary(
  result: ExtractionResult,
  teamDisplayLimit = 30,
): void {
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

  const sortedTeams = result.teams
    .sort((a, b) => a.worldRank - b.worldRank)
    .slice(0, teamDisplayLimit > 0 ? teamDisplayLimit : undefined);

  const teamsHeader = chalk.bold.underline("\n🏆 Participating Teams\n");
  const teamsList = sortedTeams
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

  const moreTeams =
    uniqueTeams > teamDisplayLimit && teamDisplayLimit > 0
      ? chalk.gray(`\n  ... and ${uniqueTeams - teamDisplayLimit} more teams`)
      : "";

  const footer = chalk.gray(
    `\nExtracted at: ${result.extractedAt.toLocaleString()}`,
  );

  const summaryBox = boxen(
    `${header}${statsLines}${playersHeader}${playersList}${morePlayers}${teamsHeader}${teamsList}${moreTeams}${footer}`,
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

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function consistencyTag(entry: PortfolioEntry): string {
  if (!entry.consistency) return "";
  const c = entry.consistency;
  return (
    chalk.cyan(` P50=${pct(c.pTop50)}`) +
    chalk.magenta(` P30=${pct(c.pTop30)}`) +
    chalk.yellow(` P10=${pct(c.pTop10)}`)
  );
}

export function printRecommendedLineup(
  entry: PortfolioEntry,
  mode: OptimizationMode,
  recommendation: string,
): void {
  const playerNames = entry.players.map((p) => p.name).join(" | ");
  const price = chalk.yellow(`$${(entry.totalPrice / 1000).toFixed(0)}k`);

  const metricsLine = entry.consistency
    ? `\n  ${chalk.gray("P(beat field median)")}${consistencyTag(entry)}`
    : "";

  const modeLabel =
    mode === "consistency"
      ? "CONSISTENCY PICK"
      : mode === "ceiling"
        ? "CEILING PICK"
        : "MAX-EV PICK";

  const box = boxen(
    `${chalk.bold.underline("\n🎯 Recommended Lineup\n")}\n  ${chalk.white.bold(playerNames)}\n  ${price}${metricsLine}\n\n  ${chalk.gray(recommendation)}\n`,
    {
      padding: {top: 1, bottom: 1, left: 2, right: 2},
      borderStyle: "single",
      borderColor: "green",
      title: modeLabel,
      titleAlignment: "center",
    },
  );

  console.log("\n" + box);
}

export function printPortfolio(portfolio: PortfolioEntry[]): void {
  if (portfolio.length <= 1) return;
  const header = chalk.bold.underline("\n🗂️  SUBMISSION PORTFOLIO\n");
  const lines = portfolio
    .map((entry, idx) => {
      const names = entry.players.map((p) => p.name).join(" | ");
      const price = chalk.yellow(`$${(entry.totalPrice / 1000).toFixed(0)}k`);
      return `${chalk.green(`${idx + 1}.`)} ${names}\n   ${price}${consistencyTag(entry)}`;
    })
    .join("\n");

  const legend = chalk.gray(
    "\n\n  P50 = beats field median · P30 = top-30% of field · P10 = top-10% (simulated)",
  );

  const box = boxen(`${header}${lines}${legend}`, {
    padding: {top: 1, bottom: 1, left: 2, right: 2},
    borderStyle: "single",
    borderColor: "magenta",
    title: "PORTFOLIO",
    titleAlignment: "center",
  });

  console.log("\n" + box);
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
    const pctStr = Math.round(safePct * 100)
      .toString()
      .padStart(3);
    const counter = chalk.gray(`${step}/${total}`);
    const labelText = finished ? chalk.green(label) : chalk.yellow(label);

    const line = `  ${bar} ${pctStr}% ${counter}  ${labelText}`;

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

export function printGoodbye(): void {
  console.log(chalk.cyan("\nThanks for using Fantasy HLTV Picker! 🎮\n"));
}

export function printAllLineupsRanking(
  allScoredLineups: Array<{
    players: Player[];
    lineupIndex: number;
    score: number;
    totalPrice: number;
    consistency?: {pTop50: number; pTop30: number; pTop10: number};
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
      const cons = lineup.consistency
        ? chalk.gray(
            ` P50=${pct(lineup.consistency.pTop50)} P30=${pct(lineup.consistency.pTop30)}`,
          )
        : "";
      return `${rank} ${playerNames}\n   ${price} | ${score}${cons}`;
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
  players: PlayerScoreDiagnostics[],
  detailed = false,
): void {
  const header = chalk.bold.underline("\n📊 TOP 20 BEST RATED PLAYERS\n");

  const lines = players
    .map((p, idx) => {
      const rank = chalk.cyan(`${idx + 1}.`);
      const name = chalk.white.bold(p.name);
      const team = chalk.gray(`[${p.team}]`);
      const total = chalk.green(`★ ${p.total.toFixed(2)}`);
      const sigma = chalk.gray(`σ=${p.sigma.toFixed(3)}`);

      const line = `${rank} ${name} ${team} ${total} ${sigma}`;

      if (!detailed) return line;

      const parts = p.components.map((c) => {
        const valueText = Number.isNaN(c.value)
          ? "N/A"
          : c.value.toFixed(2);
        const sign = c.contribution >= 0 ? "+" : "";
        return `${c.label}:${valueText}×${c.weight.toFixed(2)}=${sign}${c.contribution.toFixed(3)}`;
      });
      const eq = chalk.gray(parts.join(" "));

      return `${line}\n   ${eq}`;
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
        .map(([name, pctShare]) => `${name}:${pctShare.toFixed(1)}%`)
        .join(" | ");
      return `${lineup.rank}. ${lineup.playerNames.join(" | ")}\n   score=${lineup.totalScore.toFixed(2)}  shares -> ${shares}`;
    })
    .join("\n");

  const topPlayers = diagnostics.topPlayers
    .slice(0, 10)
    .map((player, idx) => {
      const parts = [
        `base:${player.baseSkillEV.toFixed(2)}`,
        `σ:${player.sigma.toFixed(3)}`,
        `conf:${(player.dataConfidence * 100).toFixed(0)}%`,
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
