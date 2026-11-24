import { Menu } from "lucide-react";
import { useLocation } from "react-router-dom";

import { HealthStatus } from "@/components/HealthStatus";
import { findNavItem, navGroups } from "@/lib/navigation";

type TopbarProps = {
  navOpen: boolean;
  onOpenNav: () => void;
};

export function Topbar({ navOpen, onOpenNav }: TopbarProps) {
  const { pathname } = useLocation();
  const item = findNavItem(pathname);
  const group = navGroups.find((candidate) =>
    candidate.items.some((navItem) => navItem.label === item?.label),
  );

  return (
    <header className="sticky top-0 z-30 border-b border-rule bg-paper">
      <div className="flex min-h-14 items-center gap-2 px-4 py-1 sm:h-16 sm:gap-3 sm:px-8 sm:py-0">
        <button
          type="button"
          onClick={onOpenNav}
          aria-label="Open navigation"
          aria-expanded={navOpen}
          aria-controls="mobile-navigation"
          className="-ml-2 inline-flex size-11 shrink-0 items-center justify-center rounded-sm text-ink-soft transition-colors duration-150 ease-paper hover:bg-rule/40 hover:text-ink lg:hidden"
        >
          <Menu className="size-5" strokeWidth={1.8} aria-hidden="true" />
        </button>

        <div className="min-w-0 flex-1">
          <p className="font-serif text-base leading-snug text-ink sm:truncate sm:text-[17px]">
            {item?.label ?? "Page not found"}
          </p>
          {group ? (
            <p className="mt-0.5 hidden text-[10px] font-medium tracking-[0.16em] text-ink-muted uppercase sm:block">
              {group.label}
            </p>
          ) : null}
        </div>

        <HealthStatus />
      </div>
    </header>
  );
}
