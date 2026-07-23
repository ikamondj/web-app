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

## Install on iPhone

1. Open the site in Safari.
2. Tap the share button.
3. Choose `Add to Home Screen`.
4. The app is then launched in standalone mode with the manifest.

## Inputs

- Gamepad support via the browser Gamepad API.
- Touch controls on the bottom-left and bottom-right pads for joystick-style control.
- The app can also be used on desktop browsers with Xbox/PlayStation/other supported controllers.
