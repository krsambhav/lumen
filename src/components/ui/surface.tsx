import { createContext, useContext } from "react";

/**
 * Where a control is, which decides two things: its tokens and its build.
 *
 * - `app`: the window's own theme.
 * - `stage`: over the picture. Dark tokens in either theme, and the larger,
 *   translucent controls that sit on video.
 * - `panel`: beside the picture. The stage's dark tokens, since it stands
 *   next to a film, but ordinary controls, since nothing is behind it.
 *
 * Tooltips, menus and popovers are portalled to `<body>`, outside the element
 * that carries the `.stage` class, so they cannot inherit the dark tokens
 * through CSS. Components that open overlays read this context and put the
 * class on the portalled content themselves.
 */
export type Surface = "app" | "stage" | "panel";

const SurfaceContext = createContext<Surface>("app");

export const SurfaceProvider = SurfaceContext.Provider;

export function useSurface(): Surface {
  return useContext(SurfaceContext);
}

/** The class a portalled overlay needs to match the surface it was opened from. */
export function useSurfaceClass(): string | undefined {
  return useSurface() === "app" ? undefined : "stage";
}
