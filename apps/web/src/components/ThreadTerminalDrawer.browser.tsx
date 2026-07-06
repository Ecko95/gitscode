import "../index.css";

import { scopeThreadRef } from "@t3tools/client-runtime";
import { ThreadId, type TerminalAttachStreamEvent } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const {
  terminalConstructorSpy,
  terminalDisposeSpy,
  fitAddonFitSpy,
  fitAddonLoadSpy,
  canvasAddonDisposeSpy,
  webglAddonDisposeSpy,
  webglContextLossDisposeSpy,
  webglContextLossListeners,
  rendererMockState,
  environmentApiById,
  readEnvironmentApiMock,
  readLocalApiMock,
} = vi.hoisted(() => ({
  terminalConstructorSpy: vi.fn(),
  terminalDisposeSpy: vi.fn(),
  fitAddonFitSpy: vi.fn(),
  fitAddonLoadSpy: vi.fn(),
  canvasAddonDisposeSpy: vi.fn(),
  webglAddonDisposeSpy: vi.fn(),
  webglContextLossDisposeSpy: vi.fn(),
  webglContextLossListeners: [] as Array<() => void>,
  rendererMockState: {
    failCanvasLoad: false,
    failWebglLoad: false,
  },
  environmentApiById: new Map<
    string,
    {
      terminal: {
        open: ReturnType<typeof vi.fn>;
        attach: ReturnType<typeof vi.fn>;
        write: ReturnType<typeof vi.fn>;
        resize: ReturnType<typeof vi.fn>;
      };
    }
  >(),
  readEnvironmentApiMock: vi.fn((environmentId: string) => environmentApiById.get(environmentId)),
  readLocalApiMock: vi.fn<
    () =>
      | {
          contextMenu: { show: ReturnType<typeof vi.fn> };
          shell: { openExternal: ReturnType<typeof vi.fn> };
        }
      | undefined
  >(() => ({
    contextMenu: { show: vi.fn(async () => null) },
    shell: { openExternal: vi.fn(async () => undefined) },
  })),
}));

