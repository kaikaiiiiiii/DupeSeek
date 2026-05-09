# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
# Dev
npm run dev          # Start dev server with HMR

# Build
npm run build        # Typecheck + electron-vite build
npm run build:win    # Build + package for Windows (electron-builder)
npm run build:mac    # Build + package for macOS
npm run build:linux  # Build + package for Linux

# Code Quality
npm run lint         # ESLint check
npm run format       # Prettier format
npm run typecheck    # tsc (node) + vue-tsc (web)

# Preview production build
npm run start        # electron-vite preview
```

## Architecture

Electron + Vue 3 + TypeScript app for finding and managing duplicate files. Three-layer Electron architecture:

- **`src/main/`** (Main process) — Node.js backend. Creates BrowserWindow, registers IPC handlers for native dialogs (`select-directory`) and filesystem operations (`scan-dir`). Currently uses `fs.readdirSync` (sync, blocking).

- **`src/preload/`** (Preload bridge) — Exposes a controlled API via `contextBridge`. Currently exposes `window.api.selectDirectory()` and `window.electron` (from `@electron-toolkit/preload`). The type declaration in `index.d.ts` also declares `window.api.readDir` but it's not yet implemented.

- **`src/renderer/src/`** (Renderer) — Vue 3 SPA with Pinia state management. Two-tab layout via `Main.vue`:
  - Tab A (`components/A.vue`) — Directory list manager. Add directories via native dialog, remove items, trigger scan via IPC.
  - Tab B (`components/B.vue`) — File list display. Listens for `scan-result` IPC events and renders file names with checkboxes via `FileListItem.vue`.
  - Tab switching uses `KeepAlive` to preserve component state.

## Current State & Known Issues

This is an early prototype. Key problems to be aware of:

- `sandbox: false` in `BrowserWindow` config — renderer has full Node access, a security risk
- `fs.readdirSync` blocks main process on scan — should be async
- `App.vue` is dead template code not used anywhere
- No error/loading states for user operations
- Only basic scaffold wiring exists; see README.md for planned feature roadmap (profiles, filtering rules, duplicate comparison methods, etc.)

## Project Roadmap (from README)

Long-term features include: scan profiles, file type filtering, skip system/hidden/symlink files, archive-internal CRC32 comparison, duplicate matching by filename/size/content (MD5)/location, duplicate resolution strategies, statistics, empty directory removal, TreeSize-like visualization.

## Design Docs
  - [Design & Planning](../docs/Design.md) — feature design, technical decisions, roadmap details