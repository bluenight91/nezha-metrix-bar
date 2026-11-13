import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify({ data }); },
  };
}

function loadDashboard({ fetchImpl, secrets = {}, autoOpen = false, dateImpl = Date, platform = "darwin" }) {
  const source = fs.readFileSync(new URL("./nezha.bar", import.meta.url), "utf8");
  const match = source.match(/<script[^>]*><!\[CDATA\[([\s\S]*)\]\]><\/script>/);
  assert.ok(match, "dashboard script exists");
  const code = match[1].replace("export default", "globalThis.dashboard =");
  const sockets = [];
  const notifications = [];
  const invalidations = [];
  const storage = new Map();
  class MockWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.closed = false;
      sockets.push(this);
      if (autoOpen) queueMicrotask(() => {
        if (this.closed) return;
        this.readyState = 1;
        this.onopen?.();
      });
    }
    close() { this.closed = true; this.readyState = 3; }
  }
  const context = vm.createContext({
    console,
    URL,
    Intl,
    Date: dateImpl,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl,
    WebSocket: MockWebSocket,
    Notification: class {
      constructor(title, options) { notifications.push({ title, options }); }
    },
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, String(value)); },
    },
    $metrix: {
      platform,
      env: { locale: "zh-CN" },
      secret(name) { return secrets[name] || ""; },
      schedule() {},
      invalidate() { invalidations.push(Date.now()); },
      openURL() {},
    },
  });
  vm.runInContext(code, context);
  return { dashboard: context.dashboard, sockets, notifications, invalidations, storage, context };
}

test("changing Dashboard URL closes the old WebSocket before connecting", async () => {
  const now = new Date().toISOString();
  const { dashboard, sockets } = loadDashboard({
    fetchImpl: async url => {
      const u = new URL(url);
      if (u.pathname === "/api/v1/setting") return response({ config: { site_name: u.hostname } });
      if (u.pathname === "/api/v1/server") {
        const first = u.hostname === "one.example.com";
        return response([{ id: first ? 1 : 2, name: first ? "one" : "two", last_active: now, state: {} }]);
      }
      if (u.pathname === "/api/v1/service") return response({ services: {} });
      return response([]);
    },
  });

  await dashboard.scheduled({ inputs: { baseURL: "https://one.example.com" } });
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].closed, false);

  await dashboard.scheduled({ inputs: { baseURL: "https://two.example.com" } });
  assert.equal(sockets[0].closed, true);
  assert.equal(sockets.length, 2);
  const view = JSON.stringify(dashboard.render({ inputs: { baseURL: "https://two.example.com" } }));
  assert.ok(view.includes("two"));
  assert.ok(!view.includes('"one"'));
});


function findNode(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  for (const child of node.children || []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

function basicPayload(pathname) {
  if (pathname === "/api/v1/setting") return { config: { site_name: "Demo" } };
  if (pathname === "/api/v1/server") {
    return [{ id: 1, name: "one", last_active: new Date().toISOString(), state: {}, host: {} }];
  }
  if (pathname === "/api/v1/service") return { services: {} };
  return [];
}

test("liveUpdates=false disables WebSocket in guest mode", async () => {
  const { dashboard, sockets } = loadDashboard({
    fetchImpl: async url => response(basicPayload(new URL(url).pathname)),
  });
  await dashboard.scheduled({ inputs: { baseURL: "https://one.example.com", liveUpdates: false } });
  assert.equal(sockets.length, 0);
});

test("healthy WebSocket avoids a REST server refresh on the next fast tick", async () => {
  const calls = [];
  const { dashboard } = loadDashboard({
    autoOpen: true,
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      calls.push(pathname);
      return response(basicPayload(pathname));
    },
  });
  const env = { inputs: { baseURL: "https://one.example.com", liveUpdates: true } };
  await dashboard.scheduled(env);
  await Promise.resolve();
  calls.length = 0;
  await dashboard.scheduled(env);
  assert.ok(!calls.includes("/api/v1/server"));
});

test("opening the same server detail twice deduplicates the parallel metric batch", async () => {
  let metricCalls = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { dashboard } = loadDashboard({
    secrets: { apiToken: "test-token" },
    fetchImpl: async url => {
      const u = new URL(url);
      if (u.pathname.endsWith("/metrics")) {
        metricCalls += 1;
        await pending;
        return response({ data_points: [] });
      }
      return response(basicPayload(u.pathname));
    },
  });
  const env = { inputs: { baseURL: "https://one.example.com" } };
  await dashboard.scheduled(env);
  const panel = dashboard.render(env).panel;
  const card = findNode(panel, node => node.props?.key === "srv-1");
  assert.ok(card);
  try {
    card.props.onClick();
    await Promise.resolve();
    card.props.onClick();
    await Promise.resolve();
    assert.equal(metricCalls, 4);
  } finally {
    release();
  }
});


test("PAT fast ticks refresh only servers while slower domains remain fresh", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1760000000000 });
  const calls = [];
  const { dashboard, sockets } = loadDashboard({
    secrets: { apiToken: "test-token" },
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      calls.push(pathname);
      return response(basicPayload(pathname));
    },
  });
  const env = { inputs: { baseURL: "https://one.example.com", liveUpdates: true } };
  await dashboard.scheduled(env);
  calls.length = 0;
  t.mock.timers.tick(5000);
  await dashboard.scheduled(env);
  assert.deepEqual(calls, ["/api/v1/server"]);
  assert.equal(sockets.length, 0);
});

