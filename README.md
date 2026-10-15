# Fireball Tool – SkuLabs MCP server

Connects Claude (as a custom connector) to the Fireball Tool SkuLabs account. Read-only by default.

## Environment variables (Render → Environment)

| Variable | Required | What it is |
|---|---|---|
| `SKULABS_API_TOKEN` | yes | SkuLabs API key (SkuLabs → Settings → Advanced → API) |
| `MCP_SECRET` | yes | Long random string. The connector URL is `https://<service>.onrender.com/mcp/<MCP_SECRET>` |
| `ALLOW_WRITES` | no | Set to `true` to add a `skulabs_write` tool that can change SkuLabs data |
| `SKULABS_BASE_URL` | no | Defaults to `https://api.skulabs.com` |

Requests to `/mcp` without the correct secret get a 404. `GET /healthz` reports whether the token and secret are configured (never their values).

## Tools

List stores, list warehouses, search items, find item by barcode, available stock for a SKU, inventory by location, list orders, get one order, shipments by date range, list purchase orders, list customers, list all endpoints, and a generic read tool for any other `get…` endpoint.

## Develop

```
npm install
npm test        # runs against a fake SkuLabs API
```

To rotate the connector URL, change `MCP_SECRET` in Render and update the URL in Claude's connector settings.
