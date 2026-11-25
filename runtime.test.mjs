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

function loadDashboard({
  fetchImpl,
  secrets = {},
  autoOpen = false,
  dateImpl = Date,
  platform = "darwin",
  locale = "zh-CN",
  capabilities = null,
  outputsFn = null,
  subscription = "plus",
  inboxMock = null,
  storage: initialStorage = {},
}) {
  const source = fs.readFileSync(new URL("./nezha.bar", import.meta.url), "utf8");
  const match = source.match(/<script[^>]*><!\[CDATA\[([\s\S]*)\]\]><\/script>/);
  assert.ok(match, "dashboard script exists");
  const code = match[1].replace("export default", "globalThis.dashboard =");
  const sockets = [];
  const notifications = [];
  const invalidations = [];
  const panelOpens = [];
  const notchStates = [];
  const toasts = [];
  const copied = [];
  const storage = new Map(Object.entries(initialStorage));
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
  const metrixHost = {
    platform,
    env: { locale },
    secret(name) { return secrets[name] || ""; },
    schedule() {},
    invalidate() { invalidations.push(Date.now()); },
    openURL() {},
    toast(msg) { toasts.push(String(msg)); },
    subscription() { return subscription; },
    panel: {
      async open() { panelOpens.push(Date.now()); return { open: true }; },
    },
    notch: {
      async setState(state, options) {
        notchStates.push({ state, options });
        return "accepted";
      },
    },
  };
  if (capabilities) {
    metrixHost.caniuse = async name => Boolean(capabilities[name]);
  }
  if (outputsFn) {
    metrixHost.outputs = outputsFn;
  }
  if (inboxMock) {
    metrixHost.inbox = inboxMock;
  }
  const context = vm.createContext({
    console,
    URL,
    Intl,
    TextDecoder,
    Date: dateImpl,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl,
    WebSocket: MockWebSocket,
    navigator: {
      clipboard: {
        async writeText(text) { copied.push(String(text)); },
      },
    },
    Notification: class {
      constructor(title, options) {
        this.title = title;
        this.options = options;
        this.onclick = null;
        notifications.push(this);
      }
    },
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, String(value)); },
    },
    $metrix: metrixHost,
  });
  vm.runInContext(code, context);
  return { dashboard: context.dashboard, sockets, notifications, invalidations, panelOpens, notchStates, toasts, copied, storage, context };
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
  const alertsTab = findNode(dashboard.render(env).panel, node => node.props?.key === "main-tab-alerts");
  alertsTab.props.onClick();
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


test("panel uses 4-row flyout height above 6 servers, adaptive height at or below 6, and expands in wide viewports", async () => {
  const servers = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1,
    name: `node-${i + 1}`,
    online: true,
    state: { cpu: i === 0 ? 1.4861024539067334e-10 : (i + 1) * 5, mem_used: 512, net_in_speed: 1024, net_out_speed: 512, load_1: 0.5 },
    host: { mem_total: 1024, disk_total: 1024 },
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
  const flyoutEnv = { inputs: { baseURL: "https://one.example.com" } };
  await dashboard.scheduled(flyoutEnv);
  const flyoutPanel = dashboard.render(flyoutEnv).panel;
  assert.equal(flyoutPanel.props.preferredHeight, 626);
  assert.equal(flyoutPanel.props.preferredWidth, 460);
  assert.ok(!JSON.stringify(flyoutPanel).includes("e-10"));

  findNode(flyoutPanel, node => node.props?.key === "group-1").props.onClick();
  const filteredPanel = dashboard.render(flyoutEnv).panel;
  assert.equal(filteredPanel.props.preferredHeight, undefined);
  assert.ok(JSON.stringify(filteredPanel).includes("node-1"));
  assert.ok(!JSON.stringify(filteredPanel).includes("node-8"));

  const wideEnv = { inputs: { baseURL: "https://one.example.com" }, viewport: { width: 960, height: 700 } };
  const widePanel = dashboard.render(wideEnv).panel;
  assert.equal(widePanel.props.preferredHeight, undefined);
  assert.ok(widePanel.props.preferredWidth >= 920);
  assert.ok(findNode(widePanel, node => node.props?.key === "server-table"));
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


test("overview widgets deduplicate online status and align down/up rates in the right column", async () => {
  const view = await renderWidget();
  const smallText = JSON.stringify(view.widget.small);
  assert.equal(smallText.split("2/2").length - 1, 1);
  assert.equal(smallText.split("全部在线").length - 1, 1);
  const smallBadge = findNode(view.widget.small, node => node.type === "Badge");
  assert.ok(smallBadge);
  assert.equal(smallBadge.props?.text, "全部在线");
  for (const family of ["medium", "large"]) {
    const widgetText = JSON.stringify(view.widget[family]);
    assert.equal(widgetText.split("2/2").length - 1, 1, `${family} shows online count once`);
    assert.equal(widgetText.split("全部在线").length - 1, 1, `${family} shows status badge once`);
    const stats = findNode(view.widget[family], node => node.props?.key === "widget-overview-stats");
    assert.ok(stats);
    assert.equal(stats.children.length, 4);
    assert.ok(JSON.stringify(stats.children[1]).includes("↓"));
    assert.ok(JSON.stringify(stats.children[3]).includes("↑"));
  }
  const footer = findNode(view.widget.medium, node => node.props?.key === "widget-overview-footer");
  assert.ok(footer);
  assert.equal(footer.type, "Row");
  assert.ok(JSON.stringify(footer).includes("累计"));
  assert.ok(!JSON.stringify(view.widget.small).includes("项关注"));
  assert.ok(!JSON.stringify(view.widget.medium).includes("项关注"));
});


test("rich macOS tray.content renders stacked rates and sparklines only when supported", async () => {
  const { dashboard } = loadDashboard({
    secrets: { apiToken: "test-token" },
    capabilities: { "render.tray.content": true, "render.tray.content.icon": true },
    fetchImpl: async url => response(widgetPayload(new URL(url).pathname)),
  });
  const env = { inputs: { baseURL: "https://one.example.com", trayFormat: "rate_spark" } };
  await dashboard.scheduled(env);
  await dashboard.scheduled(env);
  const tray = dashboard.render(env).tray;
  assert.ok(tray.content);
  assert.equal(tray.content.props.height, 22);
  assert.ok(tray.title.includes("↑"));

  const { dashboard: fallback } = loadDashboard({
    secrets: { apiToken: "test-token" },
    capabilities: { "render.tray.content": false },
    fetchImpl: async url => response(widgetPayload(new URL(url).pathname)),
  });
  await fallback.scheduled(env);
  const fallbackTray = fallback.render(env).tray;
  assert.equal(fallbackTray.content, undefined);
  assert.ok(fallbackTray.title.includes("↑"));
});

test("notch renders compact/minimal/expanded on demand and raises activity on server offline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1760000000000 });
  let online = true;
  let outputs = { tray: true, panel: false, notch: "compact", widget: { known: true, families: [] } };
  const { dashboard, notifications, panelOpens } = loadDashboard({
    secrets: { apiToken: "test-token" },
    capabilities: { "render.notch": true, "render.notch.activity": true },
    outputsFn: () => outputs,
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/v1/server") {
        return response([{
          id: 1,
          name: "kfc-jp",
          last_active: online ? new Date(Date.now()).toISOString() : "2000-01-01T00:00:00Z",
          state: { cpu: 22, net_in_speed: 2048, net_out_speed: 1024 },
          host: { mem_total: 1024, disk_total: 1024 },
        }]);
      }
      return response(basicPayload(pathname));
    },
  });
  const env = { inputs: { baseURL: "https://one.example.com", notchMetric: "cpu", notchActivity: true } };
  await dashboard.scheduled(env);
  let view = dashboard.render(env);
  assert.ok(view.notch);
  assert.equal(view.notch.compact.trailing.props.text, "22%");
  assert.equal(view.notch.expanded, undefined);
  assert.equal(view.notch.activity, undefined);
  assert.equal(view.widget, undefined);

  online = false;
  t.mock.timers.tick(5000);
  await dashboard.scheduled(env);
  outputs = { tray: true, panel: false, notch: "expanded", widget: { known: true, families: ["medium"] } };
  view = dashboard.render(env);
  assert.ok(view.notch.activity);
  assert.equal(view.notch.activity.id, "nezha-off-1");
  assert.ok(view.notch.expanded);
  assert.deepEqual(Object.keys(view.widget), ["small", "medium", "large"]);
  assert.equal(notifications.length, 1);
  notifications[0].onclick();
  assert.equal(panelOpens.length, 1);

  online = true;
  t.mock.timers.tick(5000);
  await dashboard.scheduled(env);
  view = dashboard.render(env);
  assert.equal(view.notch.activity, undefined);
});

