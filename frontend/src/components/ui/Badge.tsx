import type { HTMLAttributes } from "react";

import { cn } from "@/lib/cn";

type Tone = "neutral" | "navy" | "terracotta" | "olive";

const tones: Record<Tone, string> = {
  neutral: "border-rule-strong text-ink-muted",
  navy: "border-navy/25 bg-navy-soft/60 text-navy-deep",
  terracotta: "border-terracotta/25 bg-terracotta-soft/70 text-terracotta-deep",
  olive: "border-olive/25 bg-olive-soft text-olive",
};

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: Tone;
  dashed?: boolean;
};

export function Badge({ tone = "neutral", dashed = false, className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-xs border px-2 py-1 text-[11px] font-semibold tracking-[0.12em] uppercase sm:text-[10px]",
        dashed && "border-dashed",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
