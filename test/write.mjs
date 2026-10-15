// Write-mode test: with ALLOW_WRITES=true, skulabs_write must send the requested HTTP method.
import assert from "node:assert/strict";

process.env.MCP_SECRET = "test-secret-1234567890abcdefghij";
process.env.ALLOW_WRITES = "true";

const { buildApp } = await import("../server.js");
const { createClient } = await import("../skulabs.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

const calls = [];
const fakeFetch = async (url, init) => {
  calls.push({ method: init.method, path: new URL(url).pathname, body: init.body });
  return new Response(JSON.stringify({ success: true }), { status: 200 });
};

const client = createClient({ token: "tok_test", fetchImpl: fakeFetch });
const server = buildApp(client).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

try {
  const mcp = new Client({ name: "write-test", version: "1" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${process.env.MCP_SECRET}`)));

  const { tools } = await mcp.listTools();
  assert.ok(tools.some((t) => t.name === "skulabs_write"), "write tool must be present when ALLOW_WRITES=true");

  const body = { location_id: "l1", item_id: "i1", amount: 3 };
  await mcp.callTool({ name: "skulabs_write", arguments: { path: "/inventory/increase_on_hand", method: "PUT", body } });
  assert.equal(calls.at(-1).method, "PUT");
  assert.equal(calls.at(-1).path, "/inventory/increase_on_hand");
  assert.deepEqual(JSON.parse(calls.at(-1).body), body);

  await mcp.callTool({ name: "skulabs_write", arguments: { path: "/order/add_note", body: { note: "x" } } });
  assert.equal(calls.at(-1).method, "POST", "method defaults to POST");

  await mcp.close();
  console.log("All write tests passed.");
} finally {
  server.close();
}
