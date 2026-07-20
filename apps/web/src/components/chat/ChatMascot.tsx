import { useEffect, useState, type RefObject } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { isMascotTyping } from "./chatMascot.logic";

// Mode-aware pixel-ghost mascot that perches above the composer. Three states,
// each a native GIF the browser plays; Motion crossfades between them on change.
//   idle          -> /gits-idle.gif        (whenever the user is not typing)
//   typing, build -> /gits-mascot-loop.gif (the keyboard ghost)
//   typing, plan  -> /gits-plan-anim.gif   (the planning animation)
// All three render in one fixed 84x96 box, contain-fit + bottom-anchored, so the
// box never resizes between states. The bob + glow come from CSS (.gits-mascot),
// running only while typing.

export type MascotMode = "build" | "plan";

const SOURCES = {
  idle: "/gits-idle.gif",
  build: "/gits-mascot-loop.gif",
  plan: "/gits-plan-anim.gif",
} as const;
type SourceKey = keyof typeof SOURCES;

// The source GIFs bake the ghost at different internal scales (idle 512², build
// 484×552 with a keyboard, plan 256²), so contain-fit alone leaves the ghost body
// reading larger/smaller between states. Per-source scale evens that out.
// ponytail: eyeball knobs — nudge in-browser until the ghost holds its size.
const SCALE: Record<SourceKey, number> = { idle: 1, build: 1, plan: 1 };

// isMascotTyping owns how long a keystroke keeps the typing state alive; poll a
// bit faster than that window so the state swap feels prompt without a rAF loop.
const POLL_MS = 150;
const CROSSFADE_S = 0.28;

export function ChatMascot({
  typingRef,
  mode,
}: {
  typingRef: RefObject<number>;
  mode: MascotMode;
}) {
  const [typing, setTyping] = useState(false);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const poll = () => setTyping(isMascotTyping(typingRef.current ?? 0, Date.now()));
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [typingRef]);

  const active: SourceKey = typing ? mode : "idle";

  return (
    <div
      className="gits-mascot pointer-events-none absolute -top-[92px] right-1 z-20 h-24 w-[84px] select-none"
      style={{ animationPlayState: typing ? "running" : "paused" }}
      aria-hidden="true"
    >
      <AnimatePresence initial={false}>
        <motion.img
          key={active}
          src={SOURCES[active]}
          alt=""
          draggable={false}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : CROSSFADE_S, ease: "easeInOut" }}
          style={{ scale: SCALE[active] }}
          className="absolute inset-0 h-full w-full select-none object-contain object-bottom"
        />
      </AnimatePresence>
    </div>
  );
}
