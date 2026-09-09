import * as fs from "node:fs";
import * as path from "node:path";

export const DRAFT_DIR = path.join(process.cwd(), "source", "draft");

/**
 * Sanitize a user-provided file name for a draft HTML entry.
 * - Trims whitespace
 * - Strips directory components (prevents traversal)
 * - Replaces Windows-forbidden chars < > : " / \ | ? * and control chars
 * - Collapses inner whitespace
 * - Ensures .html extension
 * - Rejects empty or just ".html"
 */
export function sanitizeLeagueFileName(raw: string): string {
  let name = raw.trim();

  if (!name) {
    throw new Error("File name cannot be empty.");
  }

  // Strip directory components to prevent traversal (e.g. "../evil")
  name = path.basename(name);

  if (!name || name === "." || name === "..") {
    throw new Error("Invalid file name.");
  }

  // Replace forbidden characters: < > : " / \ | ? * plus control chars 0x00-0x1F
  name = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-");

  // Collapse whitespace (but keep single spaces, will later allow)
  name = name.replace(/\s+/g, " ").trim();

  // After sanitization, re-check
  if (!name || name === "." || name === "..") {
    throw new Error("Invalid file name after sanitization.");
  }

  // Ensure .html extension (case-insensitive check, preserve lower-case)
  if (!name.toLowerCase().endsWith(".html")) {
    name += ".html";
  }

  if (name.toLowerCase() === ".html") {
    throw new Error("File name cannot be just an extension.");
  }

  // Disallow ".." lingering (e.g. user typed "..html")
  if (name.includes("..")) {
    // Allow single dots inside name but not directory traversal; we already
    // stripped via basename, so a remaining ".." is just a weird name — replace it
    name = name.replace(/\.\./g, "--");
  }

  // Final length guard (filesystem limit)
  if (name.length > 255) {
    throw new Error("File name is too long (max 255 characters).");
  }

  return name;
}

export function resolveLeagueEntryPath(fileName: string): string {
  const sanitized = sanitizeLeagueFileName(fileName);
  return path.join(DRAFT_DIR, sanitized);
}

export function leagueEntryExists(fileName: string): boolean {
  try {
    const filePath = resolveLeagueEntryPath(fileName);
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

export function saveLeagueEntry(fileName: string, htmlContent: string): string {
  if (!htmlContent || !htmlContent.trim()) {
    throw new Error("HTML content is empty.");
  }

  const filePath = resolveLeagueEntryPath(fileName);
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  // Write as UTF-8, preserving exactly what user pasted (trim only trailing newline normalization is not needed)
  fs.writeFileSync(filePath, htmlContent, "utf-8");
  return filePath;
}
