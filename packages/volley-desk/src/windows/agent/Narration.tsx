/**
 * The agent window's narration line with the chosen effect, ported from the
 * prototype `AgentWindow`: React Bits `DecryptedText` (decrypts each new
 * line), `ShinyText`, or plain text. Each new line re-mounts the effect.
 */
import DecryptedText from "../../rb/DecryptedText/DecryptedText";
import ShinyText from "../../rb/ShinyText/ShinyText";

import type { NarrationFx } from "../../look/options";
export type { NarrationFx };

export function Narration({ text, fx = "plain" }: { text: string | null; fx?: NarrationFx }) {
  return (
    <div className="narr" aria-live="polite" data-fx={fx}>
      {!text ? (
        <span className="dim">no narration yet</span>
      ) : fx === "decrypt" ? (
        <DecryptedText
          key={text}
          text={text}
          animateOn="view"
          speed={28}
          maxIterations={8}
          sequential
          revealDirection="start"
          className="narr-txt"
          encryptedClassName="narr-enc"
        />
      ) : fx === "shiny" ? (
        <ShinyText key={text} text={text} speed={3} color="#c9d1e4" shineColor="#ffffff" />
      ) : (
        <span>{text}</span>
      )}
    </div>
  );
}
