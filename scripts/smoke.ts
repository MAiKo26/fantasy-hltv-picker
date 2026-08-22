/** End-to-end smoke test: extract → enrich → optimize → simulate → portfolio. */
import {HtmlExtractorService} from "../src/services/extractor.ts";
import {FantasyAnalyzerService} from "../src/services/analyzer.ts";

const file = process.argv[2];
if (!file) {
  console.error("Usage: bun scripts/smoke.ts <draft-file.html>");
  process.exit(1);
}

const extractor = new HtmlExtractorService();
const result = await extractor.extract(file);
console.log(`Extracted ${result.players.length} players / ${result.teams.length} teams`);

const analyzer = new FantasyAnalyzerService();
const analysis = await analyzer.analyze(
  result.players,
  result.teams,
  {strategy: "Auto", mode: "consistency"},
  file,
);

console.log(`\nMode: ${analysis.mode}`);
console.log(`Recommendation: ${analysis.recommendation}`);
console.log("\nTop-5 ranked candidates:");
for (const entry of analysis.allScoredLineups.slice(0, 5)) {
  const names = entry.players.map((p) => p.name).join(" | ");
  const cons = entry.consistency
    ? ` P50=${(entry.consistency.pTop50 * 100).toFixed(0)}% P30=${(entry.consistency.pTop30 * 100).toFixed(0)}% P10=${(entry.consistency.pTop10 * 100).toFixed(0)}%`
    : "";
  console.log(`  ${entry.lineupIndex + 1}. ${names}\n     $${(entry.totalPrice / 1000).toFixed(0)}k${cons}`);
}
console.log("\n✅ Smoke test passed");
