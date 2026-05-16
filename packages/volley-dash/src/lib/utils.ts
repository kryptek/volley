import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Conventional shadcn/ui class-merge helper. Combines `clsx` (conditional
 * class composition) with `tailwind-merge` (last-class-wins conflict
 * resolution between Tailwind utility classes).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
