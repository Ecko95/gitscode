import { useEffect, useState } from "react";

// One full cycle of /gits-logo-anim.gif. Elapsed time counts from the static
// index.html boot splash (window.__gitsBootStart) so the animation plays once
// total across both layers, then holds the static logo instead of looping.
// ponytail: constant must track the gif asset; re-measure if the gif changes.
const LOGO_CYCLE_MS = 4000;
const HOLD_LOGO_SRC = "/apple-touch-icon.png";

function elapsedSinceBoot(): number {
  const start = (window as Window & { __gitsBootStart?: number }).__gitsBootStart;
  return typeof start === "number" ? Date.now() - start : 0;
}

export function SplashScreen() {
  const [hold, setHold] = useState(() => elapsedSinceBoot() >= LOGO_CYCLE_MS);
  useEffect(() => {
    if (hold) return;
    const timer = setTimeout(() => setHold(true), LOGO_CYCLE_MS - elapsedSinceBoot());
    return () => clearTimeout(timer);
  }, [hold]);
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-white">
      <div
        className="relative flex size-40 items-center justify-center"
        aria-label="GITS splash screen"
      >
        <img alt="" className="size-40 object-contain" src="/gits-logo-anim.gif" />
        <img
          alt=""
          className={`absolute inset-0 size-40 object-contain transition-opacity duration-300 ${
            hold ? "opacity-100" : "opacity-0"
          }`}
          src={HOLD_LOGO_SRC}
        />
      </div>
      <span className="animate-[splash-title-in_1.1s_cubic-bezier(0.2,0.8,0.2,1)_both] font-mono text-3xl font-bold tracking-[0.42em] text-neutral-900 select-none">
        GITS
      </span>
    </div>
  );
}
