/** The speeds the keys and the menu step through (DESIGN.md §7, "Speed"). */
export const SPEEDS: readonly number[] = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3, 4];

export const NORMAL_SPEED = 1;

/** True when `rate` is, for all anyone can tell, normal speed. */
export function isNormalSpeed(rate: number): boolean {
  return Math.abs(rate - NORMAL_SPEED) < 0.005;
}

/**
 * The next speed up or down from `rate`. A rate between two steps (set some
 * other way) goes to the nearest step in that direction.
 */
export function stepSpeed(rate: number, direction: 1 | -1): number {
  const first = SPEEDS[0] ?? NORMAL_SPEED;
  const last = SPEEDS[SPEEDS.length - 1] ?? NORMAL_SPEED;
  if (direction > 0) {
    return SPEEDS.find((speed) => speed > rate + 0.005) ?? last;
  }
  return [...SPEEDS].reverse().find((speed) => speed < rate - 0.005) ?? first;
}

/** The step nearest to `rate`: the one a list of the speeds marks as in force. */
export function nearestSpeed(rate: number): number {
  return SPEEDS.reduce((nearest, each) =>
    Math.abs(each - rate) < Math.abs(nearest - rate) ? each : nearest,
  );
}

/** A speed as it is shown: "1.5×", "0.25×", "2×". */
export function formatSpeed(rate: number): string {
  return `${Number(rate.toFixed(2))}×`;
}

/** A speed in words: "1.5 times", "half speed" is not attempted. */
export function spokenSpeed(rate: number): string {
  return isNormalSpeed(rate) ? "normal speed" : `${Number(rate.toFixed(2))} times normal speed`;
}
