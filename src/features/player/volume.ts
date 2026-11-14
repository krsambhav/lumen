/**
 * The volume, and where each level sits on a scale (DESIGN.md §7, "Volume").
 *
 * Ordinary levels, 0 to 100%, take the first three quarters of the scale and
 * the boost to 200% the last quarter: the normal range has room, and boost is
 * somewhere you go on purpose. The control bar's scale and the on-screen
 * display's both use this, so their needles always agree.
 */

/** Normal volume: what the file was mixed for. */
export const NORMAL_VOLUME = 100;
/** The loudest boost. */
export const MAX_VOLUME = 200;
/** Every change moves between multiples of this. */
export const VOLUME_STEP = 5;

/** The share of the scale that 0 to 100% takes. */
const NORMAL_SHARE = 0.75;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Where a volume sits along the scale, from 0 to 1. */
export function volumeToFraction(percent: number): number {
  const volume = clamp(percent, 0, MAX_VOLUME);
  if (volume <= NORMAL_VOLUME) {
    return (volume / NORMAL_VOLUME) * NORMAL_SHARE;
  }
  const boost = (volume - NORMAL_VOLUME) / (MAX_VOLUME - NORMAL_VOLUME);
  return NORMAL_SHARE + boost * (1 - NORMAL_SHARE);
}

/** The volume at a point along the scale, from 0 to 1. Not rounded. */
export function fractionToVolume(fraction: number): number {
  const at = clamp(fraction, 0, 1);
  if (at <= NORMAL_SHARE) {
    return (at / NORMAL_SHARE) * NORMAL_VOLUME;
  }
  const boost = (at - NORMAL_SHARE) / (1 - NORMAL_SHARE);
  return NORMAL_VOLUME + boost * (MAX_VOLUME - NORMAL_VOLUME);
}

/**
 * The next level up or down: the neighbouring multiple of the step, so 63%
 * goes to 65% and then 70%.
 */
export function stepVolume(percent: number, direction: 1 | -1): number {
  const next =
    direction > 0
      ? Math.floor(percent / VOLUME_STEP) * VOLUME_STEP + VOLUME_STEP
      : Math.ceil(percent / VOLUME_STEP) * VOLUME_STEP - VOLUME_STEP;
  return clamp(next, 0, MAX_VOLUME);
}

/** A level as it is shown: "85%". */
export function formatVolume(percent: number): string {
  return `${Math.round(percent)}%`;
}
