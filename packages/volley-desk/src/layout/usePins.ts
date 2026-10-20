/**
 * The window pins (C12, `pins.ts`) for this device class, kept in this
 * browser: `setPin(key, pin)` sets or (with `null`) clears one and saves;
 * `reset` clears every pin, desktop and phone alike.
 */
import { useCallback, useState } from "react";
import { type DeviceClass, type Layouts, type Pin, type Pins, loadPins, savePins } from "./pins";

export function usePins(device: DeviceClass): {
  pins: Pins;
  setPin: (key: string, pin: Pin | null) => void;
  reset: () => void;
} {
  const [layouts, setLayouts] = useState<Layouts>(loadPins);
  const setPin = useCallback(
    (key: string, pin: Pin | null) =>
      setLayouts((l) => {
        const d = { ...l[device] };
        if (pin) d[key] = pin;
        else delete d[key];
        const next = { ...l, [device]: d };
        savePins(next);
        return next;
      }),
    [device],
  );
  const reset = useCallback(() => {
    const next: Layouts = { desktop: {}, phone: {} };
    savePins(next);
    setLayouts(next);
  }, []);
  return { pins: layouts[device], setPin, reset };
}
