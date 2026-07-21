import { useEffect, useState } from "react";

// One full cycle of /gits-logo-anim(-dark).gif. Elapsed time counts from the static
// index.html boot splash (window.__gitsBootStart) so the animation plays once
// total across both layers, then holds the last frame instead of looping.
// ponytail: constant must track the gif asset; re-measure if the gif changes.
const LOGO_CYCLE_MS = 4000;

function elapsedSinceBoot(): number {
  const start = (window as Window & { __gitsBootStart?: number }).__gitsBootStart;
  return typeof start === "number" ? Date.now() - start : 0;
}

export function SplashScreen() {
  // Same signal the index.html boot script uses; read once — the splash is transient.
  const isDark = document.documentElement.classList.contains("dark");
  const [hold, setHold] = useState(() => elapsedSinceBoot() >= LOGO_CYCLE_MS);
  useEffect(() => {
    if (hold) return;
    const timer = setTimeout(() => setHold(true), LOGO_CYCLE_MS - elapsedSinceBoot());
    return () => clearTimeout(timer);
  }, [hold]);
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-white dark:bg-[#161616]">
      <div
        className="relative flex size-40 items-center justify-center"
        aria-label="GITS splash screen"
      >
        <img
          alt=""
          className="size-40 object-contain"
          src={isDark ? "/gits-logo-anim-dark.gif" : "/gits-logo-anim.gif"}
        />
        <img
          alt=""
          className={`absolute inset-0 size-40 object-contain transition-opacity duration-300 ${
            hold ? "opacity-100" : "opacity-0"
          }`}
          src={isDark ? "/gits-logo-hold-dark.png" : "/gits-logo-hold.png"}
        />
      </div>
      <span className="animate-[splash-title-in_1.1s_cubic-bezier(0.2,0.8,0.2,1)_both] font-mono text-3xl font-bold tracking-[0.42em] text-neutral-900 select-none dark:text-neutral-100">
        GITS
      </span>
    </div>
  );
}
