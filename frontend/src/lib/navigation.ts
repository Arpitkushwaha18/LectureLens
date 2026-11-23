import { Home, Sparkles, type LucideIcon } from "lucide-react";

export type NavItem = {
  label: string;
  to: string;
  icon: LucideIcon;
  /** Match the path exactly (used for "/" so it is not active everywhere). */
  end?: boolean;
  blurb: string;
};

export type NavGroup = {
  id: string;
  label: string;
  items: NavItem[];
};

/**
 * Single source of truth for primary navigation.
 * The sidebar, mobile drawer and document titles all read from here,
 * so adding a section later is a one-line change.
 */
export const navGroups: NavGroup[] = [
  {
    id: "study",
    label: "Study",
    items: [{ label: "Home", to: "/", icon: Home, end: true, blurb: "Your desk" }],
  },
  {
    id: "create",
    label: "Create",
    items: [
      {
        label: "UrTutor",
        to: "/assistant",
        icon: Sparkles,
        blurb: "Choose material and study outputs",
      },
    ],
  },
];

export const allNavItems: NavItem[] = navGroups.flatMap((group) => group.items);

export function findNavItem(pathname: string): NavItem | undefined {
  if (pathname === "/ask")
    return { label: "Ask UrTutor", to: "/ask", icon: Sparkles, blurb: "Your question" };
  return allNavItems.find((item) =>
    item.end ? pathname === item.to : pathname.startsWith(item.to),
  );
}
