# Glasses app

The Even Hub web app that runs inside the Even phone app and draws on the G2. It is a thin client: it renders
the pages the gateway sends and forwards taps, swipes, motion and microphone audio. See `docs/glasses.md`.

## Run it
- `npm run dev -w @command-center/glasses`: serve the app for the phone
- `npm run qr -w @command-center/glasses`: show the pairing QR (Even app → Even Hub tab → Scan QR; needs
  developer mode: sign in at hub.evenrealities.com first)
- `npm run sim:app -w @command-center/glasses`: local-only copy for the desktop simulator

Ports and the gateway address come from `config/default.json` (`gateway.glasses`). With a certificate in
`run/tls` (`ts.crt`, `ts.key` from `tailscale cert`) the app is served over https at that name, which is what
lets the phone connect over cellular.

`app.json` lists only localhost in its network whitelist. Add your own gateway address there before
packaging the app for the Even Hub.
