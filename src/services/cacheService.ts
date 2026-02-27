import * as fs from "fs";
import * as path from "path";

const CACHE_DIR = path.join(process.cwd(), ".cache");

export class CacheService {
  constructor() {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, {recursive: true});
    }
  }

  private getFilePath(key: string): string {
    return path.join(CACHE_DIR, `${key}.json`);
  }

  set(key: string, data: any): void {
    const payload = {
      timestamp: new Date().toISOString(),
      data,
    };
    fs.writeFileSync(
      this.getFilePath(key),
      JSON.stringify(payload, null, 2),
      "utf-8",
    );
  }

  get<T>(key: string, maxAgeHours: number = 24): T | null {
    const filePath = this.getFilePath(key);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const payload = JSON.parse(content);

      if (!payload.timestamp || !payload.data) {
        return null;
      }

      const cachedTime = new Date(payload.timestamp).getTime();
      const now = new Date().getTime();
      const ageHours = (now - cachedTime) / (1000 * 60 * 60);

      if (ageHours > maxAgeHours) {
        return null; // Expired
      }

      return payload.data as T;
    } catch {
      return null;
    }
  }
}

export const cacheService = new CacheService();
