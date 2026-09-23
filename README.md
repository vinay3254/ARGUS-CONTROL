# Phone Remote

Turn an Android phone into a low-latency wireless second screen + trackpad/keyboard
for a Linux laptop, over the same WiFi network.

## Requirements (laptop)

- Node.js 20+
- `ydotool` and `ydotoold` (input injection, works on both X11 and Wayland)
- Wayland/Hyprland (or another wlroots compositor): `wf-recorder`, and `hyprctl`
  available (ships with Hyprland)
- X11 (fallback): `ffmpeg` with `x11grab` support, `xdotool`

On Arch Linux:
```bash
sudo pacman -S ydotool wf-recorder ffmpeg xdotool
```

`ydotoold` needs access to `/dev/uinput`. Either run it as root, or add your user to
the relevant group and grant it access — see your distro's `ydotool` docs. Start it
before running the server:
```bash
sudo ydotoold &
```

## Install & run

```bash
npm install
npm start
```

The terminal prints the phone's connection URL (e.g. `https://192.168.1.50:8443/`)
and logs a fresh 6-digit pairing code whenever `/pair-qr` is requested.

## Pairing the phone

1. On your phone (same WiFi), open the printed URL in Chrome.
2. Accept the self-signed certificate warning (one-time; this is your own laptop's
   local server, not sent anywhere).
3. Either tap **Scan QR to pair** and point the camera at `https://<laptop-ip>:8443/pair-qr`
   opened in a browser on the laptop, or type the 6-digit code printed in the
   laptop's terminal.
4. Optionally tap Chrome's menu → **Add to Home Screen** to install it as a PWA.

The pairing token is stored on the phone; you won't need to re-pair unless the
server restarts or a second phone pairs (which disconnects the first).

## Troubleshooting

**"Screen capture failed" banner:**
- Wayland: confirm you're on a wlroots compositor (Hyprland, Sway, etc.) — GNOME/KDE
  are not supported in this version. Confirm `wf-recorder` and `hyprctl` are
  installed and `hyprctl monitors -j` returns your display.
- X11: confirm `ffmpeg -f x11grab -i :0 ...` works manually, and `$DISPLAY` is set
  for the process running `npm start`.

**"Input control unavailable: ydotoold is not running":**
- Run `sudo ydotoold &` before or after starting the server — the server will pick
  it up on the next input event.

**Video connects but there's no cursor movement / clicks:**
- Confirm `ydotoold`'s socket exists: `ls /tmp/.ydotool_socket`.
- Test manually: `YDOTOOL_SOCKET=/tmp/.ydotool_socket ydotool mousemove -- 50 0`
  should move the cursor.

**X11 vs Wayland is misdetected:**
- The server reads `$XDG_SESSION_TYPE`. Run `echo $XDG_SESSION_TYPE` in the same
  shell/session you launch `npm start` from — if it's empty or wrong, your display
  manager isn't setting it and you'll need to export it manually before `npm start`.

**Phone won't install as a PWA / service worker doesn't register:**
- The connection must be HTTPS (it is, via the self-signed cert) — plain HTTP won't
  register a service worker except on `localhost`. Make sure you didn't type `http://`
  instead of `https://`.

## Manual test checklist (no automated E2E — see spec)

- [ ] Pair via 6-digit code
- [ ] Pair via camera QR scan
- [ ] Live video visible, low latency, tracks laptop screen changes
- [ ] One-finger drag moves cursor; tap left-clicks; two-finger tap right-clicks;
      two-finger drag scrolls
- [ ] Drawer: keyboard field types into the focused laptop app
- [ ] Drawer: volume up/down/mute change laptop volume
- [ ] Drawer: play/pause/next/prev control media playback
- [ ] Drawer: lock button locks the laptop
- [ ] Turning laptop WiFi off/on triggers reconnect without re-pairing
- [ ] Restarting the server requires re-pairing (old token rejected)
- [ ] Pairing a second phone disconnects the first with a visible message