test("network.change online resets WS backoff and triggers refresh", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1760000000000 });
  let serverCalls = 0;
  const { dashboard, sockets } = loadDashboard({
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/v1/server") serverCalls += 1;
      return response(basicPayload(pathname));
    },
  });
  const env = { inputs: { baseURL: "https://one.example.com" } };
  await dashboard.scheduled(env);
  for (let i = 0; i < 3; i += 1) {
    sockets[i].onclose();
    t.mock.timers.tick(5000);
  }
  const callsBefore = serverCalls;
  const socketsBefore = sockets.length;
  dashboard.event("system", { type: "network.change", online: false });
  dashboard.event("system", { type: "network.change", online: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(sockets.length > socketsBefore);
  assert.ok(serverCalls > callsBefore);
});

test("Plus Inbox parses webhook alerts, notifies only new arrivals, and supports read/delete", async () => {
  let messages = [
    { seq: 1, inbox_id: "box1", source: "webhook", received_at: 1760000000, size: 64, subject: "", sender: "nezha" },
  ];
  const payloads = new Map([
    [1, JSON.stringify({ title: "历史告警", content: "old" })],
    [2, JSON.stringify({ title: "节点 CPU 过高", server: { name: "ali-gzh" }, content: "CPU 96% > 90%" })],
  ]);
  const removed = [];
  const { dashboard, notifications } = loadDashboard({
    secrets: { apiToken: "test-token" },
    capabilities: { "inbox.boxes": true, "inbox.message": true, "inbox.remove": true, "render.notch": true, "render.notch.activity": true },
    inboxMock: {
      async boxes() { return [{ id: "box1", name: "Nezha", address: "wh@metrix", paused: false, message_count: messages.length, last_received_at: 1760000010 }]; },
      async list() { return messages.slice(); },
      async read(id, seq) { return Buffer.from(payloads.get(seq) || "", "utf8"); },
      async remove(id, seq) { removed.push([id, seq]); messages = messages.filter(m => m.seq !== seq); },
    },
    fetchImpl: async url => response(basicPayload(new URL(url).pathname)),
  });
  const env = { inputs: { baseURL: "https://one.example.com" } };
  await dashboard.scheduled(env);
  assert.equal(notifications.length, 0);

  messages = [
    { seq: 2, inbox_id: "box1", source: "webhook", received_at: 1760000050, size: 92, subject: "", sender: "nezha" },
    ...messages,
  ];
  await dashboard.event("inboxchange", { inboxIds: ["box1"] });

  assert.equal(notifications.length, 1);
  assert.match(notifications[0].title, /ali-gzh/);
  const view = dashboard.render(env);
  assert.equal(view.notch.activity.id, "nezha-inbox-box1:2");

  const alertsTab = findNode(view.panel, n => n.props?.key === "main-tab-alerts");
  alertsTab.props.onClick();
  const alertsView = dashboard.render(env).panel;
  assert.ok(JSON.stringify(alertsView).includes("节点 CPU 过高"));

  const card = findNode(alertsView, n => n.props?.key === "inbox-box1:2");
  assert.ok(card);
  card.children[0].props.onClick();
  const expandedAlerts = dashboard.render(env).panel;
  const delBtn = findNode(expandedAlerts, n => n.type === "Button" && n.props?.text === "删除");
  assert.ok(delBtn);
  delBtn.props.onClick();
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  assert.deepEqual(removed, [["box1", 2]]);
});

test("English locale localizes widgets without hardcoded Chinese strings", async () => {
  const { dashboard } = loadDashboard({
    locale: "en-US",
    fetchImpl: async url => response(widgetPayload(new URL(url).pathname)),
  });
  const env = { inputs: { baseURL: "https://one.example.com", liveUpdates: false } };
  await dashboard.scheduled(env);
  const mediumText = JSON.stringify(dashboard.render(env).widget.medium);
  assert.ok(mediumText.includes("All online"));
  assert.ok(mediumText.includes("Total"));
  assert.ok(!/[\u4e00-\u9fff]/.test(mediumText));
});


test("closed panel cache refreshes once initial server snapshot arrives and skips subsequent background rebuilds", async () => {
  let outputs = { tray: true, panel: false, notch: "compact", widget: { known: true, families: [] } };
  let cpu = 12;
  const { dashboard } = loadDashboard({
    secrets: { apiToken: "test-token" },
    outputsFn: () => outputs,
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/v1/server") {
        return response([{ id: 1, name: "edge-1", last_active: new Date().toISOString(), state: { cpu }, host: { mem_total: 100, disk_total: 100 } }]);
      }
      return response(basicPayload(pathname));
    },
  });
  const env = { inputs: { baseURL: "https://one.example.com" } };
  // Initial render before data loads caches setup/loading state
  const preLoad = dashboard.render(env).panel;
  assert.ok(!JSON.stringify(preLoad).includes("edge-1"));

  await dashboard.scheduled(env);
  const afterLoad = dashboard.render(env).panel;
  assert.ok(JSON.stringify(afterLoad).includes("edge-1"));
  assert.ok(JSON.stringify(afterLoad).includes("12%"));

  // Next render while panel stays closed reuses cached panel tree
  const sameRef = dashboard.render(env).panel;
  assert.equal(sameRef, afterLoad);
});


