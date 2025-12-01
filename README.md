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

Notes and limitations

Notes and limitations

- The frontend now relies primarily on the websocket `wss://trainmap.pv.lv/ws`. If that websocket provides `active-stops` and `back-end` schedule messages the app will function without any HTTP fetch.
- The POC still contains heuristics: it expects stops/schedules to include departure timestamps in a parseable format (YYYY-MM-DD HH:mm:ss or ISO). If departure times are missing the app may not show predictions.
- ETA is computed from scheduled departure times. The app can also compute speed/heading from live position updates for more advanced heuristics.

If you want, I can:
- Improve parsing for the exact websocket message format if you paste sample messages
- Re-add a proxy only if you need the HTTP graph endpoint or if the websocket origin is rejected by the server
- Add a hosted deployment recipe (GitHub Pages + Cloudflare Tunnel or a small server deploy)

Deployment (GitHub Pages)

1. Create a GitHub repository and push this project (or use the `gh` CLI):

```powershell
git init
git add .
git commit -m "Initial trains POC"
git branch -M main
# create a repo on GitHub manually or use `gh repo create` then push
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

2. Enable GitHub Pages from the repository `Settings -> Pages` and choose the `main` branch and `/ (root)` folder. After a few minutes your site will be available at `https://<your-username>.github.io/<your-repo>/`.

3. Local test:

```powershell
npx http-server -c-1 -p 3000 .
# open http://localhost:3000 in your browser
```

Notes:
- The app connects directly to `wss://trainmap.pv.lv/ws`. If the upstream websocket later rejects browser origins, you'll need to reintroduce a small proxy (server) to relay the websocket or host via a server that sets an acceptable Origin.
- No build step is required — this is a static site of HTML + vanilla JS.

If you want, I can create a ready `gh` CLI command or a GitHub Action to auto-deploy on push to `main`.
