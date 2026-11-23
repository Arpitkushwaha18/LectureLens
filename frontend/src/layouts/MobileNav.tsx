import { X } from "lucide-react";
import { useEffect } from "react";

import { SidebarContent } from "./Sidebar";

type MobileNavProps = {
  open: boolean;
  onClose: () => void;
};

/**
 * Mobile navigation drawer. Mounted only while open, so the scroll lock,
 * focus trap and focus restoration all have a clear lifecycle.
 */
export function MobileNav({ open, onClose }: MobileNavProps) {
  if (!open) return null;

  return <Drawer onClose={onClose} />;
}

function Drawer({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    // React autofocus runs before this effect, so remember the menu trigger
    // rather than the newly focused close button that will be unmounted.
    const previouslyFocused = document.querySelector<HTMLElement>(
      'button[aria-controls="mobile-navigation"]',
    );
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;

    // Lock both roots: some mobile browsers ignore a body-only lock.
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    const focusableSelector = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab") return;

      const panel = document.getElementById("mobile-navigation");
      if (!panel) return;

      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        (element) => element.offsetParent !== null,
      );

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      // Keep Tab inside the dialog instead of reaching the page behind it.
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // If the window grows past the drawer breakpoint, close it so the page
    // never stays scroll-locked behind a drawer hidden by CSS.
    const desktopQuery = window.matchMedia("(min-width: 64rem)");
    const handleDesktopChange = () => {
      if (desktopQuery.matches) onClose();
    };

    document.addEventListener("keydown", handleKeyDown);
    desktopQuery.addEventListener("change", handleDesktopChange);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      desktopQuery.removeEventListener("change", handleDesktopChange);
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <div
        className="absolute inset-0 bg-ink/40"
        onClick={onClose}
        aria-hidden="true"
        role="presentation"
      />

      <div
        id="mobile-navigation"
        role="dialog"
        aria-modal="true"
        aria-label="Main navigation"
        className="drawer-panel absolute inset-y-0 left-0 flex w-[17rem] max-w-[calc(100vw_-_3rem)] flex-col overscroll-contain border-r border-rule bg-paper-deep shadow-lift"
      >
        <SidebarContent onNavigate={onClose} />

        <button
          type="button"
          onClick={onClose}
          autoFocus
          aria-label="Close navigation"
          className="absolute top-3 right-2 inline-flex size-11 items-center justify-center rounded-sm text-ink-muted transition-colors duration-150 hover:bg-rule/50 hover:text-ink"
        >
          <X className="size-5" strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
