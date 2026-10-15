// Smoke test: runs the server against a fake SkuLabs API and exercises it through a real MCP client.
import assert from "node:assert/strict";

process.env.MCP_SECRET = "test-secret-1234567890abcdefghij";
delete process.env.ALLOW_WRITES;

const { buildApp } = await import("../server.js");
const { createClient } = await import("../skulabs.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

const calls = [];
const fakeFetch = async (url, init) => {
  const u = new URL(url);
  calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: init.body, auth: init.headers.Authorization });
  if (u.pathname === "/store/get") return new Response(JSON.stringify([{ _id: "s1", name: "Fireball Shopify", type: "shopify" }]), { status: 200 });
  if (u.pathname === "/inventory/get_item_free") return new Response(JSON.stringify({ free: 5, on_hand: 7, reserved: 2 }), { status: 200 });
  if (u.pathname === "/order/get_single") return new Response(JSON.stringify({ error: { message: "Order not found", statusCode: 400 } }), { status: 400 });
  return new Response(JSON.stringify([]), { status: 200 });
};

const client = createClient({ token: "tok_test", fetchImpl: fakeFetch });
const server = buildApp(client).listen(0);
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

try {
  // Wrong secret is rejected
  let r = await fetch(`${base}/mcp/wrong-secret`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 404);
  r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 404);
  r = await fetch(`${base}/healthz`);
  assert.equal((await r.json()).ok, true);

  const mcp = new Client({ name: "smoke", version: "1" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${process.env.MCP_SECRET}`)));

  const { tools } = await mcp.listTools();
  const names = tools.map((t) => t.name);
  console.log("tools:", names.join(", "));
  assert.ok(names.includes("skulabs_list_orders"));
  assert.ok(!names.includes("skulabs_write"), "write tool must be absent by default");
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));

  let res = await mcp.callTool({ name: "skulabs_list_stores", arguments: {} });
  assert.match(res.content[0].text, /Fireball Shopify/);
  assert.equal(calls.at(-1).auth, "Bearer tok_test");

  res = await mcp.callTool({ name: "skulabs_get_available_stock", arguments: { sku: "FB-100" } });
  assert.match(res.content[0].text, /"free": 5/);

  await mcp.callTool({ name: "skulabs_list_orders", arguments: { status: ["awaiting fulfillment"], limit: 5 } });
  let c = calls.at(-1);
  assert.equal(c.path, "/order/get");
  assert.deepEqual(JSON.parse(c.query.selector), { status: { $in: ["awaiting fulfillment"] } });
  assert.equal(c.query.limit, "5");

  await mcp.callTool({ name: "skulabs_search_items", arguments: { name_contains: "drill bit" } });
  c = calls.at(-1);
  assert.deepEqual(JSON.parse(c.query.selector), { name: { $regex: "drill bit", $options: "i" } });

  await mcp.callTool({ name: "skulabs_get_inventory_by_location", arguments: { item_ids: ["i1", "i2"] } });
  c = calls.at(-1);
  assert.equal(c.method, "POST");
  assert.deepEqual(JSON.parse(c.body), { item_ids: ["i1", "i2"] });

  res = await mcp.callTool({ name: "skulabs_get_order", arguments: { store_id: "s1", order_number: "X" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Order not found/);

  const before = calls.length;
  res = await mcp.callTool({ name: "skulabs_read", arguments: { path: "/inventory/increase_on_hand", params: {} } });
  assert.equal(res.isError, true);
  assert.equal(calls.length, before, "write endpoint must not be called");

  res = await mcp.callTool({ name: "skulabs_read", arguments: { path: "/kit/get", params: { selector: {}, limit: 2 } } });
  assert.equal(calls.at(-1).path, "/kit/get");

  res = await mcp.callTool({ name: "skulabs_list_endpoints", arguments: {} });
  assert.match(res.content[0].text, /\/order\/get_single/);

  await mcp.close();
  console.log("All smoke tests passed.");
} finally {
  server.close();
}
