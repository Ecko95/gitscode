# Cross-Platform

GITS keeps the existing web, desktop, server, mobile, pairing, Tailscale, SSH launch, provider session, and terminal streaming architecture from T3 Code while porting DevOS concepts as native modules.

## Web

`@t3tools/web` is the React UI on Vite with Tailwind through `@tailwindcss/vite`. It owns session UX, conversation and event rendering, client state, settings, command palette, saved remote environments, and the WebSocket runtime client.

For a saved remote environment, web clients open loopback apps as **In GITS (VPS browser)** through supervised Chromium; they do not reinterpret remote `localhost` as the browser device.

## Desktop

`@t3tools/desktop` is an Electron shell. It manages the backend, SSH launch, Tailscale endpoint handling, updates, menus, and native settings.

An SSH-backed Desktop environment can additionally use **Local via SSH (this computer only)**. The shell owns and cleans up the loopback-bound auxiliary forward; the shared web client never receives SSH credentials.

## Mobile

`@t3tools/mobile` is a React Native / Expo remote operator client for paired environments, threads, terminals, diffs, and connection flows.

Mobile targets iOS and Android through Expo prebuild. It has development, preview, and production variants that install as GITS Dev, GITS Preview, and GITS. Because it uses native modules, Expo Go is not supported; use the Expo Dev Client. The mobile app is currently build-from-source and is not distributed yet.

## Shared Runtime

`packages/client-runtime` provides browser, mobile, and desktop WebSocket RPC wrappers. `packages/ssh` supports desktop-managed SSH launch, local forwarding, remote pairing bootstrap, and bearer session bridging. `packages/tailscale` supports Tailnet endpoint discovery and Tailscale Serve setup.

Sources: `AGENTS.md`, `apps/web/package.json`, `apps/desktop/package.json`, `apps/mobile/package.json`, `apps/mobile/README.md`, `docs/gits/ARCHITECTURE.md`.