test("detail network chart scales raw bytes/s into human-readable MB/s with unit pill and valueLabel", async () => {
  const { dashboard } = loadDashboard({
    secrets: { apiToken: "test-token" },
    fetchImpl: async url => {
      const u = new URL(url);
      if (u.pathname === "/api/v1/server/1/metrics") {
        const m = u.searchParams.get("metric");
        if (m === "net_in_speed") return response({ data_points: [{ ts: 1760000000000, value: 2_097_152 }] });
        if (m === "net_out_speed") return response({ data_points: [{ ts: 1760000000000, value: 524_288 }] });
        if (m === "cpu") return response({ data_points: [{ ts: 1760000000000, value: 12.34 }] });
        return response({ data_points: [] });
      }
      return response(basicPayload(u.pathname));
    },
  });
  const env = { inputs: { baseURL: "https://one.example.com" } };
  await dashboard.scheduled(env);
  const card = findNode(dashboard.render(env).panel, n => n.props?.key === "srv-1");
  card.props.onClick();
  await new Promise(r => setImmediate(r));
  const detail = dashboard.render(env).panel;
  const text = JSON.stringify(detail);
  assert.ok(text.includes('"MB/s"'));
  assert.ok(text.includes('"2.0M/s"'));
  assert.ok(!text.includes("2097152"));
  assert.ok(text.includes('"12.3%"'));
});

test("notchMetric supports stacked_rate, down, and up right-wing modes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1760000000000 });
  const { dashboard } = loadDashboard({
    secrets: { apiToken: "test-token" },
    capabilities: { "render.notch": true },
    fetchImpl: async url => response(widgetPayload(new URL(url).pathname)),
  });
  await dashboard.scheduled({ inputs: { baseURL: "https://one.example.com", notchMetric: "stacked_rate" } });

  const stacked = dashboard.render({ inputs: { baseURL: "https://one.example.com", notchMetric: "stacked_rate" } }).notch.compact.trailing;
  assert.equal(stacked.type, "Column");
  assert.equal(stacked.children.length, 2);
  assert.ok(stacked.children[0].props.text.startsWith("↑"));
  assert.ok(stacked.children[1].props.text.startsWith("↓"));

  const down = dashboard.render({ inputs: { baseURL: "https://one.example.com", notchMetric: "down" } }).notch.compact.trailing;
  assert.equal(down.type, "Text");
  assert.ok(down.props.text.startsWith("↓"));

  const up = dashboard.render({ inputs: { baseURL: "https://one.example.com", notchMetric: "up" } }).notch.compact.trailing;
  assert.equal(up.type, "Text");
  assert.ok(up.props.text.startsWith("↑"));
});

test("server detail calls /api/v1/server/:id/service, renders network sub-tab with all lines, and supports line focus", async () => {
  const seenPaths = [];
  const monitors = Array.from({ length: 9 }, (_, i) => ({
    monitor_id: i + 1,
    monitor_name: i === 8 ? "Cloudflare" : `Line-${i + 1}`,
    display_index: 20 - i,
    created_at: [1760000000000, 1760000060000, 1760000120000, 1760000180000].map(t => t + (i >= 3 ? 30_000 : 0)),
    avg_delay: i === 0 ? [290, 142, 363, 0] : [1 + i * 0.5, 2 + i * 0.5, 1.5 + i * 0.5, 1.8 + i * 0.5],
  }));
  const { dashboard } = loadDashboard({
    secrets: { apiToken: "test-token" },
    fetchImpl: async url => {
      const u = new URL(url);
      seenPaths.push(`${u.pathname}${u.search}`);
      if (u.pathname === "/api/v1/service/1") {
        return new Response(JSON.stringify({ error: "404 Not Found" }), { status: 404 });
      }
      if (u.pathname === "/api/v1/server/1/service") {
        return response(monitors);
      }
      if (u.pathname === "/api/v1/server/1/online-history") {
        return response({
          currently_online: true,
          online_rate: 99.8,
          total_online_seconds: 86200,
          last_active: "2026-11-22T12:00:00Z",
          daily: [{ date: "2026-11-22", online_seconds: 43200 }],
        });
      }
      if (u.pathname === "/api/v1/server/1/metrics") {
        return response({ data_points: [{ ts: 1760000000000, value: 18 }] });
      }
      return response(basicPayload(u.pathname));
    },
  });
  const env = { inputs: { baseURL: "https://one.example.com" } };
  await dashboard.scheduled(env);

  const card = findNode(dashboard.render(env).panel, n => n.props?.key === "srv-1");
  card.props.onClick();
  await new Promise(r => setImmediate(r));

  assert.ok(seenPaths.some(p => p === "/api/v1/server/1/service?period=1d"), `expected /api/v1/server/1/service?period=1d, got ${seenPaths.join(", ")}`);
  assert.ok(!seenPaths.some(p => p.startsWith("/api/v1/service/1")), "must not request broken /api/v1/service/:id path");

  // Overview sub-tab shows latency teaser and hides full uptime details until switched
  const overviewPanel = dashboard.render(env).panel;
  assert.ok(findNode(overviewPanel, n => n.props?.key === "detail-tab-network"));
  assert.ok(!JSON.stringify(overviewPanel).includes("99.8%"));

  // Switch to Network sub-tab
  findNode(overviewPanel, n => n.props?.key === "detail-tab-network").props.onClick();
  const netPanel = dashboard.render(env).panel;
  const chart = findNode(netPanel, n => n.type === "Chart");
  assert.ok(chart, "network tab should render latency chart");
  assert.equal(chart.props.series.length, 9, "all 9 monitors should render without an 8-line cap");
  assert.ok(chart.props.series.every(s => typeof s.color === "string" && s.color.startsWith("#")));
  const xs1 = [...chart.props.series[1].points].map(p => p.x);
  const xs8 = [...chart.props.series[8].points].map(p => p.x);
  assert.deepEqual(xs8, xs1, "staggered monitors must align onto shared x timestamps");
  const netText = JSON.stringify(netPanel);
  assert.ok(netText.includes("Cloudflare"));
  assert.ok(netText.includes("25.0%") || netText.includes("25%"), "zero delay sample must count as packet loss");
  assert.ok(netText.includes("142") && netText.includes("363"), "min/max latency range should be visible");

  // Click Cloudflare row to isolate a single line on the chart
  const cfRow = findNode(netPanel, n => n.props?.key === "mon-9");
  assert.ok(cfRow && typeof cfRow.props.onClick === "function");
  cfRow.props.onClick();
  const oneSelectedPanel = dashboard.render(env).panel;
  const oneChart = findNode(oneSelectedPanel, n => n.type === "Chart");
  assert.equal(oneChart.props.series.length, 1);
  assert.equal(oneChart.props.series[0].name, "Cloudflare");

  // Click two more rows to multi-select and compare 3 lines on the same chart
  findNode(oneSelectedPanel, n => n.props?.key === "mon-1").props.onClick();
  findNode(dashboard.render(env).panel, n => n.props?.key === "mon-2").props.onClick();
  const multiPanel = dashboard.render(env).panel;
  const multiChart = findNode(multiPanel, n => n.type === "Chart");
  assert.equal(multiChart.props.series.length, 3);
  assert.deepEqual([...multiChart.props.series].map(s => s.name), ["Line-1", "Line-2", "Cloudflare"]);

  // Click Line-2 again to remove it from comparison (leaving 2 lines)
  findNode(multiPanel, n => n.props?.key === "mon-2").props.onClick();
  const twoChart = findNode(dashboard.render(env).panel, n => n.type === "Chart");
  assert.equal(twoChart.props.series.length, 2);
  assert.deepEqual([...twoChart.props.series].map(s => s.name), ["Line-1", "Cloudflare"]);

  // Click Show All button to restore all 9 lines
  const clearBtn = findNode(dashboard.render(env).panel, n => n.props?.key === "clear-monitor-focus");
  assert.ok(clearBtn && typeof clearBtn.props.onClick === "function");
  clearBtn.props.onClick();
  assert.equal(findNode(dashboard.render(env).panel, n => n.type === "Chart").props.series.length, 9);

  // Switch to Online sub-tab
  findNode(dashboard.render(env).panel, n => n.props?.key === "detail-tab-online").props.onClick();
  const onlinePanel = dashboard.render(env).panel;
  assert.ok(JSON.stringify(onlinePanel).includes("99.8%"));
});

