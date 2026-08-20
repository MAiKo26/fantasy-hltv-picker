import fs from "node:fs";
import path from "node:path";

const REGISTRY_PATH = path.join(process.cwd(), ".cache", "used-drafts.json");

function loadUsedDrafts(): string[] {
  if (!fs.existsSync(REGISTRY_PATH)) {
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8"));
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function saveUsedDrafts(drafts: string[]): void {
  fs.mkdirSync(path.dirname(REGISTRY_PATH), {recursive: true});
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify([...new Set(drafts)], null, 2), "utf-8");
}

export function isFirstTimeDraft(draftFile: string): boolean {
  return !loadUsedDrafts().includes(draftFile);
}

export function markDraftUsed(draftFile: string): void {
  saveUsedDrafts([...loadUsedDrafts(), draftFile]);
}