test("an aborted slow request surfaces a timeout instead of blocking forever", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { dashboard } = loadDashboard({
    secrets: { apiToken: "test-token" },
    fetchImpl: async (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    }),
  });
  const env = { inputs: { baseURL: "https://one.example.com" } };
  const pending = dashboard.scheduled(env);
  await Promise.resolve();
  t.mock.timers.tick(10000);
  await pending;
  const tray = dashboard.render(env).tray;
  assert.equal(tray.error, "Request timeout");
});


test("server overview and cards use continuous two-node bars instead of segmented Boxes", async () => {
  const { dashboard } = loadDashboard({
    secrets: { apiToken: "test-token" },
    fetchImpl: async url => response(basicPayload(new URL(url).pathname)),
  });
  const env = { inputs: { baseURL: "https://one.example.com" } };
  await dashboard.scheduled(env);
  const panel = dashboard.render(env).panel;
  const types = [];
  const keys = [];
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    types.push(node.type);
    if (node.props?.key) keys.push(node.props.key);
    for (const child of node.children || []) walk(child);
  })(panel);
  assert.ok(keys.includes("progress-fill"));
  assert.ok(!keys.some(key => /^b\d+$/.test(key)));
});

test("refresh failure with existing data is visible inside the panel", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1760000000000 });
  let fail = false;
  const { dashboard } = loadDashboard({
    secrets: { apiToken: "test-token" },
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      if (fail && pathname === "/api/v1/server") {
        return { ok: false, status: 500, async text() { return JSON.stringify({ error: "boom" }); } };
      }
      return response(basicPayload(pathname));
    },
  });
  const env = { inputs: { baseURL: "https://one.example.com" } };
  await dashboard.scheduled(env);
  fail = true;
  t.mock.timers.tick(5000);
  await dashboard.scheduled(env);
  const panel = dashboard.render(env).panel;
  assert.ok(JSON.stringify(panel).includes("boom"));
});


test("more than eight groups switch to a complete Select navigator", async () => {
  const groups = Array.from({ length: 9 }, (_, i) => ({ group: { id: i + 1, name: `G${i + 1}` }, servers: [1] }));
  const { dashboard } = loadDashboard({
    secrets: { apiToken: "test-token" },
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      return response(pathname === "/api/v1/server-group" ? groups : basicPayload(pathname));
    },
  });
  const env = { inputs: { baseURL: "https://one.example.com" } };
  await dashboard.scheduled(env);
  const panel = dashboard.render(env).panel;
  const select = findNode(panel, node => node.type === "Select" && node.props?.key === "groups");
  assert.ok(select);
  assert.equal(select.props.items.length, 10);
});

