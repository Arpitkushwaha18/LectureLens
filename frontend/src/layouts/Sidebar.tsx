import { NavLink } from "react-router-dom";

import { Wordmark } from "@/components/brand/Wordmark";
import { cn } from "@/lib/cn";
import { navGroups } from "@/lib/navigation";

export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-rule/80 px-4 py-4 lg:px-5 lg:py-5">
        <Wordmark className="min-h-11 lg:min-h-0" />
      </div>

      <nav
        aria-label="Main navigation"
        className="flex-1 overflow-y-auto overscroll-contain px-3 py-5 lg:py-6"
      >
        <div className="flex flex-col gap-6 lg:gap-7">
          {navGroups.map((group) => (
            <div key={group.id}>
              <p className="label-caps px-3">{group.label}</p>
              <ul className="mt-2 flex flex-col gap-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;

                  return (
                    <li key={item.to}>
                      <NavLink
                        to={item.to}
                        end={item.end}
                        onClick={onNavigate}
                        className={({ isActive }) =>
                          cn(
                            "group relative flex min-h-11 items-center gap-3 rounded-sm px-3 py-2.5 text-sm transition-colors duration-150 ease-paper lg:min-h-9 lg:py-2 lg:text-[13.5px]",
                            isActive
                              ? "bg-navy-soft/70 font-medium text-navy-deep"
                              : "text-ink-soft hover:bg-rule/35 hover:text-ink",
                          )
                        }
                      >
                        {({ isActive }) => (
                          <>
                            <span
                              aria-hidden="true"
                              className={cn(
                                "absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-navy transition-opacity duration-150",
                                isActive ? "opacity-100" : "opacity-0",
                              )}
                            />
                            <Icon
                              className={cn(
                                "size-[18px] shrink-0 transition-colors duration-150 lg:size-4",
                                isActive ? "text-navy" : "text-ink-muted group-hover:text-ink-soft",
                              )}
                              strokeWidth={1.7}
                              aria-hidden="true"
                            />
                            <span className="truncate">{item.label}</span>
                          </>
                        )}
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </nav>

      <div className="border-t border-rule/80 p-4">
        <div className="rounded-md border border-rule bg-surface/70 px-3.5 py-3">
          <p className="label-caps">Your study notebook</p>
          <p className="mt-1.5 text-[12.5px] leading-snug text-ink-soft">
            Bring a lecture, PDF or spreadsheet. UrTutor turns it into a little study set just for
            you.
          </p>
        </div>
      </div>
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-[17rem] border-r border-rule bg-paper-deep lg:block">
      <SidebarContent />
    </aside>
  );
}
