import { cn } from "@/lib/cn";

type SectionHeadingProps = {
  eyebrow: string;
  title: string;
  description?: string;
  titleId?: string;
  className?: string;
};

export function SectionHeading({
  eyebrow,
  title,
  description,
  titleId,
  className,
}: SectionHeadingProps) {
  return (
    <div className={cn("max-w-2xl", className)}>
      <p className="label-caps flex items-center gap-2.5">
        <span aria-hidden="true" className="h-px w-6 shrink-0 bg-terracotta/50" />
        {eyebrow}
      </p>
      <h2 id={titleId} className="mt-2.5 text-[1.4rem] xs:text-2xl sm:mt-3 sm:text-[1.75rem]">
        {title}
      </h2>
      {description ? (
        <p className="mt-2.5 text-sm leading-relaxed text-ink-soft sm:mt-3 sm:text-[15px]">
          {description}
        </p>
      ) : null}
    </div>
  );
}