test("fleets with more than six servers provide name and note search", async () => {
  const servers = Array.from({ length: 7 }, (_, i) => ({
    id: i + 1,
    name: `node-${i + 1}`,
    public_note: i === 6 ? "special-note" : "",
    last_active: new Date().toISOString(),
    state: {},
    host: {},
  }));
  const { dashboard } = loadDashboard({
    secrets: { apiToken: "test-token" },
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      return response(pathname === "/api/v1/server" ? servers : basicPayload(pathname));
    },
  });
  const env = { inputs: { baseURL: "https://one.example.com" } };
  await dashboard.scheduled(env);
  const search = findNode(dashboard.render(env).panel, node => node.type === "SearchField");
  assert.ok(search);
  search.props.onChange("special-note");
  const panel = dashboard.render(env).panel;
  assert.ok(JSON.stringify(panel).includes("node-7"));
  assert.ok(!JSON.stringify(panel).includes("node-1"));
  assert.ok(JSON.stringify(panel).includes("1/7"));
});

test("offline attention rows can open the corresponding server detail", async () => {
  const { dashboard } = loadDashboard({
    secrets: { apiToken: "test-token" },
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/v1/server") {
        return response([{ id: 1, name: "offline-one", last_active: "2000-01-01T00:00:00Z", state: {}, host: {} }]);
      }
      if (pathname.endsWith("/metrics")) return response({ data_points: [] });
      if (pathname.endsWith("/online-history")) return response(null);
      return response(basicPayload(pathname));
    },
  });
  const env = { inputs: { baseURL: "https://one.example.com" } };
  await dashboard.scheduled(env);
  const tabs = findNode(dashboard.render(env).panel, node => node.props?.key === "main-tabs");
  tabs.props.onChange("alerts");
  const row = findNode(dashboard.render(env).panel, node => node.props?.key === "srv-1");
  assert.equal(typeof row.props.onClick, "function");
  row.props.onClick();
  assert.ok(JSON.stringify(dashboard.render(env).panel).includes("offline-one"));
});


test("initial parallel snapshot never notifies existing probe or traffic failures", async () => {
  let releaseServices;
  const gate = new Promise(resolve => { releaseServices = resolve; });
  const { dashboard, notifications } = loadDashboard({
    secrets: { apiToken: "test-token" },
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/v1/service/list") {
        await gate;
        return response([{ id: 9, name: "already-down", type: 2 }]);
      }
      if (pathname === "/api/v1/service") {
        await gate;
        return response({
          services: { "9": { current_up: 0, current_down: 4, delay: [] } },
          cycle_transfer_stats: { "1": { name: "monthly", max: 100, server_name: { "1": "one" }, transfer: { "1": 96 } } },
        });
      }
      return response(basicPayload(pathname));
    },
  });
  const pending = dashboard.scheduled({ inputs: { baseURL: "https://one.example.com" } });
  await Promise.resolve();
  await Promise.resolve();
  releaseServices();
  await pending;
  assert.equal(notifications.length, 0);
});

test("Dashboard switch cancels an already queued WebSocket reconnect", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1760000000000 });
  const { dashboard, sockets } = loadDashboard({
    fetchImpl: async url => response(basicPayload(new URL(url).pathname)),
  });
  await dashboard.scheduled({ inputs: { baseURL: "https://one.example.com" } });
  sockets[0].onclose();
  await dashboard.scheduled({ inputs: { baseURL: "https://two.example.com" } });
  assert.equal(sockets.length, 2);
  t.mock.timers.tick(5000);
  await Promise.resolve();
  assert.equal(sockets[1].closed, false);
  assert.equal(sockets.length, 2);
});

test("abandoning a previously open WebSocket falls back to visible REST status", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1760000000000 });
  const { dashboard, sockets } = loadDashboard({
    fetchImpl: async url => response(basicPayload(new URL(url).pathname)),
  });
  const env = { inputs: { baseURL: "https://one.example.com" } };
  await dashboard.scheduled(env);
  sockets[0].readyState = 1;
  sockets[0].onopen();
  for (let i = 0; i < 3; i++) {
    const socket = sockets[i];
    socket.onclose();
    t.mock.timers.tick(5000);
    await dashboard.scheduled(env);
  }
  const panel = dashboard.render(env).panel;
  assert.ok(JSON.stringify(panel).includes("REST"));
  assert.ok(!JSON.stringify(panel).includes("wsDegraded"));
});

