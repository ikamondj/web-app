# Song of the Night Web App

This directory contains a standalone progressive web app version of the song-of-the-night visual concept.

## Run locally

From this folder:

```powershell
node server.js
```

Then browse to:

- http://127.0.0.1:8080/
- http://127.0.0.1:8080/?width=16
- http://127.0.0.1:8080/?hud=1&width=128

The local server disables caching and handles URL query parameters correctly.

## Camera eye tracking

On a mobile device, add `camera=1` to request the rear camera and drive the
rendered blink and gaze from on-device face landmarks:

- `https://your-secure-host.example/?camera=1`
- `http://localhost:8080/?camera=1` (when opened on the same device)

Camera access requires user permission and either HTTPS or a localhost secure
context. The requested rear camera must be physically pointed at the user's
face. Tracking runs at a low resolution and frame rate to reduce power usage.

## Install on iPhone

1. Open the site in Safari.
2. Tap the share button.
3. Choose `Add to Home Screen`.
4. The app is then launched in standalone mode with the manifest.

## Inputs

- Gamepad support via the browser Gamepad API.
- Touch controls on the bottom-left and bottom-right pads for joystick-style control.
- The app can also be used on desktop browsers with Xbox/PlayStation/other supported controllers.
