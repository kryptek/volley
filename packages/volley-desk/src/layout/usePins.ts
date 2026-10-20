/**
 * The window pins (C12, `pins.ts`) for this device class, kept in this
 * browser. `setPin(key, pin)` sets or (with `null`) clears one; `pin` may be
 * an updater of the current pin, so the deltas of a drag compose however many
 * pointer moves arrive before a render. A change is saved after it renders,
 * except one made with `{ save: false }` (each move of a drag), which waits
 * for `save()` (the drop). `reset` clears every pin, desktop and phone alike.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { type DeviceClass, type Layouts, type Pin, type Pins, loadPins, savePins } from "./pins";

type PinUpdate = Pin | null | ((prev: Pin | undefined) => Pin | null | undefined);

export function usePins(device: DeviceClass): {
  pins: Pins;
  setPin: (key: string, pin: PinUpdate, opts?: { save?: boolean }) => void;
  /** Save the pins now (a drag was dropped). */
  save: () => void;
  reset: () => void;
} {
  const [layouts, setLayouts] = useState<Layouts>(loadPins);
  /** A change waits to be saved once it has rendered. */
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) return;
    dirty.current = false;
    savePins(layouts);
  }, [layouts]);
  const setPin = useCallback(
    (key: string, pin: PinUpdate, opts: { save?: boolean } = {}) => {
      if (opts.save !== false) dirty.current = true;
      setLayouts((l) => {
        const prev = l[device][key];
        const next = typeof pin === "function" ? pin(prev) : pin;
        if (next === prev || (next == null && prev === undefined)) return l;
        const d = { ...l[device] };
        if (next) d[key] = next;
        else delete d[key];
        return { ...l, [device]: d };
      });
    },
    [device],
  );
  const save = useCallback(() => {
    dirty.current = true;
    // A new object so the effect runs with whatever the last move left.
    setLayouts((l) => ({ ...l }));
  }, []);
  const reset = useCallback(() => {
    dirty.current = true;
    setLayouts({ desktop: {}, phone: {} });
  }, []);
  return { pins: layouts[device], setPin, save, reset };
}
