# parkpilot-mcp

A small remote MCP server that exposes one tool, `carpark_availability`,
backed by LTA DataMall's live `CarParkAvailabilityv2` feed. Built so the
ParkPilot artifact can call it through claude.ai's `mcp` capability and show
real available-lot counts instead of sample data.

**Coverage note:** LTA DataMall's carpark feed mainly covers HDB
multi-storey/surface carparks and some LTA/URA lots. It does **not** include
most private mall or office-building carparks (Suntec, Wisma Atria, Marina
Bay Financial Centre, etc.) — there is no free public live-availability feed
for those. So "real data" here means real HDB carpark availability near a
destination, not the specific malls used in the demo.

## 1. Get an LTA DataMall API key

1. Go to https://datamall.lta.gov.sg/content/datamall/en/request-for-api.html
2. Register with an email address and verify it.
3. You'll get an `AccountKey` by email — that's your `LTA_API_KEY`.

Keep this key server-side only (in the deployment's environment variables).
Never put it in the artifact's HTML/JS — anyone viewing the page could read it.

## 2. Run it locally (optional, to sanity-check)

```bash
npm install
cp .env.example .env   # paste your key into .env
npm start
```

Then:

```bash
curl http://localhost:8787/health
# {"ok":true,"hasApiKey":true}
```

## 3. Deploy it somewhere public (this repo, already pushed)

It needs a public HTTPS URL — claude.ai connectors are remote MCP servers.
Any Node host works; Render's free tier is the least fiddly:

1. In Render: **New → Web Service** → connect this repo (shiftedtech/parkingpilot).
   - Build command: `npm install`
   - Start command: `npm start`
   - Add an environment variable `LTA_API_KEY` = your key.
2. Deploy. Render gives you a URL like `https://parkingpilot.onrender.com`.
3. Your MCP endpoint is that URL + `/mcp`, e.g.
   `https://parkingpilot.onrender.com/mcp`.
4. Check `https://parkingpilot.onrender.com/health` returns
   `{"ok":true,"hasApiKey":true}`.

(Render's free tier sleeps after inactivity — the first request after a
while takes a few seconds to wake up. Fly.io or Railway work the same way
if you'd rather avoid that.)

## 4. Add it as a claude.ai connector

1. In claude.ai: **Settings → Connectors → Add custom connector**.
2. Name it something like `ParkPilot LTA` and paste the `/mcp` URL from
   step 3.
3. Save. claude.ai will call `tools/list` on it and should show
   `carpark_availability`.

## 5. Tell Claude to wire it into the artifact

Once the connector shows up in claude.ai, tell Claude (in the ParkPilot
conversation) that it's added — Claude will declare the `mcp` capability on
the artifact with this connector/tool and switch the app over to live HDB
carpark data near whatever destination is searched.

## Tool reference

`carpark_availability(lat?, lng?, radiusKm?, lotType?, limit?)`

| param | type | notes |
|---|---|---|
| `lat`, `lng` | number | search center; omit both to get the raw feed sorted by most-available |
| `radiusKm` | number | only used with lat/lng, default 2 |
| `lotType` | `"C" \| "M" \| "H"` | car / motorcycle / heavy vehicle, default all |
| `limit` | number | max rows returned, default 20, max 200 |

Returns JSON: `{ fetchedAt, count, totalMatched, carparks: [{ carParkId, development, area, agency, lotType, availableLots, lat, lng, distanceKm }] }`.