test("manual refresh during a slow domain queues another server refresh", async () => {
  let now = 1760000000000;
  class FakeDate extends Date { static now() { return now; } }
  let slow = false;
  let release;
  let serverCalls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const { dashboard } = loadDashboard({
    secrets: { apiToken: "test-token" },
    dateImpl: FakeDate,
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/v1/server") {
        serverCalls += 1;
        if (slow) await gate;
      }
      return response(basicPayload(pathname));
    },
  });
  const env = { inputs: { baseURL: "https://one.example.com" } };
  await dashboard.scheduled(env);
  slow = true;
  now += 5000;
  const pending = dashboard.scheduled(env);
  await Promise.resolve();
  dashboard.render(env).tray.menu[0].onClick();
  release();
  await pending;
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(serverCalls, 3);
});


async function serverHeightFor(count) {
  const servers = Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: `node-${i + 1}`,
    online: true,
    state: {},
    host: {},
  }));
  const { dashboard } = loadDashboard({
    secrets: { apiToken: "test-token" },
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      return response(pathname === "/api/v1/server" ? servers : basicPayload(pathname));
    },
  });
  const env = { inputs: { baseURL: "https://one.example.com" } };
  await dashboard.scheduled(env);
  return dashboard.render(env).panel.props.preferredHeight;
}

test("server panel uses measured rows, shrinks below four rows, and caps larger fleets", async () => {
  const expected = new Map([
    [0, 360],
    [1, 440],
    [2, 440],
    [3, 550],
    [4, 550],
    [7, 806],
    [8, 806],
    [9, 806],
    [21, 806],
    [100, 806],
  ]);
  for (const [count, height] of expected) {
    assert.equal(await serverHeightFor(count), height, `${count} servers`);
  }
});

test("server panel height follows the filtered group, not the whole fleet", async () => {
  const servers = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1,
    name: `node-${i + 1}`,
    online: true,
    state: {},
    host: {},
  }));
  const { dashboard } = loadDashboard({
    secrets: { apiToken: "test-token" },
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/v1/server") return response(servers);
      if (pathname === "/api/v1/server-group") {
        return response([{ group: { id: 1, name: "Pair" }, servers: [1, 2] }]);
      }
      return response(basicPayload(pathname));
    },
  });
  const env = { inputs: { baseURL: "https://one.example.com" } };
  await dashboard.scheduled(env);
  assert.equal(dashboard.render(env).panel.props.preferredHeight, 806);
  findNode(dashboard.render(env).panel, node => node.props?.key === "groups").props.onChange("1");
  assert.equal(dashboard.render(env).panel.props.preferredHeight, 476);
});

test("server panel accounts for a visible refresh error in its height", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1760000000000 });
  let fail = false;
  const { dashboard } = loadDashboard({
    secrets: { apiToken: "test-token" },
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      if (fail && pathname === "/api/v1/server") {
        return { ok: false, status: 500, async text() { return JSON.stringify({ error: "boom" }); } };
      }
      return response(basicPayload(pathname));
    },
  });
  const env = { inputs: { baseURL: "https://one.example.com" } };
  await dashboard.scheduled(env);
  assert.equal(dashboard.render(env).panel.props.preferredHeight, 440);
  fail = true;
  t.mock.timers.tick(5000);
  await dashboard.scheduled(env);
  assert.equal(dashboard.render(env).panel.props.preferredHeight, 483);
});


function widgetPayload(pathname) {
  if (pathname.endsWith("/metrics")) {
    return { data_points: [{ ts: 1760000000, value: 42 }] };
  }
  if (pathname === "/api/v1/server") {
    return [
      {
        id: 1,
        name: "Edge-One",
        last_active: new Date().toISOString(),
        state: { cpu: 25, mem_used: 50, net_in_speed: 1024, net_out_speed: 2048, net_in_transfer: 100, net_out_transfer: 200, load_1: 0.5 },
        host: { mem_total: 100, disk_total: 100 },
      },
      {
        id: 2,
        name: "Edge-Two",
        last_active: new Date().toISOString(),
        state: { cpu: 75, mem_used: 25, net_in_speed: 4096, net_out_speed: 8192, net_in_transfer: 300, net_out_transfer: 400 },
        host: { mem_total: 100, disk_total: 100 },
      },
    ];
  }
  if (pathname === "/api/v1/service") {
    const transfer = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [
      `cycle-${i + 1}`,
      {
        name: `monthly-${i + 1}`,
        max: 1000,
        server_name: { "1": "Edge-One" },
        transfer: { "1": 800 + 50 * i },
        next_update: { "1": "2026-07-01T00:00:00Z" },
      },
    ]));
    return { services: {}, cycle_transfer_stats: transfer };
  }
  return basicPayload(pathname);
}

