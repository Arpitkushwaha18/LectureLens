import { useLocation } from "react-router-dom";
import { TutorChat } from "@/features/workspace/TutorChat";

export function TutorPage() {
  const location = useLocation();
  const prompt = typeof location.state?.prompt === "string" ? location.state.prompt : "";
  return <TutorChat key={location.key} initialPrompt={prompt} />;
}
