import { useEffect, useRef, type RefObject } from "react";
import { isMascotTyping } from "./chatMascot.logic";

// Mode-aware pixel-ghost mascot that perches above the composer. Three states:
//   idle          -> /gits-idle.gif        (loops whenever the user is not typing)
//   typing, build -> /gits-mascot-loop.gif (the keyboard ghost)
//   typing, plan  -> /gits-plan-anim.gif   (the planning animation)
// Sources decode lazily on mount; any that fail fall back to the baked-in 36x36
// pixel sprite. Frames draw contain-fitted (sources have mixed aspect ratios).
// The bob + glow come from CSS (.gits-mascot), running only while typing.

export type MascotMode = "build" | "plan";

const SOURCES = {
  idle: "/gits-idle.gif",
  build: "/gits-mascot-loop.gif",
  plan: "/gits-plan-anim.gif",
} as const;
type SourceKey = keyof typeof SOURCES;

// Decode box: 2x the 84x96 canvas. Full-res frames (484x552 x97 for the build
// ghost) would hold ~100MB of bitmaps for an 84px-wide indicator.
const DECODE_W = 168;
const DECODE_H = 192;
// 36-row sprite sampled from the reference art. E=outline, W=body, g=shade.
const GMAP = [
  "..............EEEEEEEE..............",
  "............EEWWWWWWWEEE............",
  ".........EEEWWWWWWWWWWWEE...........",
  "........EEWWWWWWWWWWWWWWgE..........",
  ".......EEWWWWWWWWWWWWWWWWgE.........",
  ".......EgWWWWWWWWWWWWWWWWWEE........",
  "......EEWWWWWWWWWWWWWWgEWWWE........",
  "......EEWWWWWWWWWWWWWEEWWWWE........",
  "......EgWgggggWWWWWgEEEEgWWEE.......",
  "......EWWEEEEEWWWWWggggggWWWE.......",
  "......EWWWgEEWWWWWWWEgWWWWWWE.......",
  "......EWWgEgggWWWWWWWEWWWWWWE.......",
  "......EWWEWWEWWWgEWWgEWWWWWgE.......",
  "......EWWWWWgEWgEEEgEgWWWWWEE.......",
  "......EWWWWWWEEEgWEEgWWWWWWWEEE.....",
  "......EgWWWWWWWWWWWWWWWWWWWWWWgE....",
  "......EEWWWWWWWWWWWWWWWWWWWWWWWgE...",
  ".......EgWWWWWWWWWWWWWWWWWWWWWWgE...",
  ".....EEEgWWWWWWWWWWWWWWWgEEEEEE.....",
  "....EgWWWWWWWWWWWWWWWWWWEEEEEE......",
  "...EgWWWWWWWWWWWWWWWWWWWE...........",
  "...EWWWWWEWWWWWWWWWWWWWgE...........",
  "...EEgggEEgWWWWWWWWWWWWEE...........",
  "....EEEEEgEWWWWWWWWWWWgE............",
  ".........EgWWWWWWWWWWgE.............",
  ".........EWWWWWWWWWWEE..............",
  ".........EWWWWWWWggEE...............",
  ".........EWWWWWWgEEEE...............",
  ".........EgWWWWgEE..................",
  ".........EEWWWWgE...................",
  "..........EgWWWEE...................",
  "..........EEggWgE...................",
  "...........EEEgggE..................",
  ".............EEggE..................",
  "..............EEEE..................",
  "..............EEE...................",
] as const;
const GCOL: Record<string, string> = { W: "#eef1f8", g: "#aeb6d8", E: "#0e1120" };
const CELL = 2;

type GifFrame = { bitmap: ImageBitmap; durationMs: number };
type FrameSets = Partial<Record<SourceKey, GifFrame[]>>;

function drawSprite(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const cols = GMAP[0].length;
  const rows = GMAP.length;
  const ox = Math.round((canvas.width - cols * CELL) / 2);
  const oy = Math.round((canvas.height - rows * CELL) / 2);
  for (let y = 0; y < rows; y++) {
    const line = GMAP[y];
    if (!line) continue;
    for (let x = 0; x < cols; x++) {
      const color = GCOL[line[x] ?? "."];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(ox + x * CELL, oy + y * CELL, CELL, CELL);
    }
  }
}

