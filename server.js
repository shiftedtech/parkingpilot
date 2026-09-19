import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const LTA_ENDPOINT = "https://datamall2.mytransport.sg/ltaodataservice/CarParkAvailabilityv2";
const LTA_API_KEY = process.env.LTA_API_KEY;
const PORT = process.env.PORT || 8787;

if (!LTA_API_KEY) {
  console.warn(
    "[parkpilot-mcp] WARNING: LTA_API_KEY is not set. Every tool call will fail until it is."
  );
}

/**
 * LTA DataMall paginates CarParkAvailabilityv2 in pages of 500 records via
 * $skip. There is no documented total count, so we page until a request
 * comes back with fewer than 500 rows (or a hard cap, to stay well-behaved).
 */
async function fetchAllCarparks() {
  const all = [];
  let skip = 0;
  const pageSize = 500;
  const hardCapPages = 12; // ~6000 records ceiling, well above the known dataset size

  for (let page = 0; page < hardCapPages; page++) {
    const res = await fetch(`${LTA_ENDPOINT}?$skip=${skip}`, {
      headers: {
        AccountKey: LTA_API_KEY,
        accept: "application/json"
      }
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `LTA DataMall returned ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 300)}` : ""}`
      );
    }

    const json = await res.json();
    const batch = Array.isArray(json.value) ? json.value : [];
    all.push(...batch);

    if (batch.length < pageSize) break;
    skip += pageSize;
  }

  return all;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function parseLocation(loc) {
  // LTA returns "lat lon" as a single space-separated string, e.g. "1.32 103.85"
  if (typeof loc !== "string") return null;
  const parts = loc.trim().split(/\s+/).map(Number);
  if (parts.length !== 2 || parts.some(Number.isNaN)) return null;
  return { lat: parts[0], lng: parts[1] };
}

function shapeRecord(raw, from) {
  const pos = parseLocation(raw.Location);
  return {
    carParkId: raw.CarParkID,
    development: raw.Development,
    area: raw.Area,
    agency: raw.Agency, // HDB | LTA | URA
    lotType: raw.LotType, // C = car, M = motorcycle, H = heavy vehicle
    availableLots: Number(raw.AvailableLots),
    lat: pos ? pos.lat : null,
    lng: pos ? pos.lng : null,
    distanceKm:
      from && pos ? Number(haversineKm(from.lat, from.lng, pos.lat, pos.lng).toFixed(2)) : null
  };
}

const server = new McpServer({ name: "parkpilot-lta", version: "1.0.0" });

server.registerTool(
  "carpark_availability",
  {
    title: "Singapore carpark availability",
    description:
      "Live available-lot counts for public carparks in Singapore (HDB, LTA and URA), sourced from LTA DataMall's CarParkAvailabilityv2 feed (updates roughly once a minute). " +
      "Pass a latitude/longitude to get the nearest carparks sorted by distance; omit them to get the raw feed (capped at `limit`). " +
      "Coverage note: this feed mainly reports HDB multi-storey/surface carparks and some LTA/URA lots — it does not include most private mall or office-building carparks.",
    inputSchema: {
      lat: z.number().min(1).max(2).optional().describe("Latitude to search near, e.g. 1.2966 for Raffles Place"),
      lng: z.number().min(103).max(104.2).optional().describe("Longitude to search near, e.g. 103.8520 for Raffles Place"),
      radiusKm: z
        .number()
        .positive()
        .max(20)
        .optional()
        .describe("Only used with lat/lng. Max distance to include, in km. Default 2."),
      lotType: z
        .enum(["C", "M", "H"])
        .optional()
        .describe("Filter to one lot type: C = car, M = motorcycle, H = heavy vehicle. Default: all."),
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .describe("Max number of carparks to return. Default 20.")
    }
  },
  async ({ lat, lng, radiusKm, lotType, limit }) => {
    if (!LTA_API_KEY) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Server misconfiguration: LTA_API_KEY is not set on the MCP server host."
          }
        ]
      };
    }

    const from = typeof lat === "number" && typeof lng === "number" ? { lat, lng } : null;
    const cap = limit ?? 20;

    try {
      const raw = await fetchAllCarparks();
      let records = raw.map((r) => shapeRecord(r, from));

      if (lotType) {
        records = records.filter((r) => r.lotType === lotType);
      }
      if (from) {
        const radius = radiusKm ?? 2;
        records = records.filter((r) => r.distanceKm !== null && r.distanceKm <= radius);
        records.sort((a, b) => a.distanceKm - b.distanceKm);
      } else {
        records.sort((a, b) => b.availableLots - a.availableLots);
      }

      const results = records.slice(0, cap);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                fetchedAt: new Date().toISOString(),
                count: results.length,
                totalMatched: records.length,
                carparks: results
              },
              null,
              2
            )
          }
        ]
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to fetch carpark data: ${err.message}` }]
      };
    }
  }
);

const app = express();
app.use(express.json());

// Stateless mode: a fresh transport per request keeps things simple and
// horizontally scalable (no in-memory session affinity needed).
app.post("/mcp", async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[parkpilot-mcp] request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null
      });
    }
  }
});

// Streamable HTTP also defines GET (server->client stream) and DELETE
// (session teardown); not needed in stateless mode, but respond politely.
app.get("/mcp", (_req, res) => res.status(405).send("Method not allowed (stateless server)"));
app.delete("/mcp", (_req, res) => res.status(405).send("Method not allowed (stateless server)"));

app.get("/health", (_req, res) => res.json({ ok: true, hasApiKey: Boolean(LTA_API_KEY) }));

app.listen(PORT, () => {
  console.log(`[parkpilot-mcp] listening on :${PORT} (POST /mcp, GET /health)`);
});
