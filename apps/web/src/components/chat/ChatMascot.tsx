import { useEffect, useRef, type RefObject } from "react";
import { isMascotTyping } from "./chatMascot.logic";

// Pixel-ghost typing indicator that perches above the composer. It plays while the
// user types and pauses ~900ms after they stop. If an app-served animated GIF
// (public/gits-mascot-loop.gif) is present it plays that; otherwise it renders the
// baked-in 36x36 pixel sprite. The bob + glow come from CSS (.gits-mascot), gated on
// the typing state and on prefers-reduced-motion / the --gits-glow token.

const GHOST_ASSET_URL = "/gits-mascot-loop.gif";

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

type GifFrame = { bitmap: CanvasImageSource; durationMs: number };

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

async function loadGifFrames(): Promise<GifFrame[] | null> {
  try {
    const response = await fetch(GHOST_ASSET_URL);
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
      frames.push({
        // Decode at 2x render size (84x96 canvas) — the full-res 484x552 x97
        // frames would hold ~100MB of bitmaps for an 84px-wide indicator.
        bitmap: await createImageBitmap(image, { resizeWidth: 168, resizeHeight: 192 }),
        durationMs: Math.max(20, (image.duration ?? 40_000) / 1000),
      });
      image.close();
    }
    return frames.length > 0 ? frames : null;
  } catch {
    return null;
  }
}

export function ChatMascot({ typingRef }: { typingRef: RefObject<number> }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    drawSprite(canvas);

    let stopped = false;
    let frames: GifFrame[] | null = null;
    let frameIndex = 0;
    let accumMs = 0;
    let prevTs = 0;
    let raf = 0;

    void loadGifFrames().then((loaded) => {
      if (!stopped && loaded) frames = loaded;
    });

    const drawGifFrame = () => {
      const ctx = canvas.getContext("2d");
      const frame = frames?.[frameIndex];
      if (!ctx || !frame) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(frame.bitmap, 0, 0, canvas.width, canvas.height);
    };

    // The rAF loop only runs while the user is typing; when the typing window
    // lapses it stops entirely and a cheap 4Hz watcher waits for the next
    // keystroke. Idle cost is one timer tick, not a 60fps loop — this also keeps
    // browser-mode tests from burning frame budget while the mascot is idle.
    let rafActive = false;

    const tick = (ts: number) => {
      if (stopped) return;
      const typing = isMascotTyping(typingRef.current ?? 0, Date.now());
      if (!typing) {
        rafActive = false;
        accumMs = 0;
        prevTs = 0;
        container.style.animationPlayState = "paused";
        return;
      }
      if (frames) {
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
        if (moved) drawGifFrame();
      }
      prevTs = ts;
      raf = requestAnimationFrame(tick);
    };

    const watcher = setInterval(() => {
      if (stopped || rafActive) return;
      if (isMascotTyping(typingRef.current ?? 0, Date.now())) {
        rafActive = true;
        container.style.animationPlayState = "running";
        raf = requestAnimationFrame(tick);
      }
    }, 250);

    return () => {
      stopped = true;
      clearInterval(watcher);
      cancelAnimationFrame(raf);
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
