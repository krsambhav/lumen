/** Sizes and speeds as Lumen writes them: tabular figures, the unit with the value. */

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** `1536` → "1.5 KB". One decimal below 10 of a unit, none above. */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const figure = unit === 0 || value >= 10 ? Math.round(value).toString() : value.toFixed(1);
  return `${figure} ${UNITS[unit]}`;
}

/** Bytes a second, as "2.4 MB/s". */
export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** "1 seed", "523 seeds", "12.3k seeds". */
export function formatSeeds(seeders: number): string {
  const figure =
    seeders >= 10_000
      ? `${Math.round(seeders / 1000)}k`
      : seeders >= 1000
        ? `${(seeders / 1000).toFixed(1)}k`
        : String(seeders);
  return `${figure} ${seeders === 1 ? "seed" : "seeds"}`;
}

/** What the server's state for a torrent being fetched means, in a few words. */
export function describeState(state: string, progress: number): string {
  const lower = state.toLowerCase();
  if (lower === "queued") {
    return "Waiting for a free slot";
  }
  if (lower.includes("metadata") || lower === "checking") {
    return "Finding the files";
  }
  if (lower.includes("stalled")) {
    return "Waiting for someone to share it";
  }
  if (lower.includes("upload") || progress >= 100) {
    return "Finishing";
  }
  return "Fetching";
}
