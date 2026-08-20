import {spawn} from "node:child_process";
import path from "node:path";

const WORKER_RELATIVE_PATH = path.join("scripts", "refresh-hltv-sources.mjs");

export function refreshHistoricalSources(): Promise<void> {
  const workerPath = path.join(process.cwd(), WORKER_RELATIVE_PATH);

  return new Promise((resolve, reject) => {
    const child = spawn("node", [workerPath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      shell: false,
    });

    child.on("error", (error) => {
      reject(
        new Error(
          `Failed to start Node refresh worker (${error.message}). ` +
            "Playwright cannot launch from Bun, so `node` must be on PATH.",
        ),
      );
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `HLTV stats refresh exited with code ${code ?? "unknown"}. ` +
            "If a Cloudflare window appeared, complete the check and try again.",
        ),
      );
    });
  });
}
