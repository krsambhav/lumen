import { describe, expect, it } from "vitest";
import { cn } from "./cn";

describe("cn", () => {
  it("keeps a type size and a text colour together", () => {
    expect(cn("text-body", "text-ink-2")).toBe("text-body text-ink-2");
  });

  it("lets a later size replace an earlier one", () => {
    expect(cn("text-body", "text-caption")).toBe("text-caption");
  });

  it("lets a later colour replace an earlier one", () => {
    expect(cn("text-ink-2", "text-accent")).toBe("text-accent");
  });

  it("resolves the design system's radius and duration scales", () => {
    expect(cn("rounded-sm", "rounded-md")).toBe("rounded-md");
    expect(cn("duration-fast", "duration-base")).toBe("duration-base");
  });

  it("treats a scrim as an image, not as a background colour", () => {
    expect(cn("bg-void", "bg-scrim-bottom")).toBe("bg-void bg-scrim-bottom");
    expect(cn("bg-scrim-bottom", "bg-scrim-top")).toBe("bg-scrim-top");
  });

  it("lets a later size override a named layout size, and the reverse", () => {
    expect(cn("h-titlebar", "h-8")).toBe("h-8");
    expect(cn("px-4", "px-gutter")).toBe("px-gutter");
    expect(cn("pb-titlebar", "pb-4")).toBe("pb-4");
  });

  it("lets a later animation replace an earlier one", () => {
    expect(cn("animate-fade-in", "animate-none")).toBe("animate-none");
    expect(cn("animate-rise-in", "animate-fade-out")).toBe("animate-fade-out");
  });

  it("drops falsy values", () => {
    expect(cn("a", false, null, undefined, "b")).toBe("a b");
  });
});
