// Fireball Tool – SkuLabs MCP server
// Lets Claude (custom connector) read data from the Fireball Tool SkuLabs account.
//
// Environment variables (set in Render → Environment):
//   SKULABS_API_TOKEN  required  SkuLabs API key (Settings → Advanced → API in SkuLabs)
//   MCP_SECRET         required  Long random string; the connector URL is /mcp/<MCP_SECRET>
//   ALLOW_WRITES       optional  "true" adds a tool that can change SkuLabs data. Off by default.
//   SKULABS_BASE_URL   optional  Defaults to https://api.skulabs.com
//   PORT               optional  Set by Render

import crypto from "node:crypto";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClient, SkuLabsError } from "./skulabs.js";
import { catalogText, isReadAction, READ_ONLY_POST, KNOWN_PATHS } from "./catalog.js";

const PORT = Number(process.env.PORT) || 10000;
const MCP_SECRET = process.env.MCP_SECRET || "";
const ALLOW_WRITES = String(process.env.ALLOW_WRITES || "").toLowerCase() === "true";
const MAX_CHARS = 60_000;

export function buildServer(client) {
  const server = new McpServer(
    { name: "fireball-skulabs", version: "1.0.0" },
    {
      instructions:
        "Tools for the Fireball Tool SkuLabs account (inventory, items, orders, shipments, purchase orders, customers). " +
        "IDs: most filters need SkuLabs IDs (_id), so look them up first (e.g. skulabs_list_stores for store_id, skulabs_search_items for item IDs). " +
        "List endpoints accept a MongoDB-style 'selector' object, e.g. {\"status\": {\"$in\": [\"shipped\"]}}. " +
        "SkuLabs allows about 2 requests per second, so prefer fewer, larger requests. " +
        (ALLOW_WRITES
          ? "skulabs_write can change live data: confirm with the user before every write."
          : "This server is read-only; it cannot change SkuLabs data."),
    }
  );

  const READ = { readOnlyHint: true, openWorldHint: true };

  const ok = (data) => {
    let text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    if (text.length > MAX_CHARS) {
      text =
        text.slice(0, MAX_CHARS) +
        `\n\n[Truncated: response was ${text.length.toLocaleString()} characters. Use a smaller limit, a narrower selector, or 'fields' to return fewer fields.]`;
    }
    return { content: [{ type: "text", text }] };
  };

  const fail = (err) => ({
    isError: true,
    content: [
      {
        type: "text",
        text:
          err instanceof SkuLabsError
            ? `${err.message}${err.details && typeof err.details === "object" ? `\n${JSON.stringify(err.details, null, 2).slice(0, 4000)}` : ""}`
            : `Unexpected error: ${err?.message || err}`,
      },
    ],
  });

  const run = (fn) => async (args) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };

  const jsonObject = z.record(z.string(), z.any());
  const limit = z.number().int().min(1).max(100).default(25).describe("Max results (1-100)");
  const skip = z.number().int().min(0).default(0).describe("Results to skip, for paging");
  const sort = jsonObject.optional().describe('Sort, e.g. {"name": 1} ascending or {"date": -1} descending');
  const fields = jsonObject.optional().describe('Only return these fields, e.g. {"sku": 1, "name": 1}');
  const selector = jsonObject.optional().describe("Extra MongoDB-style filter merged into the query");

  server.registerTool(
    "skulabs_list_stores",
    { title: "List stores", description: "List the sales channels/stores connected to SkuLabs (Shopify, Amazon, manual…). Returns each store's _id, name and type; store_id is needed by order tools.", inputSchema: {}, annotations: READ },
    run(() => client.get("/store/get"))
  );

  server.registerTool(
    "skulabs_list_warehouses",
    { title: "List warehouses", description: "List SkuLabs warehouses with their _id, name, address and default flag.", inputSchema: { limit, skip }, annotations: READ },
    run(({ limit, skip }) => client.get("/warehouse/get", { selector: {}, limit, skip }))
  );

  server.registerTool(
    "skulabs_search_items",
    {
      title: "Search items",
      description: "Find items (products) by exact SKU, by part of the name, or by a custom selector. Returns item records including _id, sku, name, upc, cost, retail.",
      inputSchema: {
        sku: z.string().optional().describe("Exact SKU"),
        name_contains: z.string().optional().describe("Case-insensitive text the item name contains"),
        selector,
        fields,
        sort,
        limit,
        skip,
      },
      annotations: READ,
    },
    run(({ sku, name_contains, selector, fields, sort, limit, skip }) => {
      const sel = { ...(selector || {}) };
      if (sku) sel.sku = sku;
      if (name_contains) sel.name = { $regex: name_contains.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
      return client.get("/item/get", { selector: sel, limit, skip, sort, fields });
    })
  );

  server.registerTool(
    "skulabs_find_item_by_barcode",
    { title: "Find item by barcode", description: "Look up items by UPC/barcode.", inputSchema: { barcode: z.string() }, annotations: READ },
    run(({ barcode }) => client.get("/item/find_by_barcode", { barcode }))
  );

  server.registerTool(
    "skulabs_get_available_stock",
    {
      title: "Get available stock for a SKU",
      description: "Get on-hand, reserved (by open orders) and free/available quantity for one SKU across warehouses.",
      inputSchema: {
        sku: z.string(),
        warehouse_ids: z.array(z.string()).optional().describe("Limit to these warehouse _ids"),
      },
      annotations: READ,
    },
    run(({ sku, warehouse_ids }) => client.get("/inventory/get_item_free", { sku, warehouse_ids }))
  );

  server.registerTool(
    "skulabs_get_inventory_by_location",
    {
      title: "Get inventory by location",
      description: "Get on-hand and inbound quantities per bin/location for specific item _ids (get the _ids from skulabs_search_items).",
      inputSchema: {
        item_ids: z.array(z.string()).min(1).max(200),
        warehouse_ids: z.array(z.string()).optional(),
      },
      annotations: READ,
    },
    run(({ item_ids, warehouse_ids }) => client.post("/inventory/get_items", { item_ids, ...(warehouse_ids ? { warehouse_ids } : {}) }))
  );

  server.registerTool(
    "skulabs_list_orders",
    {
      title: "List orders",
      description:
        "List orders, newest first by default. Filter by status, store, order number or a custom selector. Status values: unstarted, in_progress, shipped, cancelled, cleared, delayed, stopped, partially shipped, archived, awaiting fulfillment, pending, partially cleared.",
      inputSchema: {
        status: z.array(z.string()).optional().describe('e.g. ["awaiting fulfillment"]'),
        store_id: z.string().optional(),
        order_number: z.string().optional(),
        selector,
        fields,
        sort,
        limit,
        skip,
      },
      annotations: READ,
    },
    run(({ status, store_id, order_number, selector, fields, sort, limit, skip }) => {
      const sel = { ...(selector || {}) };
      if (status?.length) sel.status = { $in: status };
      if (store_id) sel.store_id = store_id;
      if (order_number) sel.order_number = order_number;
      return client.get("/order/get", { selector: sel, limit, skip, sort: sort || { _id: -1 }, fields });
    })
  );

  server.registerTool(
    "skulabs_get_order",
    {
      title: "Get one order",
      description: "Get full detail for a single order (items, shipments, notes, log). Needs the store _id (from skulabs_list_stores) and the order number.",
      inputSchema: { store_id: z.string(), order_number: z.string() },
      annotations: READ,
    },
    run(({ store_id, order_number }) => client.get("/order/get_single", { store_id, order_number }))
  );

  server.registerTool(
    "skulabs_get_shipments",
    {
      title: "Get shipments by date range",
      description: "Get orders with shipments (carrier, service, tracking, cost) created in a date range.",
      inputSchema: {
        start: z.string().optional().describe("ISO 8601, e.g. 2026-10-01T00:00:00.000Z"),
        end: z.string().optional().describe("ISO 8601"),
        page: z.number().int().min(1).optional(),
        simple: z.boolean().default(true).describe("Fewer fields per order (recommended)"),
      },
      annotations: READ,
    },
    run((args) => client.get("/shipments/get_by_range", args))
  );

  server.registerTool(
    "skulabs_list_purchase_orders",
    {
      title: "List purchase orders",
      description: "List purchase orders. Status values: created, sent, acknowledged, edited, transit, receiving, accepting, closed.",
      inputSchema: { status: z.array(z.string()).optional(), selector, sort, limit, skip },
      annotations: READ,
    },
    run(({ status, selector, sort, limit, skip }) => {
      const sel = { ...(selector || {}) };
      if (status?.length) sel.status = { $in: status };
      return client.get("/purchase_order/get", { selector: sel, limit, skip, sort: sort || { _id: -1 } });
    })
  );

  server.registerTool(
    "skulabs_list_customers",
    { title: "List customers", description: "List or filter customers.", inputSchema: { selector, sort, limit, skip }, annotations: READ },
    run(({ selector, sort, limit, skip }) => client.get("/customer/get_customers", { selector: selector || {}, limit, skip, sort }))
  );

  server.registerTool(
    "skulabs_list_endpoints",
    {
      title: "List all SkuLabs endpoints",
      description: "Show every SkuLabs API endpoint path, split into read and write. Use with skulabs_read for anything the other tools don't cover. Full parameter docs: https://www.skulabs.com/api/",
      inputSchema: {},
      annotations: READ,
    },
    run(() => catalogText() + (ALLOW_WRITES ? "" : "\n\n(Write endpoints are disabled on this server.)"))
  );

  server.registerTool(
    "skulabs_read",
    {
      title: "Call any read-only SkuLabs endpoint",
      description:
        "Call a read-only SkuLabs endpoint not covered by the other tools, e.g. /kit/get, /inventory/get_history, /transfer_order/get_all. Object-valued params (selector, sort, fields) are sent as JSON. Only 'get…'/'find…'/report endpoints are allowed.",
      inputSchema: {
        path: z.string().regex(/^\/[a-z_]+\/[a-z0-9_]+$/).describe("e.g. /kit/get"),
        params: jsonObject.optional().describe("Query parameters (or JSON body for POST-only read endpoints)"),
      },
      annotations: READ,
    },
    run(({ path, params }) => {
      const action = path.split("/")[2];
      if (!isReadAction(action) && !READ_ONLY_POST.has(path)) {
        throw new SkuLabsError(`${path} changes data, so skulabs_read won't call it.${ALLOW_WRITES ? " Use skulabs_write." : " This server is read-only."}`, 0);
      }
      if (READ_ONLY_POST.has(path)) return client.post(path, params || {});
      return client.get(path, params);
    })
  );

  if (ALLOW_WRITES) {
    server.registerTool(
      "skulabs_write",
      {
        title: "Change data in SkuLabs",
        description:
          "Call a SkuLabs endpoint that CHANGES live data (e.g. /order/add_note, /inventory/increase_on_hand). Always describe the exact change to the user and get their confirmation first.",
        inputSchema: {
          path: z.string().regex(/^\/[a-z_]+\/[a-z0-9_]+$/),
          body: jsonObject.describe("JSON body"),
          method: z.enum(["POST", "PUT", "DELETE"]).default("POST"),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      run(({ path, body }) => {
        if (!KNOWN_PATHS.has(path)) throw new SkuLabsError(`${path} is not a known SkuLabs endpoint. Check skulabs_list_endpoints.`, 0);
        return client.post(path, body);
      })
    );
  }

  return server;
}

function secretMatches(candidate) {
  if (!MCP_SECRET || !candidate) return false;
  const a = crypto.createHash("sha256").update(candidate).digest();
  const b = crypto.createHash("sha256").update(MCP_SECRET).digest();
  return crypto.timingSafeEqual(a, b);
}

export function buildApp(client) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/", (_req, res) => res.type("text").send("Fireball Tool SkuLabs MCP server"));
  app.get("/healthz", (_req, res) =>
    res.json({ ok: true, token_configured: Boolean(process.env.SKULABS_API_TOKEN), secret_configured: Boolean(MCP_SECRET), writes_enabled: ALLOW_WRITES })
  );

  const handle = async (req, res) => {
    const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!secretMatches(req.params.secret || bearer)) {
      return res.status(404).json({ error: "Not found" });
    }
    if (req.method !== "POST") {
      return res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
    }
    const server = buildServer(client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request failed:", err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  };

  app.all("/mcp/:secret", handle);
  app.all("/mcp", handle);
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!MCP_SECRET || MCP_SECRET.length < 24) {
    console.error("MCP_SECRET must be set to a random string of at least 24 characters. Refusing to start.");
    process.exit(1);
  }
  if (!process.env.SKULABS_API_TOKEN) {
    console.warn("SKULABS_API_TOKEN is not set yet. The server will run, but SkuLabs calls will fail until it is added.");
  }
  const client = createClient({ token: process.env.SKULABS_API_TOKEN, baseUrl: process.env.SKULABS_BASE_URL || undefined });
  const httpServer = buildApp(client).listen(PORT, () => {
    console.log(`Fireball SkuLabs MCP listening on ${PORT} (writes ${ALLOW_WRITES ? "ENABLED" : "disabled"})`);
  });
  process.on("SIGTERM", () => httpServer.close(() => process.exit(0)));
}
