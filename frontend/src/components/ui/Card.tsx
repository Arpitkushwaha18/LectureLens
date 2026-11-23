import type { HTMLAttributes } from "react";

import { cn } from "@/lib/cn";

type CardProps = HTMLAttributes<HTMLDivElement> & {
  /** `paper` lifts off the page; `flat` stays flush with the notebook. */
  tone?: "paper" | "flat";
};

export function Card({ tone = "paper", className, ...props }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border",
        tone === "paper"
          ? "border-rule bg-surface shadow-paper"
          : "border-rule/70 bg-paper-deep/40",
        className,
      )}
      {...props}
    />
  );
}