async function renderWidget(inputs = {}, platform = "darwin") {
  const { dashboard } = loadDashboard({
    platform,
    fetchImpl: async url => response(widgetPayload(new URL(url).pathname)),
  });
  const env = { inputs: { baseURL: "https://one.example.com", liveUpdates: false, ...inputs } };
  await dashboard.scheduled(env);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  return dashboard.render(env);
}

function collectWidgetKeys(node, keys = []) {
  if (!node || typeof node !== "object") return keys;
  if (node.props?.key) keys.push(node.props.key);
  for (const child of node.children || []) collectWidgetKeys(child, keys);
  return keys;
}

test("default widget exports three read-only overview sizes", () => {
  return renderWidget().then(view => {
    assert.deepEqual(Object.keys(view.widget), ["small", "medium", "large"]);
    for (const family of ["small", "medium", "large"]) {
      const tree = view.widget[family];
      assert.ok(JSON.stringify(tree).includes("2/2"));
      assert.ok(!JSON.stringify(tree).includes('"tw"'));
      const serialized = JSON.stringify(tree, (key, value) => typeof value === "function" ? "function" : value);
      assert.ok(!serialized.includes('"function"'));
    }
  });
});

test("server widget uses the explicitly selected unique server", async () => {
  const view = await renderWidget({ widgetMode: "server", widgetServer: "edge-one" });
  const text = JSON.stringify(view.widget.small);
  assert.ok(text.includes("Edge-One"));
  assert.ok(text.includes("25%"));
  assert.ok(!text.includes("Edge-Two"));
  const missing = await renderWidget({ widgetMode: "server", widgetServer: "" });
  assert.ok(JSON.stringify(missing.widget.small).includes("widgetServer"));
});

test("traffic and attention widgets cap entries by family", async () => {
  for (const [mode, prefix] of [["traffic", "widget-traffic-"], ["attention", "widget-attention-"]]) {
    const view = await renderWidget({ widgetMode: mode });
    for (const [family, count] of [["small", 1], ["medium", 2], ["large", 6]]) {
      const keys = collectWidgetKeys(view.widget[family]).filter(key => key.startsWith(prefix));
      assert.equal(keys.length, count, `${mode} ${family}`);
    }
  }
});


test("small overview uses compact spacing on wide Windows cards", async () => {
  const mac = await renderWidget({}, "darwin");
  const windows = await renderWidget({}, "windows");
  assert.ok(mac.widget.small.children.some(child => child.type === "Spacer"));
  assert.equal(windows.widget.small.children.some(child => child.type === "Spacer"), false);
});


test("server widget loads only its target history and reuses it for sixty seconds", async () => {
  const metricCalls = [];
  const { dashboard } = loadDashboard({
    fetchImpl: async url => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/metrics")) {
        metricCalls.push(`${parsed.pathname}${parsed.search}`);
        return response({ data_points: [{ ts: 1760000000, value: 42 }] });
      }
      return response(widgetPayload(parsed.pathname));
    },
  });
  const env = { inputs: { baseURL: "https://one.example.com", liveUpdates: false, widgetMode: "server", widgetServer: "1" } };
  await dashboard.scheduled(env);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(metricCalls.length, 4);
  assert.ok(findNode(dashboard.render(env).widget.large, node => node.type === "Chart"));
  await dashboard.scheduled(env);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(metricCalls.length, 4);
});


