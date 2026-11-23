import { ArrowRight, GraduationCap } from "lucide-react";

import { ButtonLink } from "@/components/ui/Button";

export function Hero() {
  return (
    <section className="paper-panel ruled ruled-margin overflow-hidden">
      <div className="px-5 py-8 xs:px-6 xs:py-10 sm:py-14 sm:pr-12 sm:pl-20">
        <p className="label-caps flex items-center gap-2.5 text-[10px] tracking-[0.12em] xs:text-[11px] xs:tracking-[0.14em]">
          <span aria-hidden="true" className="h-px w-5 shrink-0 bg-terracotta/50 xs:w-6" />
          <span>A digital notebook for your semester</span>
        </p>

        <h1 className="mt-4 max-w-[36rem] text-[1.7rem] leading-[1.14] text-ink xs:text-[1.95rem] sm:mt-5 sm:text-[2.9rem] sm:leading-[1.1]">
          Turn lectures into notes you will actually revise.
        </h1>

        <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-ink-soft sm:mt-5">
          LectureLens is a quiet study space for your semester — organised notes and practice
          papers, built from the lectures and documents you already study from.
        </p>

        <p className="mt-6 flex w-fit max-w-full items-center gap-2 rounded-sm border border-rule bg-surface/80 px-2.5 py-1.5 text-[11.5px] leading-snug text-ink-soft xs:px-3 xs:text-[12px] sm:mt-8">
          <GraduationCap
            className="size-3.5 shrink-0 text-navy"
            strokeWidth={1.7}
            aria-hidden="true"
          />
          Starting with AKTU · B.Tech CSE · Semester 3
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-3 sm:mt-8">
          <ButtonLink to="/assistant" variant="primary">
            Meet UrTutor <ArrowRight className="size-4" aria-hidden="true" />
          </ButtonLink>
          <span className="text-xs text-ink-muted">Your material, beautifully organized</span>
        </div>
        <p className="margin-note mt-6 max-w-md text-[14px] leading-relaxed xs:text-[15px] sm:mt-8">
          One place for the whole semester, so revision stops feeling like starting over.
        </p>
      </div>
    </section>
  );
}
