const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { Readable } = require("node:stream");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "server.js"), "utf8");
const params = { current: 1, pageSize: 20, pages: 1, fetchAllPages: false, keywords: "fixture", goodsType: "card" };

function createHarness(options = {}) {
  const calls = [];
  const clock = { now: Date.now() };
  const context = vm.createContext({
    require(name) {
      if (name === "fs") return { mkdirSync() {}, writeFileSync() {} };
      return require(name);
    },
    __dirname: root,
    process: { env: {} },
    console,
    URL,
    AbortSignal,
    Date: class extends Date { static now() { return clock.now; } },
    setTimeout(callback) { callback(); },
    async fetch(url, request) {
      const call = { path: new URL(url).pathname, payload: JSON.parse(request.body) };
      calls.push(call);
      if (call.path.endsWith("/searchGoodsList")) {
        const list = options.goods || [{ id: 1, user_id: 42, goods_key: "product-key", name: "Fixture product", user: { nickname: "Same name" } }];
        return Response.json({ code: 1, data: { list, total: list.length } });
      }
      if (call.path.endsWith("/GoodsPool/list")) {
        if (options.directory) return options.directory(call.payload, calls);
        return Response.json({ code: 1, data: { total: 2, list: [
          { user: { id: 99, nickname: "Same name", agent_key: "wrong-supplier" } },
          { user: { id: "42", nickname: "Different name", agent_key: "0072" } }
        ] } });
      }
      throw new Error(`Unexpected endpoint: ${call.path}`);
    }
  });
  vm.runInContext(source.slice(0, source.indexOf("const server = http.createServer")) +
    "\nglobalThis.subject = { fetchSearchResults, handleSearchStart, handleSearchStatus, handleSearchCancel, handleLogout, sessions };", context);
  const session = { platformId: "ldxp", token: "fixture-token", username: "fixture-user", remoteCookies: {}, createdAt: clock.now };
  context.subject.sessions.set("fixture-sid", session);
  return { ...context.subject, session, calls, clock };
}

async function request(handler, url, payload) {
  const req = Readable.from(payload === undefined ? [] : [JSON.stringify(payload)]);
  req.url = url;
  req.headers = { cookie: "sid=fixture-sid" };
  let status;
  let result;
  await handler(req, {
    writeHead(value) { status = value; },
    end(body) { result = JSON.parse(body); }
  });
  return { status, result };
}

test("matches supplier IDs rather than names or product keys, preserving leading zeros", async () => {
  const h = createHarness();
  const result = await h.fetchSearchResults(h.session, params);
  assert.equal(result.list[0].supplier_agent_key, "0072");
  assert.equal(result.list[0].supplier_code_status, "available");
  assert.equal(result.list[0].goods_key, "product-key");
  assert.equal(result.supplier_code_warning, "");
});

test("reads every supplier directory page", async () => {
  const h = createHarness({ directory({ current, pageSize, tags_id }) {
    assert.equal(pageSize, 100);
    assert.equal(tags_id, 0);
    const list = current === 1
      ? Array.from({ length: 100 }, (_, i) => ({ user: { id: 1000 + i, agent_key: `key-${i}` } }))
      : [{ user: { id: 42, agent_key: "second-page" } }];
    return Response.json({ code: 1, data: { list, total: 101 } });
  } });
  const result = await h.fetchSearchResults(h.session, params);
  assert.equal(result.list[0].supplier_agent_key, "second-page");
  assert.deepEqual(h.calls.filter(c => c.path.endsWith("/GoodsPool/list")).map(c => c.payload.current), [1, 2]);
});

test("reuses the directory for the same account and refreshes after ten minutes", async () => {
  const h = createHarness();
  await h.fetchSearchResults(h.session, params);
  await h.fetchSearchResults({ ...h.session }, params);
  assert.equal(h.calls.filter(c => c.path.endsWith("/GoodsPool/list")).length, 1);
  h.clock.now += 10 * 60 * 1000 + 1;
  await h.fetchSearchResults(h.session, params);
  assert.equal(h.calls.filter(c => c.path.endsWith("/GoodsPool/list")).length, 2);
});

test("isolates directory caches by account", async () => {
  const h = createHarness();
  await h.fetchSearchResults(h.session, params);
  await h.fetchSearchResults({ ...h.session, token: "different-fixture-token" }, params);
  assert.equal(h.calls.filter(c => c.path.endsWith("/GoodsPool/list")).length, 2);
});

test("logout invalidates the account directory cache", async () => {
  const h = createHarness();
  await h.fetchSearchResults(h.session, params);
  assert.equal((await request(h.handleLogout, "/api/logout")).status, 200);
  await h.fetchSearchResults(h.session, params);
  assert.equal(h.calls.filter(c => c.path.endsWith("/GoodsPool/list")).length, 2);
});

