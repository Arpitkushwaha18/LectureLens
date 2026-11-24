import { Route, Routes, Navigate } from "react-router-dom";
import { lazy, Suspense } from "react";

import { AppShell } from "@/layouts/AppShell";
import { HomePage } from "@/pages/HomePage";
import { NotFoundPage } from "@/pages/NotFoundPage";
const AIWorkspacePage = lazy(() =>
  import("@/pages/AIWorkspacePage").then((m) => ({ default: m.AIWorkspacePage })),
);
const TutorPage = lazy(() => import("@/pages/TutorPage").then((m) => ({ default: m.TutorPage })));
const GalleryPage = lazy(() =>
  import("@/pages/GalleryPage").then((m) => ({ default: m.GalleryPage })),
);
const AdminPage = lazy(() => import("@/pages/AdminPage").then((m) => ({ default: m.AdminPage })));

/**
 * Route table. Every section in the sidebar resolves to a real page —
 * a dedicated learning experience. Public resource reads never require sign-in.
 */
export function AppRoutes() {
  return (
    <Suspense
      fallback={
        <p role="status" className="p-6">
          Opening your study desk…
        </p>
      }
    >
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<HomePage />} />

          <Route path="assistant" element={<AIWorkspacePage />} />
          <Route path="ask" element={<TutorPage />} />
          <Route path="gallery" element={<GalleryPage />} />
          <Route path="admin" element={<AdminPage />} />

          <Route path="flashcards" element={<Navigate to="/assistant" replace />} />

          <Route path="quizzes" element={<Navigate to="/assistant" replace />} />

          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