test("server detail surfaces latency fetch errors instead of empty monitor message and supports 30d with PAT", async () => {
  const seenPaths = [];
  const { dashboard } = loadDashboard({
    secrets: { apiToken: "test-token" },
    fetchImpl: async url => {
      const u = new URL(url);
      seenPaths.push(`${u.pathname}${u.search}`);
      if (u.pathname === "/api/v1/server/1/service") {
        return new Response(JSON.stringify({ error: "service history unavailable" }), { status: 500 });
      }
      if (u.pathname === "/api/v1/server/1/metrics") return response({ data_points: [] });
      if (u.pathname === "/api/v1/server/1/online-history") return response(null);
      return response(basicPayload(u.pathname));
    },
  });
  const env = { inputs: { baseURL: "https://one.example.com" } };
  await dashboard.scheduled(env);
  findNode(dashboard.render(env).panel, n => n.props?.key === "srv-1").props.onClick();
  await new Promise(r => setImmediate(r));

  findNode(dashboard.render(env).panel, n => n.props?.key === "detail-tab-network").props.onClick();
  const netPanel = dashboard.render(env).panel;
  const text = JSON.stringify(netPanel);
  assert.ok(text.includes("service history unavailable"));
  assert.ok(!text.includes("没有关联的 Ping/HTTP 监控") && !text.includes("No Ping/HTTP monitors attached"));

  const period30d = findNode(netPanel, n => n.props?.key === "period-30d");
  assert.ok(period30d, "PAT mode should expose 30d period option");
  period30d.props.onClick();
  await new Promise(r => setImmediate(r));
  assert.ok(seenPaths.includes("/api/v1/server/1/service?period=30d"));
  assert.ok(seenPaths.includes("/api/v1/server/1/online-history?days=30"));
});

test("flyout tabs auto-fit short content and use flyout height when overflowing", async () => {
  const servers = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1,
    name: `node-${i + 1}`,
    online: true,
    state: { cpu: 12, mem_used: 512, net_in_speed: 1024, net_out_speed: 512, load_1: 0.4 },
    host: { mem_total: 1024, disk_total: 1024 },
  }));
  let largeLists = false;
  const makeServices = count => Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: `Web-${i + 1}`,
    type: 1,
    target: `https://api${i + 1}.example.com/health`,
  }));
  const makeCycleStats = count => {
    const server_name = {};
    const transfer = {};
    const next_update = {};
    for (let i = 1; i <= count; i++) {
      server_name[String(i)] = `node-${i}`;
      transfer[String(i)] = 200;
      next_update[String(i)] = "2026-11-23T10:10:00Z";
    }
    return {
      "1": { name: "monthly", max: 1000, from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z", server_name, transfer, next_update },
    };
  };
  let now = 1_760_000_000_000;
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const { dashboard } = loadDashboard({
    secrets: { apiToken: "test-token" },
    dateImpl: FakeDate,
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/v1/server") return response(servers);
      if (pathname === "/api/v1/server-group") {
        return response([{ group: { id: 1, name: "Core" }, servers: [1, 2, 3, 4, 5, 6, 7, 8] }]);
      }
      if (pathname === "/api/v1/service/list") {
        return response(makeServices(largeLists ? 8 : 6));
      }
      if (pathname === "/api/v1/service") {
        const count = largeLists ? 8 : 6;
        const services = {};
        for (let i = 1; i <= count; i++) {
          services[String(i)] = { service_name: `Web-${i}`, current_up: 10, current_down: 0, delay: [18] };
        }
        return response({ services, cycle_transfer_stats: makeCycleStats(count) });
      }
      if (pathname === "/api/v1/alert-rule") {
        return response(Array.from({ length: largeLists ? 6 : 2 }, (_, i) => ({ id: i + 1, name: `Rule-${i + 1}`, enable: true })));
      }
      return response(basicPayload(pathname));
    },
  });
  const env = { inputs: { baseURL: "https://one.example.com" } };
  const wideEnv = { inputs: { baseURL: "https://one.example.com" }, viewport: { width: 960, height: 700 } };
  await dashboard.scheduled(env);

  const srvPanel = dashboard.render(env).panel;
  assert.equal(srvPanel.props.preferredHeight, 626);

  const switchTab = tab => {
    const btn = findNode(dashboard.render(env).panel, n => n.props?.key === `main-tab-${tab}`);
    btn.props.onClick();
  };
  for (const tab of ["services", "traffic", "alerts"]) {
    switchTab(tab);
    assert.equal(dashboard.render(env).panel.props.preferredHeight, undefined, `${tab} tab with compact count should auto-fit`);
    assert.equal(dashboard.render(wideEnv).panel.props.preferredHeight, undefined, `${tab} tab should remain responsive in wide viewport`);
  }

  // Server detail preserves full flyout height while loading so entering from list never collapses height
  switchTab("servers");
  findNode(dashboard.render(env).panel, n => n.props?.key === "srv-1").props.onClick();
  assert.equal(dashboard.render(env).panel.props.preferredHeight, 626);
  findNode(dashboard.render(env).panel, n => n.props?.key === "detail-back").props.onClick();

  // When Services / Traffic / Alerts overflow, flyout switches to full scrollable height
  largeLists = true;
  now += 120_000;
  await dashboard.scheduled(env);
  for (const tab of ["services", "traffic", "alerts"]) {
    switchTab(tab);
    assert.equal(dashboard.render(env).panel.props.preferredHeight, 626, `${tab} tab with overflowing items should use flyout height`);
    assert.equal(dashboard.render(wideEnv).panel.props.preferredHeight, undefined, `${tab} tab should remain responsive in wide viewport`);
  }
});

test("closed panel cache rebuilds when slower traffic/service snapshots arrive after servers", async () => {
  let outputs = { tray: true, panel: false, notch: "compact", widget: { known: true, families: [] } };
  let releaseService;
  const serviceGate = new Promise(resolve => { releaseService = resolve; });
  const { dashboard } = loadDashboard({
    secrets: { apiToken: "test-token" },
    outputsFn: () => outputs,
    storage: { "nezha.tab": "traffic" },
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/v1/service" || pathname === "/api/v1/service/list") {
        await serviceGate;
        if (pathname === "/api/v1/service") {
          return response({
            services: {},
            cycle_transfer_stats: {
              "1": { name: "hk-cycle", max: 1000, from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z", server_name: { "1": "alpha" }, transfer: { "1": 320 }, next_update: { "1": "2026-11-23T10:10:00Z" } },
            },
          });
        }
        return response([]);
      }
      return response(basicPayload(pathname));
    },
  });
  const env = { inputs: { baseURL: "https://one.example.com" } };
  const pendingRefresh = dashboard.scheduled(env);
  // Wait for /api/v1/server to settle while /api/v1/service is still in flight
  await new Promise(r => setTimeout(r, 20));
  const midLoad = dashboard.render(env).panel;
  assert.ok(!JSON.stringify(midLoad).includes("hk-cycle"), "traffic snapshot has not arrived yet");

  // Once slower service/traffic snapshot resolves while panel stays closed, cache must rebuild
  releaseService();
  await pendingRefresh;
  const afterService = dashboard.render(env).panel;
  assert.ok(JSON.stringify(afterService).includes("hk-cycle"), "closed panel cache must refresh once traffic data arrives");
  assert.equal(afterService.props.preferredHeight, undefined, "compact traffic tab should auto-fit");
});

