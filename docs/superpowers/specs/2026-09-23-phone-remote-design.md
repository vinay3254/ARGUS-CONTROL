# Phone as Remote + Second Screen — Design

Date: 2026-09-23
Status: approved for implementation planning

## Goal

An Android phone, installed as a PWA, views a live low-latency stream of a
Linux laptop's screen and controls the laptop's mouse, keyboard, and media
keys, over the same local WiFi network. LAN-only, single laptop, single
paired phone at a time.

## Confirmed environment (this laptop)

- Session: Wayland, compositor Hyprland (wlroots-based)
- `wf-recorder`, `grim`, `slurp` installed (wlroots-native capture)
- `ydotool` + `ydotoold` installed (universal input injection, X11+Wayland)
- `xdotool` installed (X11 fallback only)
- ffmpeg n9.0.1 — no pipewire input support in this build; not used for
  Wayland capture. Used for X11 (`x11grab`) fallback capture only.
- Node v26.9.0. `@roamhq/wrtc` installed and verified working (native
  `RTCPeerConnection` created successfully) — no native-addon build required.

## Scope (v1)

In scope:
- Single laptop, single active paired phone (second pairing kicks the first)
- Android + Chrome only (no iOS)
- Wayland/wlroots (Hyprland) capture via `wf-recorder`, X11 capture via
  `ffmpeg x11grab` fallback
- Video only (no audio capture)
- WebRTC video transport (real `RTCPeerConnection`, host-only ICE, no
  STUN/TURN — LAN only)
- Touch → mouse/scroll, on-screen keyboard, media keys, lock screen
- QR + 6-digit code pairing, self-signed HTTPS, token persisted in phone
  localStorage

Out of scope (v1):
- GNOME/KDE portal-only Wayland compositors (only wlroots-family covered)
- Multiple simultaneous viewers/broadcast
- `--tunnel` / Tailscale remote access (flag stubbed, not implemented)
- Automated E2E tests (real screen + real phone hardware)

## Architecture

```
[Laptop: phone-remote/server.js]
  Express (HTTPS, self-signed cert, LAN-bound)
    → serves /public (PWA: manifest, SW, index.html, app.js)
    → GET /pair-qr → PNG QR encoding https://<lan-ip>:<port>?pair=<6digit>
  WS server (same HTTPS server, wss://)
    → signaling (SDP offer/answer, ICE candidates)
    → input events (JSON: move/click/scroll/key/media)
    → pairing handshake (code check → issue long-lived token)
  Capture pipeline (child_process)
    → Wayland+wlroots (Hyprland confirmed): wf-recorder → raw I420 stdout
    → X11: ffmpeg -f x11grab → raw I420 stdout
    → Node parses fixed-size raw frames → @roamhq/wrtc RTCVideoSource.onFrame()
  RTCPeerConnection (@roamhq/wrtc, host-only ICE, no TURN/STUN — LAN only)
  Input executor: ydotool (uinput-based, works X11+Wayland) via ydotoold socket
    → xdotool fallback only if ydotool missing AND session=x11

[Phone: PWA, Chrome/Android]
  index.html: fullscreen <video>, slide-up drawer
  app.js: WS client, RTCPeerConnection (receive-only), touch handlers, camera QR scan
  sw.js: caches app shell for installability; media stream itself never cached
  Pairing: camera scans QR → extracts URL+code → POST pair → token stored in
  localStorage → reused on reconnect
```

## Components + data flow

1. `npm start`
   - detect `$XDG_SESSION_TYPE`, detect compositor (`$XDG_CURRENT_DESKTOP`)
   - generate/reuse self-signed cert (`selfsigned` npm pkg, cached in
     `~/.phone-remote/cert`)
   - generate 6-digit pairing code, print + serve as QR at `/pair-qr`
   - start HTTPS+WS server, bound to LAN interface IP (not `0.0.0.0`), print URL

2. Phone: open PWA → prompt "scan QR or enter code" → camera scan → `POST /pair {code}`
   - server validates code (single-use, expires 5 min or on restart) →
     returns `{token}`
   - token stored in localStorage → included on WS connect as auth

3. WS connect (authed) → server creates `RTCPeerConnection`, attaches capture
   video track
   - SDP offer sent over WS → phone answers → ICE candidates exchanged over
     WS (host-only, LAN)
   - video flows over WebRTC directly (not through WS)

4. Touch/key/media events → phone sends JSON over WS (not datachannel, per
   original spec) → server maps to ydotool commands:
   - 1-finger drag → `ydotool mousemove -- <dx> <dy>` (relative)
   - tap → `ydotool click 0x00` (left)
   - two-finger tap → `ydotool click 0x01` (right)
   - two-finger drag → `ydotool wheel` / synthetic scroll events
   - drawer text field → `ydotool type <string>`
   - media keys → `ydotool key <XF86 keycodes>`
   - lock → `ydotool key` combo, or `loginctl lock-session`

5. Reconnect: WS `onclose` → phone retries last-known IP with backoff
   (1s, 2s, 5s, 10s cap). Token already stored, skips pairing code re-entry.

## Error handling + edge cases

- `ydotoold` not running → server detects at startup (socket check), logs
  clear fix instructions, degrades to WS-connect-but-input-disabled banner
  shown on phone.
- Capture fails (e.g. user cancels permission, `wf-recorder`/`ffmpeg` exits)
  → WS error message to phone, video area shows "capture failed, retry"
  button, no crash.
- Pairing code expired/wrong → 401 on `/pair`, phone shows inline error, rate
  limited to 10 attempts/min (LAN-only threat model, blocks trivial brute
  force only).
- Token invalid/revoked (server restarted, codes reset) → WS auth rejected →
  phone clears localStorage token, falls back to QR/code pairing screen.
- Second phone pairs → first phone's WS is closed with a
  "disconnected: paired elsewhere" message.
- Laptop sleep/lock: capture child process dies → server detects exit,
  restarts capture on next WS activity rather than retry-looping forever.

## Testing

- Unit: input-event → ydotool-command mapping (pure function, testable
  headless)
- Unit: pairing code generation/expiry/token issuance
- Manual/integration (WebRTC + real phone hardware, not automatable):
  checklist in README — pair, view stream, drag/tap/scroll, drawer controls,
  reconnect after WiFi drop, restart server and confirm re-pair required
- No automated E2E in v1

## Key technical decisions (with rationale)

1. **Native `wrtc` over browser-tab-based capture.** User explicitly
   requires native (no Chrome-launch approach). Verified `@roamhq/wrtc`
   installs and runs on Node v26.9.0 without a from-source build.
2. **`wf-recorder` (not `ffmpeg -f pipewire`) for Wayland capture.** This
   laptop's ffmpeg build has no pipewire input; `wf-recorder` is
   wlroots-native (works directly with Hyprland via `wlr-screencopy`, no
   portal dialog, lower latency) and is already installed.
3. **Self-signed HTTPS + in-PWA camera QR scan** (not plain HTTP + native
   camera app). Required because service-worker install and
   `getUserMedia` both need a secure context; user chose to keep the
   in-app scan flow from the original spec over the simpler plain-HTTP
   alternative.
4. **Raw I420 frames into `RTCVideoSource.onFrame()`**, not pre-encoded
   H264 piped into wrtc — `@roamhq/wrtc`'s video source API takes raw
   frames and handles encoding internally; capture tools output raw video
   for this reason.
