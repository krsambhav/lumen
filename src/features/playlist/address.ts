/**
 * Reading an address that was typed or pasted: a link to a video site's
 * page, to a media file, or to a stream.
 *
 * A full address ("https://…", "rtsp://…") is taken as it is. One without
 * its scheme ("youtube.com/watch?v=…", "www.example.org/film.mp4") is taken
 * as https, which is what a browser would do with it.
 */

const WITH_SCHEME = /^[a-z][a-z0-9+.-]*:\/\/[^\s/?#]+\S*$/i;
/**
 * A host name with at least one dot and a top-level domain of letters, then
 * an optional port, and a path. Without the path it must start "www.":
 * "Film.mkv" is the name of a file, not of a site.
 */
const BARE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{1,5})?[/?#]\S*$/i;
const BARE_HOST = /^www\.(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{1,5})?$/i;

/** The address `text` names, ready to open, or `null` if it is not one. */
export function readAddress(text: string): string | null {
  const typed = text.trim();
  if (typed === "" || /\s/.test(typed)) {
    return null;
  }
  if (WITH_SCHEME.test(typed)) {
    // A file on this Mac is a file, not an address; it is opened by path.
    return /^file:/i.test(typed) ? null : typed;
  }
  return BARE.test(typed) || BARE_HOST.test(typed) ? `https://${typed}` : null;
}

/** An address as a person reads it: no scheme, no "www.", no trailing slash. */
export function shortAddress(address: string): string {
  return address
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/$/, "");
}