test("refreshServices, refreshMetadata, and refreshAlertRules preserve last successful snapshots when requests fail", async () => {
  let failSlowDomains = false;
  let now = 1_760_000_000_000;
  let serviceFails = 0;
  let alertFails = 0;
  let groupFails = 0;
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const { dashboard } = loadDashboard({
    secrets: { apiToken: "test-token" },
    dateImpl: FakeDate,
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      if (failSlowDomains && (pathname === "/api/v1/service/list" || pathname === "/api/v1/service")) {
        serviceFails += 1;
        return new Response(JSON.stringify({ error: "temporary timeout" }), { status: 500 });
      }
      if (failSlowDomains && pathname === "/api/v1/alert-rule") {
        alertFails += 1;
        return new Response(JSON.stringify({ error: "temporary timeout" }), { status: 500 });
      }
      if (failSlowDomains && pathname === "/api/v1/server-group") {
        groupFails += 1;
        return new Response(JSON.stringify({ error: "temporary timeout" }), { status: 500 });
      }
      if (pathname === "/api/v1/server-group") {
        return response([{ group: { id: 1, name: "Edge-HK" }, servers: [1] }]);
      }
      if (pathname === "/api/v1/service/list") {
        return response([{ id: 1, name: "Edge Probe", type: 1, target: "https://edge.example.com/ping" }]);
      }
      if (pathname === "/api/v1/service") {
        return response({
          services: { "1": { service_name: "Edge Probe", current_up: 10, current_down: 0, delay: [15] } },
          cycle_transfer_stats: {
            "1": { name: "hk-monthly", max: 1000, from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z", server_name: { "1": "alpha" }, transfer: { "1": 400 }, next_update: { "1": "2026-11-23T10:10:00Z" } },
          },
        });
      }
      if (pathname === "/api/v1/alert-rule") {
        return response([{ id: 1, name: "Offline Guard", enable: true }]);
      }
      return response(basicPayload(pathname));
    },
  });
  const env = { inputs: { baseURL: "https://one.example.com" } };
  await dashboard.scheduled(env);

  // Trigger a refresh when service/traffic/alert/group endpoints fail
  failSlowDomains = true;
  now += 310_000;
  await dashboard.scheduled(env);
  assert.ok(serviceFails >= 2, "service endpoints should have been retried and failed");
  assert.ok(alertFails >= 1, "alert-rule endpoint should have been retried and failed");
  assert.ok(groupFails >= 1, "server-group endpoint should have been retried and failed");

  assert.ok(JSON.stringify(dashboard.render(env).panel).includes("Edge-HK"), "server groups should keep previous snapshot on failure");
  const switchTab = tab => findNode(dashboard.render(env).panel, n => n.props?.key === `main-tab-${tab}`).props.onClick();
  switchTab("services");
  assert.ok(JSON.stringify(dashboard.render(env).panel).includes("Edge Probe"), "services should keep previous snapshot on failure");
  switchTab("traffic");
  assert.ok(JSON.stringify(dashboard.render(env).panel).includes("hk-monthly"), "cycle traffic should keep previous snapshot on failure");
  switchTab("alerts");
  assert.ok(JSON.stringify(dashboard.render(env).panel).includes("Offline Guard"), "alert rules should keep previous snapshot on failure");
});

test("services tab masks URLs and IPs via maskServiceTargets input and quick toggle button", async () => {
  const { dashboard } = loadDashboard({
    secrets: { apiToken: "test-token" },
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/v1/service/list") {
        return response([
          { id: 1, name: "API Health", type: 1, target: "https://api.secret-site.com/v1/health?key=abc" },
          { id: 2, name: "SSH Check", type: 3, target: "198.51.100.42:22" },
        ]);
      }
      if (pathname === "/api/v1/service") {
        return response({
          services: {
            "1": { service_name: "API Health", current_up: 10, current_down: 0, delay: [21] },
            "2": { service_name: "SSH Check", current_up: 10, current_down: 0, delay: [8] },
          },
        });
      }
      return response(basicPayload(pathname));
    },
  });

  const plainEnv = { inputs: { baseURL: "https://one.example.com", maskServiceTargets: false } };
  await dashboard.scheduled(plainEnv);
  findNode(dashboard.render(plainEnv).panel, n => n.props?.key === "main-tab-services").props.onClick();

  const plainJson = JSON.stringify(dashboard.render(plainEnv).panel);
  assert.ok(plainJson.includes("https://api.secret-site.com/v1/health?key=abc"));
  assert.ok(plainJson.includes("198.51.100.42:22"));

  // Enable via dashboard input
  const maskedEnv = { inputs: { baseURL: "https://one.example.com", maskServiceTargets: true } };
  const maskedPanel = dashboard.render(maskedEnv).panel;
  const maskedJson = JSON.stringify(maskedPanel);
  assert.ok(maskedJson.includes("https://a***.s***.com/***"));
  assert.ok(maskedJson.includes("198.*.*.42:22"));
  assert.ok(!maskedJson.includes("secret-site"));
  assert.ok(!maskedJson.includes("198.51.100.42"));

  // Toggle back to unmasked via quick toolbar button
  const toggleBtn = findNode(maskedPanel, n => n.props?.key === "svc-mask-toggle");
  assert.ok(toggleBtn && typeof toggleBtn.props.onClick === "function");
  toggleBtn.props.onClick();
  const toggledJson = JSON.stringify(dashboard.render(maskedEnv).panel);
  assert.ok(toggledJson.includes("https://api.secret-site.com/v1/health?key=abc"));

  // Toggle back to masked via quick toolbar button
  findNode(dashboard.render(maskedEnv).panel, n => n.props?.key === "svc-mask-toggle").props.onClick();
  assert.ok(!JSON.stringify(dashboard.render(maskedEnv).panel).includes("secret-site"));
});

