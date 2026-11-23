import { FileText, Info, Play, Table2 } from "lucide-react";

import { SectionHeading } from "@/components/ui/SectionHeading";
import { LearningSourceCard } from "./LearningSourceCard";

const sources = [
  {
    icon: Play,
    title: "YouTube lecture",
    description:
      "Paste a lecture link and turn the transcript into structured notes, key terms and practice questions.",
    meta: "YouTube URL",
    to: "/assistant?source=youtube",
  },
  {
    icon: FileText,
    title: "PDF document",
    description:
      "Upload lecture slides, textbook chapters or your own notes for summaries and study sets.",
    meta: "PDF file",
    to: "/assistant?source=pdf",
  },
  {
    icon: Table2,
    title: "Excel or CSV",
    description:
      "Bring in question banks or tabular material and shape the rows into revision content.",
    meta: "XLSX / XLS / CSV",
    to: "/assistant?source=spreadsheet",
  },
];

export function StartLearningSection() {
  return (
    <section aria-labelledby="start-learning-heading">
      <SectionHeading
        titleId="start-learning-heading"
        eyebrow="Start here"
        title="Bring in what you already study from"
        description="Three starting points. One AI learning workspace. Choose your source, then shape your own study set."
      />

      <div className="mt-6 grid gap-4 sm:mt-8 sm:grid-cols-2 lg:grid-cols-3">
        {sources.map((source) => (
          <LearningSourceCard
            key={source.title}
            icon={source.icon}
            title={source.title}
            description={source.description}
            meta={source.meta}
            to={source.to}
          />
        ))}
      </div>

      <p className="mt-4 flex max-w-2xl items-start gap-2 text-[12.5px] leading-relaxed text-ink-muted sm:mt-5">
        <Info className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.7} aria-hidden="true" />
        Explore the workspace and select your material locally. Uploads, extraction and AI
        generation are not connected yet.
      </p>
    </section>
  );
}
