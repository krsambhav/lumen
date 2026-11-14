import { CircleAlert } from "lucide-react";
import { forwardRef, type InputHTMLAttributes, useId } from "react";
import { cn } from "@/lib/cn";

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "aria-invalid"> {
  /** Always visible: a placeholder is an example, not a label (DESIGN.md §7). */
  label: string;
  /** Said below the field, in place of the hint, with an icon. */
  error?: string | undefined;
  /** A line of guidance below the field. */
  hint?: string | undefined;
}

/** A labelled text field. */
export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, error, hint, className, id, ...props },
  ref,
) {
  const generated = useId();
  const fieldId = id ?? generated;
  const noteId = `${fieldId}-note`;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <label htmlFor={fieldId} className="text-caption text-ink-2">
        {label}
      </label>
      <input
        ref={ref}
        id={fieldId}
        type="text"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? noteId : undefined}
        className={cn(
          "h-8 min-w-0 rounded-sm border bg-surface-1 px-2 text-body text-ink-1",
          error ? "border-danger" : "border-line-strong",
        )}
        {...props}
      />
      {error ? (
        <p id={noteId} role="alert" className="flex items-start gap-1 text-caption text-danger">
          <CircleAlert aria-hidden="true" className="mt-px size-3.5 flex-none" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      ) : hint ? (
        <p id={noteId} className="break-words text-caption text-ink-2">
          {hint}
        </p>
      ) : null}
    </div>
  );
});