test("showTrayIcon toggles icon visibility in both plain text and rich macOS tray modes", async () => {
  const { dashboard } = loadDashboard({
    secrets: { apiToken: "test-token" },
    capabilities: {
      "render.tray.content": true,
      "render.tray.content.icon": true,
      "render.tray.icon.clear": true,
    },
    fetchImpl: async url => response(basicPayload(new URL(url).pathname)),
  });

  const textWithIconEnv = { inputs: { baseURL: "https://one.example.com", trayFormat: "online_total", showTrayIcon: true } };
  await dashboard.scheduled(textWithIconEnv);
  const textWithIcon = dashboard.render(textWithIconEnv).tray;
  assert.ok(String(textWithIcon.icon || "").startsWith("data:image/svg+xml,"));
  assert.equal(textWithIcon.iconTemplate, true);

  const textNoIconEnv = { inputs: { baseURL: "https://one.example.com", trayFormat: "online_total", showTrayIcon: false } };
  const textNoIcon = dashboard.render(textNoIconEnv).tray;
  assert.equal(textNoIcon.icon, null);

  const richWithIconEnv = { inputs: { baseURL: "https://one.example.com", trayFormat: "stacked_rate", showTrayIcon: true } };
  const richWithIcon = dashboard.render(richWithIconEnv).tray;
  assert.equal(richWithIcon.content.children[0].type, "Icon");
  assert.equal(richWithIcon.content.props.gap, 3);

  const richNoIconEnv = { inputs: { baseURL: "https://one.example.com", trayFormat: "stacked_rate", showTrayIcon: false } };
  const richNoIcon = dashboard.render(richNoIconEnv).tray;
  assert.equal(richNoIcon.icon, null);
  assert.equal(richNoIcon.content.children.some(c => c.type === "Icon"), false);
  assert.ok(richNoIcon.content.props.width < richWithIcon.content.props.width);
});

test("topTabs renders full-width equal tabs with subtle counts and panelWidth controls flyout width across all tabs", async () => {
  let panelOpen = true;
  const { dashboard } = loadDashboard({
    secrets: { apiToken: "test-token" },
    outputsFn: () => ({ tray: true, panel: panelOpen, notch: null, widget: { known: false, families: [] } }),
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/v1/server") {
        return response([
          { id: 1, name: "alpha", last_active: new Date().toISOString(), host: { mem_total: 1000, disk_total: 1000 }, state: { cpu: 20, mem_used: 300, disk_used: 400, net_in_speed: 500, net_out_speed: 200 } },
          { id: 2, name: "offline-node", last_active: "2000-01-01T00:00:00Z", host: { mem_total: 1000, disk_total: 1000 }, state: { cpu: 0, mem_used: 0, disk_used: 0, net_in_speed: 0, net_out_speed: 0 } },
        ]);
      }
      if (pathname === "/api/v1/service/list") {
        return response([{ id: 1, name: "API", type: 1, target: "https://api.example.com" }]);
      }
      if (pathname === "/api/v1/service") {
        return response({
          services: { "1": { service_name: "API", current_up: 10, current_down: 0, delay: [12] } },
          cycle_transfer_stats: {
            "1": { name: "monthly", max: 1000, from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z", server_name: { "1": "alpha" }, transfer: { "1": 200 }, next_update: { "1": "2026-11-24T00:00:00Z" } },
          },
        });
      }
      return response(basicPayload(pathname));
    },
  });

  const medEnv = { inputs: { baseURL: "https://one.example.com" } };
  await dashboard.scheduled(medEnv);

  const medPanel = dashboard.render(medEnv).panel;
  assert.equal(medPanel.props.preferredWidth, 460);
  const tabBar = findNode(medPanel, n => n.props?.key === "main-tabs");
  assert.equal(tabBar.type, "Row");
  assert.ok(tabBar.props.tw.includes("w-full"));
  assert.equal(tabBar.children.length, 4);
  for (const child of tabBar.children) {
    assert.ok(child.props.tw.includes("grow basis-0"));
  }
  assert.ok(JSON.stringify(tabBar.children[0]).includes('"text":"2"'), "servers tab should show server count");
  assert.ok(JSON.stringify(tabBar.children[1]).includes('"text":"1"'), "services tab should show service count");
  assert.ok(JSON.stringify(tabBar.children[2]).includes('"text":"1"'), "traffic tab should show cycle count");
  assert.ok(JSON.stringify(tabBar.children[3]).includes('"text":"1"'), "alerts tab should show attention count");

  const smallEnv = { inputs: { baseURL: "https://one.example.com", panelWidth: "small" } };
  const largeEnv = { inputs: { baseURL: "https://one.example.com", panelWidth: "large" } };
  for (const tab of ["servers", "services", "traffic", "alerts"]) {
    findNode(dashboard.render(smallEnv).panel, n => n.props?.key === `main-tab-${tab}`).props.onClick();
    assert.equal(dashboard.render(smallEnv).panel.props.preferredWidth, 400, `${tab} tab should use 400px in small preset`);
    assert.equal(dashboard.render(largeEnv).panel.props.preferredWidth, 520, `${tab} tab should use 520px in large preset`);
  }

  // Changing panelWidth while panel is closed must still refresh cached panel tree
  panelOpen = false;
  assert.equal(dashboard.render(smallEnv).panel.props.preferredWidth, 400);
  assert.equal(dashboard.render(medEnv).panel.props.preferredWidth, 460);
});

test("group navigator uses full-width pill bar when groups fit and switches to ScrollHorizontal when labels overflow narrow widths", async () => {
  let groupPayload = [
    { group: { id: 1, name: "🇨🇳 CN" }, servers: [1] },
    { group: { id: 2, name: "🇭🇰 HK" }, servers: [1] },
    { group: { id: 3, name: "🇯🇵 JP" }, servers: [1] },
    { group: { id: 4, name: "🇸🇬 SGP" }, servers: [1] },
    { group: { id: 5, name: "🇺🇸 US" }, servers: [1] },
  ];
  const { dashboard } = loadDashboard({
    secrets: { apiToken: "test-token" },
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/v1/server-group") return response(groupPayload);
      return response(basicPayload(pathname));
    },
  });
  const smallEnv = { inputs: { baseURL: "https://one.example.com", panelWidth: "small" } };
  await dashboard.scheduled(smallEnv);

  const barNav = findNode(dashboard.render(smallEnv).panel, n => n.props?.key === "groups");
  assert.equal(barNav.type, "Row");
  assert.equal(barNav.children.length, 6);
  assert.ok(barNav.props.tw.includes("w-full"));

  // Switch to long group names that exceed 400px flyout width
  groupPayload = [
    { group: { id: 1, name: "Hong Kong Edge" }, servers: [1] },
    { group: { id: 2, name: "Singapore Core" }, servers: [1] },
    { group: { id: 3, name: "Tokyo Transit" }, servers: [1] },
    { group: { id: 4, name: "Frankfurt EU" }, servers: [1] },
    { group: { id: 5, name: "Los Angeles US" }, servers: [1] },
  ];
  const { dashboard: d2 } = loadDashboard({
    secrets: { apiToken: "test-token" },
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/v1/server-group") return response(groupPayload);
      return response(basicPayload(pathname));
    },
  });
  await d2.scheduled(smallEnv);
  const scrollNav = findNode(d2.render(smallEnv).panel, n => n.props?.key === "groups");
  assert.equal(scrollNav.type, "ScrollHorizontal");
});

