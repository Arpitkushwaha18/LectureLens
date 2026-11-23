import { Hero } from "@/features/home/Hero";
import { StartLearningSection } from "@/features/home/StartLearningSection";
import { WorkspaceOverview } from "@/features/home/WorkspaceOverview";

export function HomePage() {
  return (
    <div className="space-y-12 sm:space-y-20">
      <Hero />
      <StartLearningSection />
      <WorkspaceOverview />
    </div>
  );
}
