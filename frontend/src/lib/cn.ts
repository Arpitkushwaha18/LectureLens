import { clsx, type ClassValue } from "clsx";

/**
 * Conditional class names. We deliberately avoid `tailwind-merge`:
 * our components own their class lists, so conflicts are a code smell
 * rather than something to silently patch at runtime.
 */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
