/**
 * A primary action (D10): the sign-in's React Bits `SpecularButton` — a glass
 * button whose edge catches the light — in a thin gradient frame, so Claim and
 * the settings Done read like Sign in. `hot` tints it the Needs-you orange.
 * It is still one plain `<button>`: same name, `onClick` and `disabled`.
 */
import type { ReactNode } from "react";
import SpecularButton from "../rb/SpecularButton/SpecularButton";

export function PrimaryAction({
  children,
  onClick,
  disabled = false,
  hot = false,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  hot?: boolean;
}) {
  return (
    <span className={`action-spec${hot ? " action-spec--hot" : ""}${disabled ? " is-busy" : ""}`}>
      <SpecularButton
        type="button"
        size="sm"
        radius={10}
        disabled={disabled}
        onClick={onClick}
        tint={hot ? "#ff7a59" : "#7c6cf6"}
        tintOpacity={hot ? 0.38 : 0.32}
        baseColor={hot ? "#5a1d0e" : "#2a1f6e"}
        lineColor={hot ? "#ffe2d8" : "#d6f7ff"}
        textColor="#ffffff"
        intensity={1.1}
        idleIntensity={0.35}
        glow={0.8}
        thickness={1.2}
        followMouse
      >
        {children}
      </SpecularButton>
    </span>
  );
}
