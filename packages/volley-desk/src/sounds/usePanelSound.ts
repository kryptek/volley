/** `panel_open` when the calling panel mounts, `panel_close` when it unmounts. */
import { useEffect } from "react";
import { emitSound } from "./emit";

export function usePanelSound(): void {
  useEffect(() => {
    emitSound("panel_open");
    return () => emitSound("panel_close");
  }, []);
}
