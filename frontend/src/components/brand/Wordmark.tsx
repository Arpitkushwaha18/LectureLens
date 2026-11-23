import { Link } from "react-router-dom";

import { cn } from "@/lib/cn";

export function Wordmark({ className }: { className?: string }) {
  return (
    <Link
      to="/"
      className={cn(
        "group inline-flex items-center gap-2.5 rounded-sm",
        "transition-opacity duration-200 ease-paper hover:opacity-85",
        className,
      )}
    >
      <span className="text-navy">
        <svg
          viewBox="0 0 32 32"
          className="size-7"
          fill="none"
          aria-hidden="true"
          focusable="false"
        >
          <rect
            x="5.25"
            y="4.25"
            width="15.5"
            height="23.5"
            rx="2.25"
            className="fill-surface stroke-navy"
            strokeWidth="1.5"
          />
          <path
            d="M9.5 10.5h7M9.5 14.5h7M9.5 18.5h4.5"
            className="stroke-navy"
            strokeWidth="1.3"
            strokeLinecap="round"
            opacity="0.45"
          />
          <circle
            cx="21.25"
            cy="21.25"
            r="5.5"
            className="fill-surface stroke-terracotta"
            strokeWidth="1.7"
          />
        </svg>
      </span>

      <span className="flex flex-col leading-none">
        <span className="font-serif text-[17px] tracking-tight text-ink">LectureLens</span>
        <span className="mt-1 text-[10px] font-medium tracking-[0.18em] text-ink-muted uppercase">
          Academic workspace
        </span>
      </span>
    </Link>
  );
}
