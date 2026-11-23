import {
  AlignLeft,
  BookOpen,
  FileQuestion,
  FileText,
  GitBranch,
  Layers,
  ListChecks,
  Play,
  Table2,
  type LucideIcon,
} from "lucide-react";

import type { GenerationOutputTypeV2 } from "@/lib/learning-contracts";
import type { WorkspaceSourceType } from "./workspace-model";

export const workspaceSources: { id: WorkspaceSourceType; label: string; icon: LucideIcon }[] = [
  { id: "youtube", label: "YouTube URL", icon: Play },
  { id: "pdf", label: "PDF upload", icon: FileText },
  { id: "spreadsheet", label: "Excel / CSV upload", icon: Table2 },
];

export const workspaceOutputs: {
  id: GenerationOutputTypeV2;
  label: string;
  description: string;
  icon: LucideIcon;
}[] = [
  {
    id: "detailed_notes",
    label: "Detailed notes",
    description: "Concepts, context & deeper understanding.",
    icon: BookOpen,
  },
  {
    id: "short_notes",
    label: "Short notes",
    description: "The essentials, ready for a quick revision.",
    icon: AlignLeft,
  },
  {
    id: "flashcards",
    label: "Flashcards",
    description: "Small questions. Stronger recall.",
    icon: Layers,
  },
  {
    id: "mcq_quiz",
    label: "MCQ quizzes",
    description: "Practice with answers & explanations.",
    icon: ListChecks,
  },
  {
    id: "mindmap",
    label: "Mind maps",
    description: "See the connections between concepts.",
    icon: GitBranch,
  },
  {
    id: "sample_question_paper",
    label: "Sample question papers",
    description: "AI-generated practice, not actual PYQs.",
    icon: FileQuestion,
  },
];
