import { Badge } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";

type ComingSoonPageProps = {
  eyebrow: string;
  title: string;
  description: string;
  planned: string;
  items: string[];
};

/**
 * Honest placeholder for a section that is planned but not built.
 * It explains what will live here instead of showing empty widgets.
 */
export function ComingSoonPage({
  eyebrow,
  title,
  description,
  planned,
  items,
}: ComingSoonPageProps) {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="paper-panel ruled-margin overflow-hidden">
        <div className="px-5 py-8 xs:px-6 xs:py-10 sm:py-12 sm:pr-10 sm:pl-20">
          <Badge dashed>{planned}</Badge>

          <p className="label-caps mt-5 xs:mt-6">{eyebrow}</p>
          <h1 className="mt-2.5 text-[1.65rem] leading-tight xs:mt-3 xs:text-[1.9rem] sm:text-[2.4rem]">
            {title}
          </h1>
          <p className="mt-3.5 max-w-xl text-[15px] leading-relaxed text-ink-soft xs:mt-4">
            {description}
          </p>

          <div className="mt-6 border-t border-rule pt-5 xs:mt-8 xs:pt-6">
            <p className="label-caps">What will live here</p>
            <ul className="mt-3 grid gap-2.5 sm:grid-cols-2">
              {items.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-[13.5px] text-ink-soft">
                  <span
                    aria-hidden="true"
                    className="mt-[7px] size-1 shrink-0 rounded-full bg-terracotta/70"
                  />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-6 xs:mt-8">
            <ButtonLink to="/">Back to your desk</ButtonLink>
          </div>
        </div>
      </div>
    </div>
  );
}
