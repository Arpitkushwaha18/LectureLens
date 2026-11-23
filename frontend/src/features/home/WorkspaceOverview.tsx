import { BookOpen, FileText, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { SectionHeading } from "@/components/ui/SectionHeading";

const capabilities = [
  {
    icon: BookOpen,
    title: "Detailed and short notes",
    description:
      "A full explanation for understanding, plus a compressed version for the night before.",
  },
  {
    icon: FileText,
    title: "Sample examination papers",
    description: "Full-length practice papers shaped like the ones you will actually sit.",
  },
  {
    icon: Sparkles,
    title: "Academic study assistant",
    description: "A companion for subject questions, kept strictly inside academic topics.",
  },
];

export function WorkspaceOverview() {
  return (
    <section aria-labelledby="workspace-heading">
      <SectionHeading
        titleId="workspace-heading"
        eyebrow="Inside the workspace"
        title="One study space, not five disconnected tools"
        description="Notes, revision and practice are meant to sit next to each other, organised by the semester you are actually in."
      />

      <div className="mt-6 grid gap-5 sm:mt-8 lg:grid-cols-[1.1fr_0.9fr]">
        <Card className="overflow-hidden">
          <ul className="divide-y divide-rule/70">
            {capabilities.map(({ icon: Icon, title, description }) => (
              <li key={title} className="flex gap-3.5 px-4 py-3.5 xs:gap-4 xs:px-5 xs:py-4">
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-sm border border-rule bg-paper text-navy"
                >
                  <Icon className="size-4" strokeWidth={1.6} />
                </span>
                <div>
                  <p className="text-[13.5px] font-medium text-ink xs:text-[14px]">{title}</p>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-soft">
                    {description}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <div className="flex flex-col gap-5">
          <Card tone="flat" className="p-4 xs:p-5">
            <p className="label-caps">Where we are</p>

            <div className="mt-4 space-y-4">
              <div>
                <Badge tone="olive">Live now</Badge>
                <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
                  Learn from PDFs and spreadsheets, then download a handwritten study notebook.
                </p>
              </div>

              <div>
                <Badge tone="navy">Next</Badge>
                <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
                  Paste a YouTube lecture with a transcript. UrTutor checks it before preparing your
                  study set.
                </p>
              </div>

              <div>
                <Badge dashed>Your learning</Badge>
                <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
                  Choose deeper notes, quick revision or practice papers.
                </p>
              </div>
            </div>
          </Card>

          <div className="ruled-margin rounded-lg border border-rule bg-surface/60 px-4 py-3.5 xs:px-5 xs:py-4 sm:pl-16">
            <p className="margin-note text-[14px] leading-relaxed">
              Built one milestone at a time, so every part actually works before the next one
              begins.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
