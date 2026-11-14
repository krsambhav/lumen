/**
 * Timecodes, for the eye and for the ear (DESIGN.md §3).
 *
 * Shown as `0:42:17`, with hours only when the media runs an hour or longer,
 * so every timecode on screen has the same shape and tabular numerals keep it
 * from shifting as it counts.
 */

function clampSeconds(seconds: number): number {
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/**
 * How close under a whole second a time may be and still count as it. A
 * frame's time is rarely a whole second: asked for 5:00, a player shows the
 * frame nearest it, which can be a thousandth before, and that frame is
 * "5:00" to anyone watching. The player's own exact seek allows the same.
 */
const FRAME_SLACK = 0.005;

/** The second a time falls in, as every timecode on screen counts it. */
export function wholeSecond(seconds: number): number {
  return Math.floor(clampSeconds(seconds) + FRAME_SLACK);
}

/**
 * Formats `seconds` as `m:ss` or `h:mm:ss`. `span` is the length of the media
 * the time belongs to; it decides whether hours are shown, so `0:05` and
 * `1:42:17` never sit side by side in one display.
 */
export function formatTimecode(seconds: number, span: number = seconds): string {
  const whole = wholeSecond(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (clampSeconds(span) >= 3600 || hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(secs)}`;
  }
  return `${minutes}:${pad(secs)}`;
}

function count(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

/** A length of time in words: "1 hour 2 minutes 5 seconds". */
export function spokenDuration(seconds: number): string {
  const whole = Math.round(clampSeconds(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(count(hours, "hour"));
  }
  if (minutes > 0) {
    parts.push(count(minutes, "minute"));
  }
  // Seconds are dropped from long times unless they are all there is.
  if (secs > 0 && hours === 0) {
    parts.push(count(secs, "second"));
  }
  return parts.length > 0 ? parts.join(" ") : "0 seconds";
}

/** A position within a length, in words: "42 minutes of 2 hours 1 minute". */
export function spokenPosition(seconds: number, duration: number | null): string {
  if (duration === null || duration <= 0) {
    return spokenDuration(seconds);
  }
  return `${spokenDuration(seconds)} of ${spokenDuration(duration)}`;
}

/** A length of time, short, for a line of metadata: "1 h 19 min", "42 min", "58 s". */
export function shortDuration(seconds: number): string {
  const whole = Math.round(clampSeconds(seconds));
  if (whole < 60) {
    return `${whole} s`;
  }
  // Rounded to the minute first, so 59 minutes 59 seconds is an hour and not "60 min".
  const total = Math.round(whole / 60);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) {
    return `${minutes} min`;
  }
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

const NUMBER = String.raw`\d+(?:[.,]\d+)?`;
const HOURS = "h|hr|hrs|hours?";
const MINUTES = "m|min|mins|minutes?";
const SECONDS = "s|sec|secs|seconds?";

function numberOf(text: string | undefined): number {
  return Number((text ?? "0").replace(",", "."));
}

/** A length of time written with a clock's colons or with units: "1:30", "90m", "1h30", "1.5h". */
function parseSpan(typed: string): number | null {
  const clock = /^(?:(\d+):)?(\d{1,3}):(\d{1,2})$/.exec(typed);
  if (clock) {
    const [hours, minutes, seconds] = [clock[1] ?? "0", clock[2] ?? "0", clock[3] ?? "0"].map(
      Number,
    );
    if ((seconds ?? 0) >= 60 || (clock[1] !== undefined && (minutes ?? 0) >= 60)) {
      return null;
    }
    return (hours ?? 0) * 3600 + (minutes ?? 0) * 60 + (seconds ?? 0);
  }
  // One figure with its unit, which may be a fraction: "1.5h", "90 min", "45s".
  const single = new RegExp(`^(${NUMBER})\\s*(?:(${HOURS})|(${MINUTES})|(${SECONDS}))$`).exec(
    typed,
  );
  if (single) {
    const size = single[2] ? 3600 : single[3] ? 60 : 1;
    return numberOf(single[1]) * size;
  }
  // Several, largest first; the unit of the last may be left off: "1h20m5s", "1h30", "2m 30".
  const units = new RegExp(
    `^(?:(\\d+)\\s*(?:${HOURS})\\s*)?(?:(\\d+)\\s*(?:${MINUTES})\\s*)?(?:(\\d+)\\s*(?:${SECONDS})?)?$`,
  ).exec(typed);
  if (units && (units[1] ?? units[2]) !== undefined) {
    // A figure with no unit after hours is minutes; after minutes, seconds.
    const [hours, minutes, last] = [units[1], units[2], units[3]];
    if (last !== undefined && minutes === undefined && !new RegExp(`(?:${SECONDS})$`).test(typed)) {
      return Number(hours) * 3600 + Number(last) * 60;
    }
    return Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(last ?? 0);
  }
  return null;
}

/**
 * Reads a time someone typed: "1:23:45", "83:45", "90m", "1h20m", "1h30",
 * "1.5h", "45s", or "25%" of `duration`. Returns seconds, or `null` if it
 * is not a time. A bare number is not one: it is as likely to be part of a
 * name. (Asked for a time and nothing else, see `readTimes`.)
 */
export function parseTime(text: string, duration: number | null): number | null {
  const typed = text.trim().toLowerCase();
  if (typed === "") {
    return null;
  }
  const percent = new RegExp(`^(${NUMBER})\\s*%$`).exec(typed);
  if (percent) {
    const share = numberOf(percent[1]) / 100;
    return duration !== null && share <= 1 ? share * duration : null;
  }
  return parseSpan(typed);
}

/**
 * Every place in the film that what was typed could mean, the likeliest
 * first, for a field that asks for a time and nothing else (DESIGN.md §7).
 * Besides what `parseTime` reads: a step from where the film is ("+30",
 * "-2m", "+1:30"), and a bare number, which is read both as minutes and as
 * seconds. In a film of an hour or more minutes are the likelier; in
 * anything shorter, seconds.
 */
export function readTimes(
  text: string,
  film: { duration: number | null; position: number },
): number[] {
  const typed = text.trim().toLowerCase();
  if (typed === "") {
    return [];
  }
  const step = /^([+\-−])\s*(.+)$/.exec(typed);
  if (step) {
    const amount = step[2] ?? "";
    const size = /^\d+(?:[.,]\d+)?$/.test(amount) ? numberOf(amount) : parseSpan(amount);
    if (size === null) {
      return [];
    }
    const to = film.position + (step[1] === "+" ? size : -size);
    return [Math.max(0, to)];
  }
  if (/^\d+(?:[.,]\d+)?$/.test(typed)) {
    const figure = numberOf(typed);
    const readings =
      film.duration === null || film.duration >= 3600
        ? [figure * 60, figure]
        : [figure, figure * 60];
    return [...new Set(readings)];
  }
  const exact = parseTime(typed, film.duration);
  return exact === null ? [] : [exact];
}