test("keeps goods on lookup failure and retries on the next search", async () => {
  let fail = true;
  const h = createHarness({ directory() {
    if (fail) throw new Error("Fixture network failure");
    return Response.json({ code: 1, data: { total: 1, list: [{ user: { id: 42, agent_key: "restored" } }] } });
  } });
  const failed = await h.fetchSearchResults(h.session, params);
  assert.equal(failed.list.length, 1);
  assert.equal(failed.list[0].supplier_agent_key, null);
  assert.equal(failed.list[0].supplier_code_status, "unavailable");
  assert.ok(failed.supplier_code_warning);
  fail = false;
  const recovered = await h.fetchSearchResults(h.session, params);
  assert.equal(recovered.list[0].supplier_agent_key, "restored");
  assert.equal(recovered.supplier_code_warning, "");
});

for (const [label, payload] of [
  ["remote business error", { code: 0, msg: "Fixture denied" }],
  ["malformed response", { code: 1, data: { total: 1 } }],
  ["short directory pages", { code: 1, data: { total: 101, list: [{ user: { id: 42, agent_key: "partial" } }] } }],
  ["incomplete pagination", { code: 1, data: { total: 1, list: [] } }]
]) {
  test(`distinguishes ${label} from an unmatched supplier`, async () => {
    const h = createHarness({ directory: () => Response.json(payload) });
    const result = await h.fetchSearchResults(h.session, params);
    assert.equal(result.list[0].supplier_code_status, "unavailable");
    assert.ok(result.supplier_code_warning);
  });
}

test("does not guess a supplier code when no ID matches", async () => {
  const h = createHarness({ goods: [{ user_id: 777, goods_key: "0072", user: { nickname: "Same name" } }] });
  const result = await h.fetchSearchResults(h.session, params);
  assert.equal(result.list[0].supplier_agent_key, null);
  assert.equal(result.list[0].supplier_code_status, "not_found");
  assert.equal(result.supplier_code_warning, "");
});

test("preserves codes supplied with goods and avoids unnecessary directory reads", async () => {
  const h = createHarness({ goods: [{ user_id: 42, user: { agent_key: "0000" } }] });
  const result = await h.fetchSearchResults(h.session, params);
  assert.equal(result.list[0].supplier_agent_key, "0000");
  assert.equal(h.calls.length, 1);
});

test("empty searches do not read the directory", async () => {
  const h = createHarness({ goods: [] });
  const result = await h.fetchSearchResults(h.session, params);
  assert.equal(result.list.length, 0);
  assert.equal(h.calls.length, 1);
});

test("other platforms retain goods without calling an unverified endpoint", async () => {
  const h = createHarness();
  const result = await h.fetchSearchResults({ ...h.session, platformId: "catfk" }, params);
  assert.equal(result.list[0].supplier_code_status, "unsupported");
  assert.equal(h.calls.length, 1);
});

test("cancellation during supplier lookup stays cancelled and does not cache results", async () => {
  const job = { cancelled: false };
  let cancel = true;
  const h = createHarness({ directory() {
    if (cancel) job.cancelled = true;
    return Response.json({ code: 1, data: { total: 1, list: [{ user: { id: 42, agent_key: "fixture" } }] } });
  } });
  await assert.rejects(h.fetchSearchResults(h.session, params, job), { name: "SearchCancelledError" });
  cancel = false;
  await h.fetchSearchResults(h.session, params);
  assert.equal(h.calls.filter(c => c.path.endsWith("/GoodsPool/list")).length, 2);
});

test("the asynchronous search endpoint includes enriched results and supplier progress", async () => {
  const h = createHarness();
  const started = await request(h.handleSearchStart, "/api/search/start", { keywords: "fixture", pages: 1 });
  assert.equal(started.status, 200);
  let status;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
    status = await request(h.handleSearchStatus, `/api/search/status?id=${started.result.jobId}`);
    if (status.result.status !== "running") break;
  }
  assert.equal(status.result.status, "done");
  assert.equal(status.result.result.list[0].supplier_agent_key, "0072");
  assert.equal(status.result.phase, "suppliers");
  assert.equal(status.result.supplierLoadedPages, 1);
});

test("frontend escapes supplier codes and keeps all seven columns", () => {
  const frontend = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, { value: "", innerHTML: "", textContent: "", classList: { add() {}, remove() {}, toggle() {} } });
    return elements.get(selector);
  }
  const context = vm.createContext({ document: { querySelector: element } });
  vm.runInContext(frontend.slice(0, frontend.indexOf("function setLoading")) +
    '\nstate.list = [{ name: "Fixture", supplier_agent_key: "<img src=x onerror=alert(1)>", stock_count: 1, status: 1, price: 1 }]; renderTable();', context);
  const html = element("#resultBody").innerHTML;
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/);
  assert.equal((html.match(/<td\b/g) || []).length, 7);
  const page = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  assert.equal((page.match(/<th>/g) || []).length, 7);
  assert.doesNotMatch(frontend + page, /colspan="6"/);
});
