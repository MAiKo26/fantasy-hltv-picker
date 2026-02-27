import type { AnalyzerService, AnalysisResult, Player } from "../types/player.ts";

const SIMULATED_PLAYERS: Player[] = [
  { id: "1", name: "s1mple", team: "NAVI", role: "AWPer", rating: 1.31 },
  { id: "2", name: "ZywOo", team: "Vitality", role: "AWPer", rating: 1.28 },
  { id: "3", name: "m0NESY", team: "G2", role: "AWPer", rating: 1.25 },
  { id: "4", name: "NiKo", team: "G2", role: "Rifler", rating: 1.22 },
  { id: "5", name: "donk", team: "Spirit", role: "Rifler", rating: 1.35 },
  { id: "6", name: "Jame", team: "NAVI", role: "AWPer", rating: 1.18 },
  { id: "7", name: "device", team: "NAVI", role: "AWPer", rating: 1.20 },
  { id: "8", name: "broky", team: "FaZe", role: "AWPer", rating: 1.17 },
  { id: "9", name: "rain", team: "FaZe", role: "Rifler", rating: 1.15 },
  { id: "10", name: "ax1Le", team: "Spirit", role: "Rifler", rating: 1.23 },
  { id: "11", name: "f0rest", team: "NAVI", role: "Rifler", rating: 1.12 },
  { id: "12", name: "karrigan", team: "FaZe", role: "IGL", rating: 1.08 },
  { id: "13", name: "Xizt", team: "Fnatic", role: "IGL", rating: 1.05 },
  { id: "14", name: " FalleN", team: "Imperial", role: "AWPer", rating: 1.10 },
  { id: "15", name: "YEKINDAR", team: "Vitality", role: "Rifler", rating: 1.14 },
];

function shuffleArray<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = result[i];
    if (temp !== undefined && result[j] !== undefined) {
      result[i] = result[j];
      result[j] = temp;
    }
  }
  return result;
}

function getRandomPlayers(count: number): Player[] {
  const shuffled = shuffleArray(SIMULATED_PLAYERS);
  return shuffled.slice(0, count);
}

export class FantasyAnalyzerService implements AnalyzerService {
  async analyze(url: string): Promise<AnalysisResult> {
    const delay = Math.random() * 2000 + 1000;
    await new Promise((resolve) => setTimeout(resolve, delay));

    return {
      players: getRandomPlayers(5),
      analyzedAt: new Date(),
      sourceUrl: url,
    };
  }
}