async function loadGifFrames(url: string): Promise<GifFrame[] | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.arrayBuffer();
    const decoderCtor = (
      window as unknown as { ImageDecoder?: new (init: { data: ArrayBuffer; type: string }) => any }
    ).ImageDecoder;
    if (!decoderCtor) return null;
    const decoder = new decoderCtor({ data, type: "image/gif" });
    await decoder.tracks.ready;
    const count: number = decoder.tracks.selectedTrack?.frameCount ?? 0;
    if (count <= 0) return null;
    const frames: GifFrame[] = [];
    for (let i = 0; i < count; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      // Contain-fit into the decode box, preserving each source's aspect ratio.
      const scale = Math.min(DECODE_W / image.displayWidth, DECODE_H / image.displayHeight);
      frames.push({
        bitmap: await createImageBitmap(image, {
          resizeWidth: Math.max(1, Math.round(image.displayWidth * scale)),
          resizeHeight: Math.max(1, Math.round(image.displayHeight * scale)),
        }),
        durationMs: Math.max(20, (image.duration ?? 40_000) / 1000),
      });
      image.close();
    }
    return frames.length > 0 ? frames : null;
  } catch {
    return null;
  }
}

export function ChatMascot({
  typingRef,
  mode,
}: {
  typingRef: RefObject<number>;
  mode: MascotMode;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const modeRef = useRef<MascotMode>(mode);
  modeRef.current = mode;

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    drawSprite(canvas);

    let stopped = false;
    const frameSets: FrameSets = {};
    let activeSource: SourceKey | null = null;
    let frameIndex = 0;
    let accumMs = 0;
    let prevTs = 0;
    let raf = 0;

    for (const key of Object.keys(SOURCES) as SourceKey[]) {
      void loadGifFrames(SOURCES[key]).then((loaded) => {
        if (!stopped && loaded) frameSets[key] = loaded;
      });
    }

    const drawFrame = (frame: GifFrame) => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // Contain-centered: sources have mixed aspect ratios (square idle/plan,
      // tall keyboard ghost), all anchored to the bottom of the canvas.
      const scale = Math.min(
        canvas.width / frame.bitmap.width,
        canvas.height / frame.bitmap.height,
      );
      const w = frame.bitmap.width * scale;
      const h = frame.bitmap.height * scale;
      ctx.drawImage(frame.bitmap, (canvas.width - w) / 2, canvas.height - h, w, h);
    };

    const tick = (ts: number) => {
      if (stopped) return;
      const typing = isMascotTyping(typingRef.current ?? 0, Date.now());
      container.style.animationPlayState = typing ? "running" : "paused";
      const wanted: SourceKey = typing ? modeRef.current : "idle";
      const frames = frameSets[wanted];
      if (frames) {
        if (activeSource !== wanted) {
          activeSource = wanted;
          frameIndex = 0;
          accumMs = 0;
          prevTs = ts;
          drawFrame(frames[0]!);
        }
        if (!prevTs) prevTs = ts;
        accumMs += ts - prevTs;
        let moved = false;
        let current = frames[frameIndex];
        while (current && accumMs >= current.durationMs) {
          accumMs -= current.durationMs;
          frameIndex = (frameIndex + 1) % frames.length;
          current = frames[frameIndex];
          moved = true;
        }
        if (moved && current) drawFrame(current);
      }
      prevTs = ts;
      raf = requestAnimationFrame(tick);
    };

    // The loop only runs while the tab is visible; the visibility listener
    // restarts it. Idle now animates too (the idle GIF), so unlike the earlier
    // typing-only loop this runs whenever the mascot is on screen.
    const start = () => {
      if (stopped || document.hidden) return;
      cancelAnimationFrame(raf);
      prevTs = 0;
      raf = requestAnimationFrame(tick);
    };
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
      } else {
        start();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    start();

    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      cancelAnimationFrame(raf);
      for (const frames of Object.values(frameSets)) {
        for (const frame of frames ?? []) frame.bitmap.close();
      }
    };
  }, [typingRef]);

  return (
    <div
      ref={containerRef}
      className="gits-mascot pointer-events-none absolute -top-[92px] right-1 z-20 h-24 w-[84px] select-none"
      aria-hidden="true"
    >
      <canvas ref={canvasRef} width={84} height={96} className="h-24 w-[84px]" />
    </div>
  );
}
