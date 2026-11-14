import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { Tooltip } from "./tooltip";

interface MiddleTruncateProps {
  text: string;
  /**
   * How many characters of the end always stay visible (DESIGN.md §3): ten,
   * unless said otherwise. The end of a name is where one episode differs
   * from the next.
   */
  tail?: number;
  /**
   * What the tooltip says when the text is cut, if not the text itself: a
   * film's whole file name, extension and all.
   */
  full?: string | undefined;
  /**
   * No tooltip, for text nothing can point at (the on-screen display, which
   * the pointer passes through).
   */
  untouchable?: boolean;
  /**
   * Marks every element as a Tauri drag region. Tauri looks at the element
   * under the pointer itself, so a title in the title bar needs this to drag
   * the window while still being hoverable for its tooltip.
   */
  dragRegion?: boolean;
  className?: string;
}

/** Splits into user-perceived characters, so an emoji or a conjunct is never cut in half. */
function graphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

/** Hebrew, Arabic and their relatives: text whose width cannot be measured as a simple prefix. */
const RIGHT_TO_LEFT = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

/**
 * Truncates in the middle, so the end of a name stays readable:
 * `The Crossing S01E0…Departures`.
 *
 * Where the browser can measure text, the cut is made to fit exactly: as many
 * characters as there is room for, the ellipsis, then the end, with no gap
 * between them. (A CSS ellipsis cuts at whatever character fits and leaves up
 * to a character's width of nothing before the end.) Where it cannot, and
 * for right-to-left names, the head falls back to a CSS ellipsis.
 *
 * When something is cut off, the full text appears in a tooltip. Assistive
 * technology always gets the full text, once.
 */
export function MiddleTruncate({
  text,
  tail = 10,
  full,
  untouchable = false,
  dragRegion = false,
  className,
}: MiddleTruncateProps) {
  const outerRef = useRef<HTMLSpanElement>(null);
  const fullRef = useRef<HTMLSpanElement>(null);
  const dotsRef = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);
  /** How many characters of the head fit, once measured; `null` to leave it to CSS. */
  const [fit, setFit] = useState<number | null>(null);

  const parts = useMemo(() => graphemes(text), [text]);
  const kept = tail;
  const split = kept > 0 && parts.length > kept * 2;
  const headCount = split ? parts.length - kept : parts.length;
  const head = split ? parts.slice(0, headCount).join("") : text;
  const end = split ? parts.slice(headCount).join("") : "";

  // The classes are among what decides how wide the text is (its weight, its
  // size): a row that becomes the one playing turns semibold in place, and
  // what fitted before no longer does. So they are measured for, too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useLayoutEffect(() => {
    const outer = outerRef.current;
    const full = fullRef.current;
    if (!outer || !full) {
      return;
    }
    const measure = () => {
      // The room for text: padding (which an outlined label keeps for its outline) is not it.
      const style = getComputedStyle(outer);
      const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      // To the fraction of a pixel: a width rounded up would let the last
      // letter's edge run past the cell it is in.
      const box = outer.getBoundingClientRect().width;
      const available = (box > 0 ? box : outer.clientWidth) - padding;
      if (full.scrollWidth <= Math.ceil(available) + 1) {
        setTruncated(false);
        setFit(null);
        return;
      }
      setTruncated(true);

      const node = full.firstChild;
      const dots = dotsRef.current?.getBoundingClientRect().width ?? 0;
      if (!(node instanceof Text) || dots === 0 || RIGHT_TO_LEFT.test(text)) {
        setFit(null);
        return;
      }
      // Where each character starts in the string, for measuring prefixes of it.
      const starts = [0];
      for (const part of parts) {
        starts.push((starts.at(-1) ?? 0) + part.length);
      }
      const range = document.createRange();
      const widthOf = (from: number, to: number) => {
        range.setStart(node, from);
        range.setEnd(node, to);
        return range.getBoundingClientRect().width;
      };
      // A pixel is kept back: the pieces are measured apart, and set side by
      // side the letters at the joins sit a fraction differently.
      const room = available - dots - widthOf(starts[headCount] ?? 0, text.length) - 1;
      let low = 0;
      let high = headCount;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (widthOf(0, starts[middle] ?? 0) <= room) {
          low = middle;
        } else {
          high = middle - 1;
        }
      }
      setFit(low);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    return () => observer.disconnect();
  }, [text, parts, headCount, className]);

  const drag = dragRegion ? { "data-tauri-drag-region": true } : {};

  const shown = (
    // dir="auto": a right-to-left name keeps its own reading order.
    <span
      {...drag}
      ref={outerRef}
      dir="auto"
      className={cn("relative grid min-w-0 overflow-hidden", className)}
    >
      <span className="sr-only">{text}</span>
      {/*
        The whole text, unseen. It gives the element its width (as wide as
        the text, or as its container allows) whatever is shown on top of
        it, and it is what gets measured.
      */}
      <span
        ref={fullRef}
        aria-hidden="true"
        className="invisible col-start-1 row-start-1 min-w-0 overflow-hidden whitespace-pre"
      >
        {text}
      </span>
      <span ref={dotsRef} aria-hidden="true" className="invisible absolute whitespace-pre">
        …
      </span>
      <span
        {...drag}
        aria-hidden="true"
        // What is drawn, as against what is measured and what is read out.
        data-shown=""
        className="col-start-1 row-start-1 flex min-w-0 overflow-hidden"
      >
        {fit === null ? (
          <>
            <span {...drag} data-part="head" className="min-w-0 truncate whitespace-pre">
              {head}
            </span>
            {end ? (
              <span {...drag} data-part="tail" className="flex-none whitespace-pre">
                {end}
              </span>
            ) : null}
          </>
        ) : (
          <span {...drag} data-part="fitted" className="flex-none whitespace-pre">
            {parts.slice(0, fit).join("").trimEnd()}…{end}
          </span>
        )}
      </span>
    </span>
  );
  if (untouchable) {
    return shown;
  }
  // The tooltip wrapper is always present and only switched on when something
  // is cut off. Wrapping conditionally would remount the measured element.
  return (
    <Tooltip label={full ?? text} side="bottom" disabled={!truncated}>
      {shown}
    </Tooltip>
  );
}
