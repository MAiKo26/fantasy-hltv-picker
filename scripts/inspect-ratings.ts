import * as fs from "node:fs";
import * as path from "node:path";
import {parseEventGroundTruth} from "../src/services/resultParser.ts";

const RATINGS_DIR = path.join(process.cwd(), "results", "player-ratings-at-end-of-event");
const RESULTS_DIR = path.join(process.cwd(), "results");

function main() {
  if (!fs.existsSync(RATINGS_DIR)) {
    console.error(`Ratings dir not found: ${RATINGS_DIR}`);
    process.exit(1);
  }
  if (!fs.existsSync(RESULTS_DIR)) {
    console.error(`Results dir not found: ${RESULTS_DIR}`);
    process.exit(1);
  }

  const ratingFiles = fs.readdirSync(RATINGS_DIR).filter(f => f.endsWith(".html")).sort();
  console.log(`Found ${ratingFiles.length} files in ${RATINGS_DIR}\n`);

  let withRatings = 0;
  let withBestValue = 0;
  let withBoth = 0;
  let withNeither = 0;
  let withRatingsOnly = 0;
  let withBestValueOnly = 0;

  const rows: Array<{
    slug: string;
    ratings: number;
    bestValue: number;
    hasRatings: boolean;
    hasBestValue: boolean;
  }> = [];

  for (const file of ratingFiles) {
    const ratingsPath = path.join(RATINGS_DIR, file);
    const bestValuePath = path.join(RESULTS_DIR, file);
    const result = parseEventGroundTruth({
      ratingsFile: ratingsPath,
      bestValueFile: bestValuePath,
      eventSlug: path.basename(file, ".html"),
    });

    if (result.hasRatings) withRatings++;
    if (result.hasBestValue) withBestValue++;
    if (result.hasRatings && result.hasBestValue) withBoth++;
    if (!result.hasRatings && !result.hasBestValue) withNeither++;
    if (result.hasRatings && !result.hasBestValue) withRatingsOnly++;
    if (!result.hasRatings && result.hasBestValue) withBestValueOnly++;

    rows.push({
      slug: result.eventSlug,
      ratings: result.ratings.length,
      bestValue: result.bestValuePlayers.length,
      hasRatings: result.hasRatings,
      hasBestValue: result.hasBestValue,
    });
  }

  console.log("─".repeat(90));
  console.log(
    "eventSlug".padEnd(48),
    "ratings".padStart(8),
    "bestValue".padStart(11),
    "  flags",
  );
  console.log("─".repeat(90));
  for (const r of rows) {
    const flags = [
      r.hasRatings ? "R" : "-",
      r.hasBestValue ? "B" : "-",
    ].join("");
    console.log(
      r.slug.padEnd(48),
      String(r.ratings).padStart(8),
      String(r.bestValue).padStart(11),
      `  [${flags}]`,
    );
  }
  console.log("─".repeat(90));
  console.log(`SUMMARY:`);
  console.log(`  ratings-only     : ${withRatingsOnly}`);
  console.log(`  bestValue-only   : ${withBestValueOnly}`);
  console.log(`  both signals     : ${withBoth}`);
  console.log(`  neither (skip)   : ${withNeither}`);
  console.log(`  total files      : ${ratingFiles.length}`);
  console.log(`  events with ratings   : ${withRatings}`);
  console.log(`  events with bestValue : ${withBestValue}`);

  if (withNeither > 0) {
    console.log(`\nWARN: ${withNeither} events have NEITHER ratings nor best value; will be skipped.`);
  } else {
    console.log(`\nOK: parser smoke test passed. ${withBoth} events have both signals.`);
  }
}

main();
