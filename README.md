# GITS

GITS is the DevOS IDE and control plane for coding agents. It keeps the T3 Code remote shell and adds a GITS cockpit for Open GSD, Delamain peers, provider sessions, and remote operator workflows.

## Installation

> [!WARNING]
> GITS currently supports Codex, Claude, OpenCode, and Cursor Agent where available.
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Run without installing

```bash
npx t3
```

The CLI/package names are still inherited from upstream T3 Code while the GITS fork is being productized.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/joshuaduffill/t3code/releases), or build it from source.

#### Windows (`winget`)

Package-registry entries may still use upstream T3 Code identifiers until GITS distribution is cut.

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

```bash
yay -S t3code-bin
```

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

Observability guide: [docs/observability.md](./docs/observability.md)

## If you REALLY want to contribute still.... read this first

Before local development, prepare the environment and install dependencies:

```bash
# Optional: only needed if you use mise for dev tool management.
mise install
bun install .
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
