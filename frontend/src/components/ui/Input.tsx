import { useId, type InputHTMLAttributes, type ReactNode } from "react";

import { cn } from "@/lib/cn";

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  label: string;
  hint?: ReactNode;
  error?: string;
};

/**
 * Labelled text input with hint + error states.
 * Not rendered anywhere yet — it exists so forms in later phases
 * (uploads, assistant) share one accessible implementation.
 */
export function Input({ label, hint, error, className, ...props }: InputProps) {
  const generatedId = useId();
  const inputId = `input-${generatedId}`;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-[13px] font-medium text-ink">
        {label}
      </label>

      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={cn(hintId, errorId) || undefined}
        className={cn(
          "h-11 w-full rounded-md border bg-surface px-3 text-sm text-ink sm:h-10",
          "placeholder:text-ink-muted/70",
          "transition-colors duration-200 ease-paper",
          error
            ? "border-terracotta focus-visible:outline-terracotta"
            : "border-rule-strong hover:border-navy/30 focus:border-navy",
          className,
        )}
        {...props}
      />

      {hint && !error ? (
        <p id={hintId} className="text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}

      {error ? (
        <p id={errorId} className="text-xs font-medium text-terracotta-deep">
          {error}
        </p>
      ) : null}
    </div>
  );
}
