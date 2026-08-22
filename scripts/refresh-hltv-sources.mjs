import {chromium} from "playwright";
import * as cheerio from "cheerio";
import fs from "node:fs";
import path from "node:path";

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(
    process.env.LOCALAPPDATA ?? "",
    "Google",
    "Chrome",
    "Application",
    "chrome.exe",
  ),
];

const TABLE_SELECTOR =
  "table.stats-table.player-ratings-table tbody tr, table.stats-table tbody tr";

const ALL_SOURCES = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "src", "services", "historical-sources.json"),
    "utf-8",
  ),
);

// --only=key1,key2 → refresh just those sources; otherwise everything.
const onlyArg = process.argv
  .slice(2)
  .find((a) => a.startsWith("--only="));
let SOURCES = ALL_SOURCES;
if (onlyArg) {
  const wanted = new Set(
    onlyArg
      .slice("--only=".length)
      .split(",")
      .map((s) => s.trim()),
  );
  SOURCES = ALL_SOURCES.filter((s) => wanted.has(s.key) || wanted.has(s.filename));
  console.log(`Refreshing ${SOURCES.length}/${ALL_SOURCES.length} sources (--only).`);
}

function formatLocalIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildStatsUrl(source, now = new Date()) {
  const end = new Date(now.getTime());
  const start = new Date(now.getTime());
  start.setMonth(start.getMonth() - source.monthsBack);

  const params = new URLSearchParams({
    startDate: formatLocalIsoDate(start),
    endDate: formatLocalIsoDate(end),
    matchType: source.matchType,
    rankingFilter: source.rankingFilter,
    minMapCount: String(source.minMapCount),
  });
  return `https://www.hltv.org/stats/players?${params.toString()}`;
}

function parsePlayerCount(html) {
  const $ = cheerio.load(html);
  let count = 0;
  $(TABLE_SELECTOR).each((_, row) => {
    const name = $(row).find(".playerCol a").text().trim();
    const rating = parseFloat($(row).find("td.ratingCol").first().text().trim());
    if (name && !Number.isNaN(rating)) {
      count += 1;
    }
  });
  return count;
}

function findChromePath() {
  return CHROME_CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate));
}

async function waitForStatsTable(page) {
  await page.waitForFunction(
    () =>
      document.title !== "Just a moment..." &&
      document.querySelectorAll("table.stats-table tbody tr").length > 0,
    {timeout: 90_000},
  );
}

async function main() {
  const sourceDir = path.join(process.cwd(), "source");
  const userDataDir = path.join(process.cwd(), ".cache", "hltv-browser");
  fs.mkdirSync(sourceDir, {recursive: true});
  fs.mkdirSync(userDataDir, {recursive: true});

  const chromePath = findChromePath();
  const launchOptions = {
    headless: false,
    viewport: {width: 1280, height: 900},
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  };

  if (chromePath) {
    launchOptions.executablePath = chromePath;
  } else {
    launchOptions.channel = "chromium";
    console.log(
      "Google Chrome not found; using Playwright Chromium. Cloudflare may take longer.",
    );
  }

  console.log("Opening Chrome to refresh HLTV stats (Cloudflare may take ~20s)...");
  const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {get: () => undefined});
  });

  const failures = [];

  try {
    for (const [index, source] of SOURCES.entries()) {
      const url = buildStatsUrl(source);
      console.log(`\n[${index + 1}/${SOURCES.length}] ${source.label}`);
      console.log(`  ${url}`);

      await page.goto(url, {waitUntil: "domcontentloaded", timeout: 90_000});
      try {
        await waitForStatsTable(page);
      } catch {
        failures.push(`${source.filename}: Cloudflare challenge did not finish`);
        console.log("  failed: still on the Cloudflare challenge page");
        continue;
      }

      const html = await page.content();
      const playerCount = parsePlayerCount(html);
      if (playerCount < 5) {
        failures.push(`${source.filename}: expected a stats table, got ${playerCount} players`);
        console.log(`  failed: parsed ${playerCount} players`);
        continue;
      }

      const outPath = path.join(sourceDir, source.filename);
      fs.writeFileSync(outPath, html, "utf-8");
      console.log(`  saved ${source.filename} (${playerCount} players)`);

      if (index < SOURCES.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  } finally {
    await context.close();
  }

  if (failures.length > 0) {
    console.error("\nRefresh finished with errors:");
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("\nAll HLTV historical sources refreshed.");
}

await main();