test("server detail keeps full flyout height for charts/monitors and auto-fits compact online sub-tab", async () => {
  const nowMs = Date.now();
  const mkSeries = (base, step) => Array.from({ length: 12 }, (_, i) => ({
    ts: nowMs - (11 - i) * 300_000,
    value: base + i * step,
  }));
  const mkMon = (id, name, base) => ({
    monitor_id: id,
    monitor_name: name,
    display_index: 10 - id,
    server_id: 1,
    server_name: "edge-1",
    created_at: Array.from({ length: 12 }, (_, i) => nowMs - (11 - i) * 300_000),
    avg_delay: Array.from({ length: 12 }, (_, i) => base + i),
  });
  const { dashboard } = loadDashboard({
    secrets: { apiToken: "test-token" },
    fetchImpl: async url => {
      const u = new URL(url);
      if (u.pathname === "/api/v1/server-group") {
        return response([{ group: { id: 1, name: "JP" }, servers: [1] }]);
      }
      if (u.pathname === "/api/v1/server/1/metrics") {
        return response({ data_points: mkSeries(20, 2) });
      }
      if (u.pathname === "/api/v1/server/1/service") {
        return response([
          mkMon(1, "Tokyo IX", 5),
          mkMon(2, "HK BGP", 34),
          mkMon(3, "SG Transit", 68),
          mkMon(4, "LA CN2", 142),
        ]);
      }
      if (u.pathname === "/api/v1/server/1/online-history") {
        const days = Number(u.searchParams.get("days")) || 1;
        const daily = Array.from({ length: days }, (_, i) => ({
          date: new Date(nowMs - (days - 1 - i) * 86400_000).toISOString().slice(0, 10),
          online_seconds: 86400,
          offline_seconds: 0,
          online_rate: 100,
        }));
        return response({
          server_id: 1,
          days,
          online_rate: 100,
          total_online_seconds: days * 86400,
          total_offline_seconds: 0,
          last_active: new Date(nowMs - 2000).toISOString(),
          daily,
        });
      }
      return response(basicPayload(u.pathname));
    },
  });
  const env = { inputs: { baseURL: "https://one.example.com" } };
  await dashboard.scheduled(env);

  // Clicking a server opens detail with full flyout height immediately (loading) and after load (overview charts)
  findNode(dashboard.render(env).panel, n => n.props?.key === "srv-1").props.onClick();
  assert.equal(dashboard.render(env).panel.props.preferredHeight, 626);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(dashboard.render(env).panel.props.preferredHeight, 626);

  // Network sub-tab with 4 monitors keeps full flyout height
  findNode(dashboard.render(env).panel, n => n.props?.key === "detail-tab-network").props.onClick();
  assert.equal(dashboard.render(env).panel.props.preferredHeight, 626);

  // Online sub-tab with 1 day (compact) auto-fits, while 7 days expands to full flyout height
  findNode(dashboard.render(env).panel, n => n.props?.key === "detail-tab-online").props.onClick();
  assert.equal(dashboard.render(env).panel.props.preferredHeight, undefined);

  findNode(dashboard.render(env).panel, n => n.props?.key === "period-7d").props.onClick();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(dashboard.render(env).panel.props.preferredHeight, 626);
});

test("traffic cards render compact cycle range, remaining time, and traffic-vs-time progress without next-update clutter", async () => {
  const fixedNow = Date.parse("2026-11-16T00:00:00+08:00");
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  const { dashboard } = loadDashboard({
    secrets: { apiToken: "test-token" },
    dateImpl: FakeDate,
    storage: { "nezha.tab": "traffic" },
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/v1/service") {
        return response({
          services: {},
          cycle_transfer_stats: {
            "1": {
              name: "edge-monthly",
              max: 1000,
              from: "2026-11-01T00:00:00+08:00",
              to: "2026-12-01T00:00:00+08:00",
              server_name: { "1": "alpha" },
              transfer: { "1": 620 },
              next_update: { "1": "2026-11-16T00:10:00+08:00" },
            },
            "2": {
              name: "edge-yearly",
              max: 2000,
              from: "2026-07-01T00:00:00+08:00",
              to: "2027-07-01T00:00:00+08:00",
              server_name: { "2": "beta" },
              transfer: { "2": 500 },
              next_update: { "2": "2026-11-16T00:12:00+08:00" },
            },
          },
        });
      }
      return response(basicPayload(pathname));
    },
  });
  const env = { inputs: { baseURL: "https://one.example.com", panelWidth: "small" } };
  await dashboard.scheduled(env);
  const panel = dashboard.render(env).panel;
  const serialized = JSON.stringify(panel);

  assert.ok(serialized.includes("流量 62.0%"), "card should show explicit traffic usage percentage");
  assert.ok(serialized.includes("时间 50.0%"), "card should show corresponding cycle elapsed percentage");
  assert.ok(serialized.includes("11/1 – 12/1"), "same-year cycle should omit redundant year");
  assert.ok(serialized.includes("26/7/1 – 27/7/1"), "cross-year cycle should use compact 2-digit years");
  assert.ok(serialized.includes("剩 15 天"), "card should show remaining cycle time");
  assert.ok(!serialized.includes("下次更新"), "card should omit low-value next-update timestamp");

  const card1 = findNode(panel, n => n.props?.key === "cyc-1:1");
  const fillNodes = [];
  const collect = node => {
    if (!node || typeof node !== "object") return;
    if (node.props?.key === "progress-fill") fillNodes.push(node);
    if (Array.isArray(node.children)) node.children.forEach(collect);
  };
  collect(card1);
  assert.equal(fillNodes.length, 2, "card should render both traffic and cycle-time progress bars");
  assert.ok(fillNodes[0].props.tw.includes("w-[62%]"), "top bar reflects traffic usage percentage");
  assert.ok(fillNodes[1].props.tw.includes("w-[50%]"), "bottom bar reflects cycle time percentage");
});

test("0.3.3 alerts coalesce bursts, include subtitle/group/silent, and auto-expand notch when granted", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1760000000000 });
  let phase = 0;
  let notchGrant = true;
  const { dashboard, notifications, notchStates, storage } = loadDashboard({
    secrets: { apiToken: "test-token" },
    capabilities: {
      "render.notch": true,
      "render.notch.activity": true,
      "notch.setState": true,
      "notification.subtitle": true,
      "notification.group": true,
      "notification.silent": true,
    },
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/v1/server") {
        const nowIso = new Date().toISOString();
        const offIso = new Date(Date.now() - 120000).toISOString();
        return response([
          { id: 1, name: "alpha", last_active: phase === 0 ? nowIso : offIso, host: { mem_total: 1000, disk_total: 1000 }, state: { cpu: 10, mem_used: 200, disk_used: 300, net_in_speed: 100, net_out_speed: 50 } },
          { id: 2, name: "beta", last_active: phase === 0 ? nowIso : offIso, host: { mem_total: 1000, disk_total: 1000 }, state: { cpu: 15, mem_used: 250, disk_used: 350, net_in_speed: 100, net_out_speed: 50 } },
        ]);
      }
      return response(basicPayload(pathname));
    },
  });
  const env = { inputs: { baseURL: "https://one.example.com" } };
  await dashboard.scheduled(env);
  assert.equal(notifications.length, 0);
  assert.equal(notchStates.length, 0);

  phase = 1;
  t.mock.timers.tick(6000);
  await dashboard.scheduled(env);
  await Promise.resolve();
  assert.equal(notifications.length, 1, "two simultaneous offline servers coalesce into one notification");
  assert.equal(notifications[0].options.tag, "nezha-off-batch");
  assert.equal(notifications[0].options.group, "nezha-offline");
  assert.ok(notifications[0].options.subtitle.includes("2"));
  assert.ok(notifications[0].options.body.includes("alpha") && notifications[0].options.body.includes("beta"));
  assert.equal(notchStates.length, 1, "notch.setState auto-expands when granted");
  assert.equal(notchStates[0].state, "expanded");
  assert.equal(notchStates[0].options.durationMs, 8000);

  notifications[0].onclick();
  assert.equal(storage.get("nezha.tab"), "alerts");
  assert.equal(notchGrant, true);
});

