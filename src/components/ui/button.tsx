import { cva, type VariantProps } from "class-variance-authority";
import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/cn";

const buttonVariants = cva(
  [
    "relative inline-flex flex-none select-none items-center justify-center gap-2 whitespace-nowrap",
    "rounded-sm text-body font-medium",
    "transition-[background-color,color,transform,opacity] duration-fast ease-out",
    "motion-safe:active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45",
  ],
  {
    variants: {
      variant: {
        /**
         * One per view. The fill is the bright accent in both themes; the
         * ring is the accent ink, which gives it an edge on a light window
         * and disappears into the fill on a dark one.
         */
        primary:
          "bg-accent-fill text-accent-fg ring-1 ring-inset ring-accent hover:bg-accent-fill-hover active:bg-accent-fill-hover",
        secondary:
          "border border-line bg-surface-3 text-ink-1 hover:bg-surface-4 active:bg-surface-4",
        ghost: "text-ink-2 hover:bg-surface-3 hover:text-ink-1 active:bg-surface-4",
        /** The destructive choice. Never the only signal: its label says what is destroyed. */
        danger: "text-danger hover:bg-surface-3 active:bg-surface-4",
      },
      size: {
        sm: "h-7 px-3",
        md: "h-8 px-4",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /**
   * Work is in progress. The label gives way to a working indicator, the
   * button keeps its width and its name, and it ignores activation until the
   * work is done.
   */
  busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, busy = false, children, type, onClick, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(buttonVariants({ variant, size }), className)}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      onClick={(event) => {
        // Covers the pointer and the keyboard alike.
        if (busy) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      {...props}
    >
      {/* Transparent rather than hidden while busy: hidden text would take the name with it. */}
      <span className={cn("inline-flex items-center gap-2", busy && "opacity-0")}>{children}</span>
      {busy ? (
        // An indeterminate scale: a needle travelling along a short hairline.
        <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
          <span className="relative h-2.5 w-5">
            <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-current opacity-40" />
            <span className="absolute left-0 top-0 h-full w-0.5 animate-sweep rounded-xs bg-current" />
          </span>
        </span>
      ) : null}
    </button>
  );
});
