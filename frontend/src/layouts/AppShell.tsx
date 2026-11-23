import { useCallback, useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";

import { findNavItem } from "@/lib/navigation";
import { MobileNav } from "./MobileNav";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

export function AppShell() {
  const { pathname } = useLocation();

  // The drawer remembers which path it was opened on. Navigating changes the
  // path, which closes it — derived state instead of an effect.
  const [navOpenAtPath, setNavOpenAtPath] = useState<string | null>(null);
  const navOpen = navOpenAtPath === pathname;

  const openNav = useCallback(() => setNavOpenAtPath(pathname), [pathname]);
  const closeNav = useCallback(() => setNavOpenAtPath(null), []);

  // Keep the browser tab title in sync with the current section.
  useEffect(() => {
    const item = findNavItem(pathname);
    if (!item) {
      document.title = "Page not found · LectureLens";
    } else if (item.to === "/") {
      document.title = "LectureLens — Your study companions";
    } else {
      document.title = `${item.label} · LectureLens`;
    }
  }, [pathname]);

  return (
    <div className="min-h-dvh bg-paper">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[60] focus:rounded-md focus:bg-navy focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-surface"
      >
        Skip to content
      </a>

      <Sidebar />
      <MobileNav open={navOpen} onClose={closeNav} />

      <div className="lg:pl-[17rem]">
        <Topbar navOpen={navOpen} onOpenNav={openNav} />

        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-6xl px-4 pt-6 pb-16 sm:px-8 sm:pt-12 sm:pb-20"
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
