import { Route, Routes, Navigate } from "react-router-dom";

import { AppShell } from "@/layouts/AppShell";
import { AIWorkspacePage } from "@/pages/AIWorkspacePage";
import { HomePage } from "@/pages/HomePage";
import { NotFoundPage } from "@/pages/NotFoundPage";
import { TutorPage } from "@/pages/TutorPage";

/**
 * Route table. Every section in the sidebar resolves to a real page —
 * a dedicated learning experience. No public resource feed.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />

        <Route path="assistant" element={<AIWorkspacePage />} />
        <Route path="ask" element={<TutorPage />} />

        <Route path="flashcards" element={<Navigate to="/assistant" replace />} />

        <Route path="quizzes" element={<Navigate to="/assistant" replace />} />

        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