vi.mock("@xterm/addon-canvas", () => ({
  CanvasAddon: class MockCanvasAddon {
    readonly __mockRenderer = "canvas";
    dispose = canvasAddonDisposeSpy;
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit = fitAddonFitSpy;
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class MockWebglAddon {
    readonly __mockRenderer = "webgl";
    dispose = webglAddonDisposeSpy;

    onContextLoss(listener: () => void) {
      webglContextLossListeners.push(listener);
      return { dispose: webglContextLossDisposeSpy };
    }
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    cols = 80;
    rows = 24;
    options: { theme?: unknown } = {};
    buffer = {
      active: {
        viewportY: 0,
        baseY: 0,
        getLine: vi.fn(() => null),
      },
    };

    constructor(options: unknown) {
      terminalConstructorSpy(options);
    }

    loadAddon(addon: unknown) {
      fitAddonLoadSpy(addon);
      if (
        typeof addon === "object" &&
        addon !== null &&
        "__mockRenderer" in addon &&
        addon.__mockRenderer === "webgl" &&
        rendererMockState.failWebglLoad
      ) {
        throw new Error("WebGL unavailable");
      }
      if (
        typeof addon === "object" &&
        addon !== null &&
        "__mockRenderer" in addon &&
        addon.__mockRenderer === "canvas" &&
        rendererMockState.failCanvasLoad
      ) {
        throw new Error("Canvas unavailable");
      }
    }

    open() {}

    write() {}

    clear() {}

    clearSelection() {}

    focus() {}

    refresh() {}

    scrollToBottom() {}

    hasSelection() {
      return false;
    }

    getSelection() {
      return "";
    }

    getSelectionPosition() {
      return null;
    }

    attachCustomKeyEventHandler() {
      return true;
    }

    registerLinkProvider() {
      return { dispose: vi.fn() };
    }

    onData() {
      return { dispose: vi.fn() };
    }

    onSelectionChange() {
      return { dispose: vi.fn() };
    }

    dispose() {
      terminalDisposeSpy();
    }
  },
}));

vi.mock("~/environmentApi", () => ({
  readEnvironmentApi: readEnvironmentApiMock,
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: vi.fn(() => {
    throw new Error("ensureLocalApi not implemented in browser test");
  }),
  readLocalApi: readLocalApiMock,
}));

import { TerminalViewport } from "./ThreadTerminalDrawer";

const THREAD_ID = ThreadId.make("thread-terminal-browser");

function createEnvironmentApi() {
  const snapshot = {
    threadId: THREAD_ID,
    terminalId: "term-1",
    cwd: "/repo/project",
    worktreePath: null,
    status: "running" as const,
    pid: 123,
    history: "",
    exitCode: null,
    exitSignal: null,
    label: "Terminal 1",
    updatedAt: "2026-04-07T00:00:00.000Z",
  };

  return {
    terminal: {
      open: vi.fn(async () => snapshot),
      attach: vi.fn(
        (
          _input: unknown,
          listener: (event: TerminalAttachStreamEvent) => void,
          _options?: unknown,
        ) => {
          listener({ type: "snapshot", snapshot });
          return vi.fn();
        },
      ),
      write: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
    },
  };
}

async function mountTerminalViewport(props: {
  threadRef: ReturnType<typeof scopeThreadRef>;
  drawerBackgroundColor?: string;
  drawerTextColor?: string;
  runtimeEnv?: Record<string, string>;
}) {
  const drawer = document.createElement("div");
  drawer.className = "thread-terminal-drawer";
  if (props.drawerBackgroundColor) {
    drawer.style.backgroundColor = props.drawerBackgroundColor;
  }
  if (props.drawerTextColor) {
    drawer.style.color = props.drawerTextColor;
  }

  const host = document.createElement("div");
  host.style.width = "800px";
  host.style.height = "400px";
  drawer.append(host);
  document.body.append(drawer);

  const screen = await render(
    <TerminalViewport
      threadRef={props.threadRef}
      threadId={THREAD_ID}
      terminalId="term-1"
      terminalLabel="Terminal"
      cwd="/repo/project"
      {...(props.runtimeEnv ? { runtimeEnv: props.runtimeEnv } : {})}
      onSessionExited={() => undefined}
      onAddTerminalContext={() => undefined}
      focusRequestId={0}
      autoFocus={false}
      resizeEpoch={0}
      drawerHeight={320}
      keybindings={[]}
    />,
    { container: host },
  );

  return {
    rerender: async (nextProps: {
      threadRef: ReturnType<typeof scopeThreadRef>;
      runtimeEnv?: Record<string, string>;
    }) => {
      await screen.rerender(
        <TerminalViewport
          threadRef={nextProps.threadRef}
          threadId={THREAD_ID}
          terminalId="term-1"
          terminalLabel="Terminal"
          cwd="/repo/project"
          {...(nextProps.runtimeEnv ? { runtimeEnv: nextProps.runtimeEnv } : {})}
          onSessionExited={() => undefined}
          onAddTerminalContext={() => undefined}
          focusRequestId={0}
          autoFocus={false}
          resizeEpoch={0}
          drawerHeight={320}
          keybindings={[]}
        />,
      );
    },
    cleanup: async () => {
      await screen.unmount();
      drawer.remove();
    },
  };
}

describe("TerminalViewport", () => {
  afterEach(() => {
    environmentApiById.clear();
    readEnvironmentApiMock.mockClear();
    readLocalApiMock.mockClear();
    terminalConstructorSpy.mockClear();
    terminalDisposeSpy.mockClear();
    fitAddonFitSpy.mockClear();
    fitAddonLoadSpy.mockClear();
    canvasAddonDisposeSpy.mockClear();
    webglAddonDisposeSpy.mockClear();
    webglContextLossDisposeSpy.mockClear();
    webglContextLossListeners.length = 0;
    rendererMockState.failCanvasLoad = false;
    rendererMockState.failWebglLoad = false;
  });

  it("does not create a terminal when APIs are unavailable", async () => {
    readEnvironmentApiMock.mockReturnValueOnce(undefined);
    readLocalApiMock.mockReturnValueOnce(undefined);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(terminalConstructorSpy).not.toHaveBeenCalled();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders and attaches the terminal without the desktop local API", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);
    readLocalApiMock.mockReturnValueOnce(undefined);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.attach).toHaveBeenCalledTimes(1);
      });
      expect(terminalConstructorSpy).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the terminal mounted when xterm fit runs before dimensions are ready", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);
    fitAddonFitSpy.mockImplementationOnce(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'dimensions')");
    });

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.attach).toHaveBeenCalledTimes(1);
      });
      expect(terminalConstructorSpy).toHaveBeenCalledTimes(1);
      expect(fitAddonFitSpy).toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("loads the WebGL renderer addon when available", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.attach).toHaveBeenCalledTimes(1);
      });
      await vi.waitFor(() => {
        expect(fitAddonLoadSpy).toHaveBeenCalledWith(
          expect.objectContaining({ __mockRenderer: "webgl" }),
        );
      });
      expect(fitAddonLoadSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ __mockRenderer: "canvas" }),
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to the canvas renderer when WebGL is unavailable", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);
    rendererMockState.failWebglLoad = true;

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.attach).toHaveBeenCalledTimes(1);
      });
      await vi.waitFor(() => {
        expect(fitAddonLoadSpy).toHaveBeenCalledWith(
          expect.objectContaining({ __mockRenderer: "webgl" }),
        );
        expect(fitAddonLoadSpy).toHaveBeenCalledWith(
          expect.objectContaining({ __mockRenderer: "canvas" }),
        );
      });
      expect(webglAddonDisposeSpy).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to the canvas renderer when the WebGL context is lost", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(webglContextLossListeners).toHaveLength(1);
      });
      webglContextLossListeners[0]?.();
      await vi.waitFor(() => {
        expect(webglContextLossDisposeSpy).toHaveBeenCalledTimes(1);
        expect(webglAddonDisposeSpy).toHaveBeenCalledTimes(1);
        expect(fitAddonLoadSpy).toHaveBeenCalledWith(
          expect.objectContaining({ __mockRenderer: "canvas" }),
        );
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the default DOM renderer when WebGL and canvas are unavailable", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);
    rendererMockState.failWebglLoad = true;
    rendererMockState.failCanvasLoad = true;

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.attach).toHaveBeenCalledTimes(1);
      });
      await vi.waitFor(() => {
        expect(webglAddonDisposeSpy).toHaveBeenCalledTimes(1);
        expect(canvasAddonDisposeSpy).toHaveBeenCalledTimes(1);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("disposes renderer addons when the terminal unmounts", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    await vi.waitFor(() => {
      expect(environment.terminal.attach).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(webglContextLossListeners).toHaveLength(1);
    });
    await mounted.cleanup();

    expect(webglContextLossDisposeSpy).toHaveBeenCalledTimes(1);
    expect(webglAddonDisposeSpy).toHaveBeenCalledTimes(1);
  });

  it("reattaches the terminal when the scoped thread reference changes", async () => {
    const environmentA = createEnvironmentApi();
    const environmentB = createEnvironmentApi();
    environmentApiById.set("environment-a", environmentA);
    environmentApiById.set("environment-b", environmentB);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(environmentA.terminal.attach).toHaveBeenCalledTimes(1);
      });

      await mounted.rerender({
        threadRef: scopeThreadRef("environment-b" as never, THREAD_ID),
      });

      await vi.waitFor(() => {
        expect(environmentB.terminal.attach).toHaveBeenCalledTimes(1);
      });
      expect(terminalDisposeSpy).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not reattach the terminal when the scoped thread reference values stay the same", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.attach).toHaveBeenCalledTimes(1);
      });

      await mounted.rerender({
        threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
      });

      await vi.waitFor(() => {
        expect(environment.terminal.attach).toHaveBeenCalledTimes(1);
      });
      expect(terminalDisposeSpy).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not reattach when runtime env contents are unchanged but object identity changes", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
      runtimeEnv: { PATH: "/usr/bin", T3: "1" },
    });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.attach).toHaveBeenCalledTimes(1);
      });

      await mounted.rerender({
        threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
        runtimeEnv: { T3: "1", PATH: "/usr/bin" },
      });

      await vi.waitFor(() => {
        expect(environment.terminal.attach).toHaveBeenCalledTimes(1);
      });
      expect(terminalDisposeSpy).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the drawer surface colors for the terminal theme", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
      drawerBackgroundColor: "rgb(24, 28, 36)",
      drawerTextColor: "rgb(228, 232, 240)",
    });

    try {
      await vi.waitFor(() => {
        expect(terminalConstructorSpy).toHaveBeenCalledTimes(1);
      });

      expect(terminalConstructorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          theme: expect.objectContaining({
            background: "rgb(24, 28, 36)",
            foreground: "rgb(228, 232, 240)",
          }),
        }),
      );
    } finally {
      await mounted.cleanup();
    }
  });
});
