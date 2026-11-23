import type { ButtonHTMLAttributes, ComponentProps } from "react";
import { Link } from "react-router-dom";

import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost";
type Size = "sm" | "md" | "icon";

const base =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-[background-color,border-color,color,transform] duration-200 ease-paper disabled:pointer-events-none disabled:opacity-50";

const variants: Record<Variant, string> = {
  primary:
    "bg-navy text-surface shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] hover:bg-navy-deep active:translate-y-px",
  secondary:
    "border border-rule-strong bg-surface text-ink hover:border-navy/35 hover:bg-navy-soft/40 active:translate-y-px",
  ghost: "text-ink-soft hover:bg-rule/40 hover:text-ink",
};

// Mobile sizes stay at or above the 44px touch target; `sm` restores the
// tighter desktop metrics so the desktop design is unchanged.
const sizes: Record<Size, string> = {
  sm: "h-11 px-3 text-[13px] sm:h-8",
  md: "h-11 px-4 text-sm sm:h-10",
  icon: "size-11 shrink-0 p-0 sm:size-9",
};

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
};

export function Button({ variant = "primary", size = "md", className, ...props }: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(base, variants[variant], sizes[size], className)}
      {...props}
    />
  );
}

type ButtonLinkProps = ComponentProps<typeof Link> & {
  variant?: Variant;
  size?: Size;
};

export function ButtonLink({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ButtonLinkProps) {
  return <Link className={cn(base, variants[variant], sizes[size], className)} {...props} />;
}