test("traffic pace warning renders projected usage on card and emits one silent notification", async t => {
  const day10 = Date.parse("2026-11-11T00:00:00+08:00");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: day10 });
  let usedBytes = 200;
  const { dashboard, notifications, notchStates } = loadDashboard({
    secrets: { apiToken: "test-token" },
    storage: { "nezha.tab": "traffic" },
    capabilities: {
      "notch.setState": true,
      "notification.subtitle": true,
      "notification.group": true,
      "notification.silent": true,
    },
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/v1/service") {
        return response({
          services: {},
          cycle_transfer_stats: {
            "1": {
              name: "edge-monthly",
              max: 1000,
              from: "2026-11-01T00:00:00+08:00",
              to: "2026-12-01T00:00:00+08:00",
              server_name: { "1": "alpha" },
              transfer: { "1": usedBytes },
              next_update: { "1": "2026-11-11T00:10:00+08:00" },
            },
          },
        });
      }
      return response(basicPayload(pathname));
    },
  });
  const env = { inputs: { baseURL: "https://one.example.com" } };
  await dashboard.scheduled(env);
  assert.equal(notifications.length, 0);

  usedBytes = 550; // 55% used at 33.3% elapsed -> projected ~165%
  t.mock.timers.tick(35000);
  await dashboard.scheduled(env);
  await Promise.resolve();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].options.tag, "nezha-traffic-1:1-pace");
  assert.equal(notifications[0].options.group, "nezha-traffic");
  assert.equal(notifications[0].options.silent, true);
  assert.equal(notchStates.length, 0, "low-priority pace warning should not force notch expansion");

  const serialized = JSON.stringify(dashboard.render(env).panel);
  assert.ok(serialized.includes("预计 165%"), "cycle card should display projected pace warning");
});

test("copy button flips to checkmark feedback and reverts after 1.5s", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1760000000000 });
  const { dashboard, copied, toasts } = loadDashboard({
    secrets: { apiToken: "test-token" },
    fetchImpl: async url => response(basicPayload(new URL(url).pathname)),
  });
  const env = { inputs: { baseURL: "https://one.example.com" } };
  await dashboard.scheduled(env);

  const listPanel = dashboard.render(env).panel;
  const serverCard = findNode(listPanel, n => n.props?.key === "srv-1");
  serverCard.props.onClick();

  const detailBefore = dashboard.render(env).panel;
  const copyBtnBefore = findNode(detailBefore, n => n.props?.key === "detail-copy-1");
  assert.equal(copyBtnBefore.props.tooltip, "复制");
  copyBtnBefore.props.onClick();
  await new Promise(r => setImmediate(r));
  assert.equal(copied.length, 1);
  assert.equal(toasts.length, 1);

  const detailAfter = dashboard.render(env).panel;
  const copyBtnAfter = findNode(detailAfter, n => n.props?.key === "detail-copy-1");
  assert.equal(copyBtnAfter.props.tooltip, "已复制");
  assert.ok(copyBtnAfter.children[0].props.tw.includes("text-[#10b981]"));

  t.mock.timers.tick(1600);
  const detailReverted = dashboard.render(env).panel;
  const copyBtnReverted = findNode(detailReverted, n => n.props?.key === "detail-copy-1");
  assert.equal(copyBtnReverted.props.tooltip, "复制");
});

test("Plus Inbox coalesces multi-message arrivals, silences info-only batches, and auto-expands notch on critical batches", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1760000000000 });
  let messages = [
    { inbox_id: "b1", seq: 1, source: "webhook", received_at: 1760000000, subject: "init" },
  ];
  const bodies = {
    1: JSON.stringify({ title: "init", content: "ok" }),
    2: JSON.stringify({ title: "节点已恢复 online", server: { name: "alpha" }, content: "alpha recovered" }),
    3: JSON.stringify({ title: "节点已恢复 online", server: { name: "beta" }, content: "beta recovered" }),
    4: JSON.stringify({ title: "服务器离线告警", server: { name: "gamma" }, content: "gamma offline" }),
    5: JSON.stringify({ title: "CPU 严重告警", server: { name: "delta" }, content: "delta cpu 99%" }),
  };
  const { dashboard, notifications, notchStates } = loadDashboard({
    secrets: { apiToken: "test-token" },
    capabilities: {
      "inbox.boxes": true,
      "inbox.message": true,
      "inbox.remove": true,
      "notch.setState": true,
      "notification.subtitle": true,
      "notification.group": true,
      "notification.silent": true,
    },
    inboxMock: {
      async boxes() { return [{ id: "b1", name: "Nezha", address: "https://inbox.example/b1", paused: false, message_count: messages.length, last_received_at: 1760000000 }]; },
      async list() { return messages; },
      async read(_id, seq) { return new TextEncoder().encode(bodies[seq] || ""); },
      async message() { return { subject: "", from: [], to: [], cc: [], text: "", attachments: [] }; },
    },
    fetchImpl: async url => response(basicPayload(new URL(url).pathname)),
  });
  const env = { inputs: { baseURL: "https://one.example.com" } };
  await dashboard.scheduled(env);
  assert.equal(notifications.length, 0);

  // Batch 1: two info (recovered) alerts -> 1 silent notification, no notch auto-expand
  messages = [
    { inbox_id: "b1", seq: 3, source: "webhook", received_at: 1760000020 },
    { inbox_id: "b1", seq: 2, source: "webhook", received_at: 1760000010 },
    { inbox_id: "b1", seq: 1, source: "webhook", received_at: 1760000000, subject: "init" },
  ];
  await dashboard.event("inboxchange", { inboxIds: ["b1"] });
  await Promise.resolve();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].options.tag, "nezha-inbox-batch");
  assert.equal(notifications[0].options.group, "nezha-inbox");
  assert.equal(notifications[0].options.silent, true);
  assert.equal(notchStates.length, 0);

  // Batch 2: two critical alerts -> 1 non-silent notification + notch auto-expand
  messages = [
    { inbox_id: "b1", seq: 5, source: "webhook", received_at: 1760000040 },
    { inbox_id: "b1", seq: 4, source: "webhook", received_at: 1760000030 },
    ...messages,
  ];
  await dashboard.event("inboxchange", { inboxIds: ["b1"] });
  await Promise.resolve();
  assert.equal(notifications.length, 2);
  assert.equal(notifications[1].options.tag, "nezha-inbox-batch");
  assert.equal(notifications[1].options.group, "nezha-inbox");
  assert.equal(notifications[1].options.silent, undefined);
  assert.equal(notchStates.length, 1);
  assert.equal(notchStates[0].state, "expanded");
});

test("bar source declares zh-Hans locale for title, description, and docs", () => {
  const raw = fs.readFileSync(new URL("./nezha.bar", import.meta.url), "utf8");
  assert.match(raw, /<locale\s+lang="zh-Hans"[^>]*title="哪吒监控"/);
  assert.match(raw, /<docs>[\s\S]*?<locale\s+lang="zh-Hans">/);
});
