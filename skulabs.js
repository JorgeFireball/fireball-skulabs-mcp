// Minimal SkuLabs REST client with request spacing and clear errors.
// Docs: https://www.skulabs.com/api/

const MIN_GAP_MS = 550; // SkuLabs allows ~2 requests/second per API key
const TIMEOUT_MS = 30_000;

let queue = Promise.resolve();
let lastCall = 0;

function schedule(fn) {
  const run = queue.then(async () => {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  queue = run.catch(() => {});
  return run;
}

export class SkuLabsError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function buildQuery(params = {}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    qs.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

export function createClient({ token, baseUrl = "https://api.skulabs.com", fetchImpl = fetch } = {}) {
  async function request(method, path, { query, body } = {}) {
    if (!token) {
      throw new SkuLabsError(
        "SKULABS_API_TOKEN is not set on the server. Add it in Render → fireball-skulabs-mcp → Environment.",
        0
      );
    }
    const url = baseUrl.replace(/\/$/, "") + path + buildQuery(query);
    return schedule(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let res;
      try {
        res = await fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
      } catch (err) {
        throw new SkuLabsError(
          err.name === "AbortError" ? "SkuLabs did not respond within 30 seconds." : `Could not reach SkuLabs: ${err.message}`,
          0
        );
      } finally {
        clearTimeout(timer);
      }

      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }

      if (!res.ok) {
        const e = data && typeof data === "object" ? data.error || data : {};
        let msg = `SkuLabs returned ${res.status}`;
        if (e.message) msg += `: ${e.message}`;
        if (res.status === 401) msg += " (the API token is missing, wrong or revoked)";
        if (res.status === 429) {
          const wait = e?.data?.wait_seconds;
          msg += wait ? ` (rate limited; SkuLabs says wait ${wait} seconds before retrying)` : " (rate limited)";
        }
        throw new SkuLabsError(msg, res.status, data);
      }
      return data;
    });
  }

  return {
    get: (path, query) => request("GET", path, { query }),
    post: (path, body) => request("POST", path, { body }),
    send: (method, path, body) => request(method, path, { body }),
  };
}
