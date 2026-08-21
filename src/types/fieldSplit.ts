export interface FieldSplitConfig {
  draftSlug: string;
  sideCount: number;
  /** Normalized team name → side index (0-based). */
  teamSides: Record<string, number>;
  savedAt: string;
}

export interface FieldSplitRuntime {
  sideCount: number;
  teamSideByNormalizedName: Map<string, number>;
}

export function toFieldSplitRuntime(
  config: FieldSplitConfig | null | undefined,
): FieldSplitRuntime | null {
  if (!config || config.sideCount <= 1) {
    return null;
  }

  const teamSideByNormalizedName = new Map<string, number>();
  for (const [teamKey, sideIndex] of Object.entries(config.teamSides)) {
    if (sideIndex >= 0 && sideIndex < config.sideCount) {
      teamSideByNormalizedName.set(teamKey, sideIndex);
    }
  }

  return {
    sideCount: config.sideCount,
    teamSideByNormalizedName,
  };
}
