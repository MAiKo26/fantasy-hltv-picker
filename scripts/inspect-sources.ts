import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import {normalizePlayerName} from "../src/utils/normalize.ts";

interface Row {
  name: string;
  rating: number;
  maps: number;
}

const FILES: [string, string][] = [
  ["12m Top50 LAN", "last_12_months_top_50.html"],
  ["12m Top30 LAN", "last_12_months_top_30.html"],
  ["12m Top20 LAN", "last_12_months_top_20.html"],
  ["12m Top10 LAN", "last_12_months_top_10.html"],
  ["6m Top30 LAN", "last_6_months_top_30_lan.html"],
  ["3m Top50 LAN", "last_3_months_top_50_lan.html"],
  ["3m Top20 MVP", "last_3_months_top_20_mvp_events.html"],
  ["1m Top30 MVP", "last_1_month_top_30_mvp_events.html"],
];

function parse(file: string): Row[] {
  const $ = cheerio.load(
    fs.readFileSync(path.join(process.cwd(), "source", file), "utf-8"),
  );
  const rows: Row[] = [];
  $("table.stats-table.player-ratings-table tbody tr, table.stats-table tbody tr").each((_, el) => {
    const name = $(el).find(".playerCol a").text().trim();
    const rating = parseFloat($(el).find("td.ratingCol").first().text().trim());
    const maps = parseInt($(el).find("td").eq(2).text().replace(/[^0-9]/g, ""), 10) || 0;
    if (name && !isNaN(rating)) rows.push({name, rating, maps});
  });
  return rows;
}

function stats(r: number[]): {mean: number; std: number; p50: number; p90: number; min: number; max: number} {
  if (!r.length) return {mean: NaN, std: NaN, p50: NaN, p90: NaN, min: NaN, max: NaN};
  const s = [...r].sort((a, b) => a - b);
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const std = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / r.length);
  return {
    mean,
    std,
    p50: s[Math.floor(s.length / 2)]!,
    p90: s[Math.floor(s.length * 0.9)]!,
    min: s[0]!,
    max: s[s.length - 1]!,
  };
}

const tables = new Map<string, Map<string, Row>>();
for (const [label, file] of FILES) {
  const rows = parse(file);
  tables.set(label, new Map(rows.map(r => [normalizePlayerName(r.name), r])));
  const m = stats(rows.map(r => r.rating));
  const maps = rows.map(r => r.maps).sort((a, b) => a - b);
  console.log(
    `${label.padEnd(14)} n=${String(rows.length).padStart(3)}  rating μ=${m.mean.toFixed(3)} σ=${m.std.toFixed(3)} p50=${m.p50.toFixed(2)} p90=${m.p90.toFixed(2)} min=${m.min.toFixed(2)} max=${m.max.toFixed(2)}  | maps med=${maps[Math.floor(maps.length / 2)]} min=${maps[0]} max=${maps[maps.length - 1]}`,
  );
}

console.log("\n── Overlap & rating deltas for shared players ─────────────────");
for (let i = 0; i < FILES.length; i++) {
  for (let j = i + 1; j < FILES.length; j++) {
    const A = tables.get(FILES[i]![0]!) ?? new Map<string, Row>();
    const B = tables.get(FILES[j]![0]!) ?? new Map<string, Row>();
    let shared = 0;
    let sumA = 0, sumB = 0, sqSum = 0;
    const deltas: number[] = [];
    for (const [name, rowA] of A) {
      const rowB = B.get(name);
      if (!rowB) continue;
      shared++;
      sumA += rowA.rating; sumB += rowB.rating;
      deltas.push(rowB.rating - rowA.rating);
      sqSum += (rowB.rating - rowA.rating) ** 2;
    }
    if (!shared) continue;
    const rmse = Math.sqrt(sqSum / shared);
    const bias = (sumB - sumA) / shared;
    console.log(
      `${FILES[i]![0]!.padEnd(13)} vs ${FILES[j]![0]!.padEnd(13)} shared=${String(shared).padStart(3)}  bias(B−A)=${bias >= 0 ? "+" : ""}${bias.toFixed(3)}  RMSE=${rmse.toFixed(3)}  max|Δ|=${Math.max(...deltas.map(Math.abs)).toFixed(2)}`,
    );
  }
}

console.log("\n── Draft coverage ─────────────────────────────────────────────");
const draftDir = path.join(process.cwd(), "source", "draft");
const draftPlayers = new Set<string>();
for (const f of fs.readdirSync(draftDir)) {
  if (!f.endsWith(".html")) continue;
  const $ = cheerio.load(fs.readFileSync(path.join(draftDir, f), "utf-8"));
  $(".teamPlayer .card-player-tag").each((_, el) => {
    const n = $(el).text().trim();
    if (n) draftPlayers.add(normalizePlayerName(n));
  });
}
console.log(`unique draft players: ${draftPlayers.size}`);
for (const [label] of FILES) {
  const t = tables.get(label)!;
  let covered = 0;
  const missing: string[] = [];
  for (const p of draftPlayers) {
    if (t.has(p)) covered++;
    else missing.push(p);
  }
  console.log(`${label.padEnd(14)} covers ${covered}/${draftPlayers.size} (${((covered / draftPlayers.size) * 100).toFixed(0)}%)  missing e.g.: ${missing.slice(0, 5).join(", ")}`);
}

console.log("\n── Union of proposed set (all files) ──────────────────────────");
const union = new Set<string>();
for (const [, t] of tables) for (const k of t.keys()) union.add(k);
console.log(`union size: ${union.size}, draft players outside union: ${[...draftPlayers].filter(p => !union.has(p)).join(", ") || "none"}`);