test("large overview omits offline servers from the CPU ranking", async () => {
  const now = new Date().toISOString();
  const { dashboard } = loadDashboard({
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/v1/server") {
        return response([
          { id: 1, name: "Offline-High", last_active: "2000-01-01T00:00:00Z", state: { cpu: 99 }, host: {} },
          { id: 2, name: "Online-Low", last_active: now, state: { cpu: 1 }, host: {} },
        ]);
      }
      return response(basicPayload(pathname));
    },
  });
  const env = { inputs: { baseURL: "https://one.example.com", liveUpdates: false } };
  await dashboard.scheduled(env);
  const text = JSON.stringify(dashboard.render(env).widget.large);
  assert.ok(text.includes("Online-Low"));
  assert.ok(!text.includes("Offline-High"));
});


test("overview widgets use untruncated compact rates and two-column stats", async () => {
  const view = await renderWidget();
  const small = JSON.stringify(view.widget.small);
  assert.ok(small.includes("↓5.0K/s"));
  assert.ok(small.includes("↑10K/s"));
  assert.ok(!small.includes("5.00K/s"));
  assert.ok(!small.includes("Avg CPU"));
  for (const family of ["medium", "large"]) {
    const stats = findNode(view.widget[family], node => node.props?.key === "widget-overview-stats");
    assert.ok(stats, `${family} stats exist`);
    assert.equal(stats.props.columns, 2);
  }
});


test("single-server widgets also give metrics two columns", async () => {
  const view = await renderWidget({ widgetMode: "server", widgetServer: "1" });
  for (const family of ["medium", "large"]) {
    const stats = findNode(view.widget[family], node => node.props?.key === "widget-server-stats");
    assert.ok(stats, `${family} stats exist`);
    assert.equal(stats.props.columns, 2);
  }
});


test("single-server widget can follow the server selected in the panel", async () => {
  const { dashboard } = loadDashboard({
    fetchImpl: async url => response(widgetPayload(new URL(url).pathname)),
  });
  const env = { inputs: { baseURL: "https://one.example.com", liveUpdates: false, widgetMode: "server", widgetServer: "" } };
  await dashboard.scheduled(env);
  const card = findNode(dashboard.render(env).panel, node => node.props?.key === "srv-1");
  assert.ok(card);
  card.props.onClick();
  const text = JSON.stringify(dashboard.render(env).widget.small);
  assert.ok(text.includes("Edge-One"));
  assert.ok(!text.includes("widgetServer"));
});


test("single-server widgets use compact resources and side-by-side large charts", async () => {
  const view = await renderWidget({ widgetMode: "server", widgetServer: "1" });
  const smallText = JSON.stringify(view.widget.small);
  assert.ok(!smallText.includes("Load"));
  const compact = findNode(view.widget.small, node => node.props?.key === "widget-server-compact-resources");
  assert.ok(compact);
  assert.equal(compact.props.columns, 2);
  for (const family of ["medium", "large"]) {
    assert.ok(findNode(view.widget[family], node => node.props?.key === "widget-server-disk"));
  }
  const charts = findNode(view.widget.large, node => node.props?.key === "widget-server-charts");
  assert.ok(charts);
  assert.equal(charts.props.columns, 2);
});


test("overview uses status text instead of a full-width online progress bar", async () => {
  const view = await renderWidget();
  for (const family of ["small", "medium", "large"]) {
    assert.equal(findNode(view.widget[family], node => node.type === "Progress"), null);
  }
});

test("changing widget inputs explicitly invalidates the published view", async () => {
  const { dashboard, invalidations } = loadDashboard({
    fetchImpl: async url => response(widgetPayload(new URL(url).pathname)),
  });
  await dashboard.scheduled({ inputs: { baseURL: "https://one.example.com", liveUpdates: false, widgetMode: "overview" } });
  const before = invalidations.length;
  const view = dashboard.render({ inputs: { baseURL: "https://one.example.com", liveUpdates: false, widgetMode: "server", widgetServer: "Edge-One" } });
  assert.ok(invalidations.length > before);
  assert.ok(JSON.stringify(view.widget.small).includes("Edge-One"));
});


test("medium overview combines transfer and online status into one footer row", async () => {
  const view = await renderWidget();
  const footer = findNode(view.widget.medium, node => node.props?.key === "widget-overview-footer");
  assert.ok(footer);
  assert.equal(footer.type, "Row");
  assert.ok(JSON.stringify(footer).includes("全部在线"));
  assert.ok(JSON.stringify(footer).includes("累计"));
});
