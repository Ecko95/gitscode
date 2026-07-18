export function SplashScreen() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-white">
      <div className="flex size-40 items-center justify-center" aria-label="GITS splash screen">
        <img alt="" className="size-40 object-contain" src="/gits-logo-anim.gif" />
      </div>
      <span className="animate-[splash-title-in_1.1s_cubic-bezier(0.2,0.8,0.2,1)_both] font-mono text-3xl font-bold tracking-[0.42em] text-neutral-900 select-none">
        GITS
      </span>
    </div>
  );
}
