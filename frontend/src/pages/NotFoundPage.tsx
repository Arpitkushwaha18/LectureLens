import { ButtonLink } from "@/components/ui/Button";

export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <div className="paper-panel px-5 py-10 text-center xs:px-6 xs:py-12 sm:px-10">
        <p className="label-caps">404</p>
        <h1 className="mt-3 text-[1.65rem] leading-tight xs:text-3xl sm:text-4xl">
          This page is not in the notebook.
        </h1>
        <p className="mx-auto mt-4 max-w-md text-[15px] leading-relaxed text-ink-soft">
          The address you followed does not match any section of LectureLens. It may have been
          renamed, or it may belong to a milestone that has not shipped yet.
        </p>
        <div className="mt-6 flex justify-center xs:mt-8">
          <ButtonLink to="/" variant="primary">
            Back to your desk
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
