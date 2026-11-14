import { type RenderResult, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { type Surface, SurfaceProvider } from "@/components/ui/surface";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * Renders UI inside the providers every component can rely on. They are
 * passed as a wrapper, so `rerender` keeps them.
 */
export function renderUi(
  ui: ReactElement,
  { surface = "app" }: { surface?: Surface } = {},
): RenderResult {
  return render(ui, {
    wrapper: ({ children }) => (
      <SurfaceProvider value={surface}>
        <TooltipProvider>{children}</TooltipProvider>
      </SurfaceProvider>
    ),
  });
}
