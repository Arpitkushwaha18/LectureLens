import { ArrowUpRight, type LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/Badge";

type LearningSourceCardProps = {
  icon: LucideIcon;
  title: string;
  description: string;
  meta: string;
  to: string;
};

/**
 * All sources lead to the same workspace. The preview badge distinguishes
 * working local selection from the not-yet-connected generation pipeline.
 */
export function LearningSourceCard({
  icon: Icon,
  title,
  description,
  meta,
  to,
}: LearningSourceCardProps) {
  return (
    <Link
      to={to}
      className="flex h-full flex-col rounded-lg border border-rule bg-surface p-4 shadow-paper transition-colors duration-200 ease-paper hover:border-navy/40 xs:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <span
          aria-hidden="true"
          className="flex size-9 items-center justify-center rounded-sm border border-rule bg-paper text-navy xs:size-10"
        >
          <Icon className="size-[18px]" strokeWidth={1.6} />
        </span>
        <Badge dashed>Start learning</Badge>
      </div>

      <h3 className="mt-4 text-[17.5px] leading-snug text-ink xs:mt-5 xs:text-[19px]">{title}</h3>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-soft xs:text-[13.5px]">
        {description}
      </p>

      <p className="mt-4 flex items-center justify-between gap-2 border-t border-rule/70 pt-3 text-[12px] text-ink-muted">
        {meta}
        <ArrowUpRight className="size-4 shrink-0" aria-hidden="true" />
      </p>
    </Link>
  );
}
