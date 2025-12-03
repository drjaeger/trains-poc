Train POC

This is a small proof-of-concept frontend that:

- Uses the upstream WebSocket `wss://trainmap.pv.lv/ws` as the primary data source (active stops and schedules)
- Lists stations received from the websocket so you can pick one and see upcoming trains
- Estimates time-until-pass for trains relative to the selected station using scheduled times and (optionally) live position updates

Run locally

1. Install node/npm if you don't have it.
2. From this folder run:

```powershell
npm install
npm start
```

This will run `npx http-server` on port `3000` and you can open `http://localhost:3000`.
