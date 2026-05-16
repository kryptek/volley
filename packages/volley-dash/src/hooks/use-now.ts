/**
 * Single per-second tick source. The dashboard root reads this once and
 * fans `now` out via context so individual cards / feed rows don't each
 * carry their own `setInterval` for relTime formatting.
 */
import { useEffect, useState } from "react";

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(handle);
    };
  }, [intervalMs]);
  return now;
}
