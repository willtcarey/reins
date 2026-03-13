# PWA Implementation

How the Progressive Web App support works. See [feature doc](../features/pwa.md) for the user-facing side.

## Files

All in `packages/frontend/`:

| File | Purpose |
|---|---|
| `manifest.json` | Web app manifest — name, icons, display mode, theme color |
| `sw.js` | Service worker — caching and offline fallback |
| `icon-192.png` | 192×192 app icon (generated from `favicon.svg`) |
| `icon-512.png` | 512×512 app icon (generated from `favicon.svg`) |
| `index.html` | Links the manifest, sets `theme-color`, registers the SW |

## Manifest

Declares `"display": "standalone"` so the installed app hides browser chrome. Theme and background colors are both `#18181b` (zinc-900) to match the app.

Icons are provided at 32, 192, and 512px. The 512px icon is also declared with `"purpose": "maskable"` for Android adaptive icons.

## Service worker

Intentionally **network-only** — exists solely to meet PWA install criteria. All requests go straight to the server with no caching. This keeps things simple and ensures pull-to-refresh always gets fresh content.

## Reload button

Standalone PWAs have no browser chrome, so no refresh button. iOS pull-to-refresh doesn't work because the app uses inner scroll containers (the document itself never scrolls). Instead, `app.ts` detects standalone mode via `matchMedia("(display-mode: standalone)")` and renders a reload icon (↻) in the tab bar that calls `location.reload()`. It only appears when installed as a PWA.

## Regenerating icons

If the favicon SVG changes, regenerate with:

```sh
cd packages/frontend
rsvg-convert -w 192 -h 192 favicon.svg -o icon-192.png
rsvg-convert -w 512 -h 512 favicon.svg -o icon-512.png
```
