import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBaseURL,
  unwrapNezha,
  isServerOnline,
  mergeServerFrame,
  mergeServerList,
  buildGroupIndex,
  scopedServers,
  summarizeScoped,
  formatRate,
  mergeServiceRows,
  buildAttention,
  trayTitle,
  detectTransitions,
} from "./helpers.mjs";

test("normalizeBaseURL strips path and adds https", () => {
  assert.equal(normalizeBaseURL("nezha.example.com/"), "https://nezha.example.com");
  assert.equal(normalizeBaseURL("https://nezha.example.com/api"), "https://nezha.example.com");
  assert.equal(normalizeBaseURL(""), "");
});

test("unwrapNezha returns data and throws on error", () => {
  assert.deepEqual(unwrapNezha({ success: true, data: [1] }), [1]);
  assert.throws(() => unwrapNezha({ success: false, error: "nope" }), /nope/);
  assert.throws(() => unwrapNezha({ error: "ApiErrorUnauthorized" }), /ApiErrorUnauthorized/);
});

test("isServerOnline uses last_active window", () => {
  const now = Date.parse("2026-11-12T02:42:40.000Z");
  assert.equal(
    isServerOnline({ last_active: "2026-11-12T10:42:39.729+08:00" }, now, 30000),
    true
  );
  assert.equal(
    isServerOnline({ last_active: "2026-11-12T10:40:00+08:00" }, now, 30000),
    false
  );
});

test("mergeServerFrame keeps public_note across delta frames", () => {
  const prev = new Map([
    ["17", { id: 17, name: "zouter-jp", public_note: "keep-me", state: { cpu: 1 } }],
  ]);
  const next = mergeServerFrame(prev, {
    now: 1,
    servers: [{ id: 17, name: "zouter-jp", state: { cpu: 9 } }],
  });
  assert.equal(next.get("17").public_note, "keep-me");
  assert.equal(next.get("17").state.cpu, 9);
});

test("scopedServers applies group then watchlist; empty watchlist means all", () => {
  const servers = new Map([
    ["17", { id: 17, name: "jp" }],
    ["21", { id: 21, name: "hk" }],
    ["19", { id: 19, name: "sg" }],
  ]);
  const { byServer } = buildGroupIndex([
    { group: { id: 3, name: "JP" }, servers: [17] },
    { group: { id: 1, name: "HK" }, servers: [21] },
  ]);
  const inJp = scopedServers({ servers, groupId: "3", byServerGroup: byServer });
  assert.deepEqual(inJp.map(s => s.id), [17]);
  const starredEmpty = scopedServers({
    servers,
    watchMode: "starred",
    watchlist: new Set(),
    byServerGroup: byServer,
  });
  assert.equal(starredEmpty.length, 3);
  const starred = scopedServers({
    servers,
    watchMode: "starred",
    watchlist: new Set(["21"]),
    byServerGroup: byServer,
  });
  assert.deepEqual(starred.map(s => s.id), [21]);
});

test("trayTitle formats online_total", () => {
  const s = summarizeScoped([
    {
      id: 1,
      last_active: new Date().toISOString(),
      state: { cpu: 10, net_in_speed: 1024, net_out_speed: 2048 },
    },
    { id: 2, last_active: "2000-01-01T00:00:00Z", state: { cpu: 1, net_in_speed: 0, net_out_speed: 0 } },
  ]);
  assert.equal(s.online, 1);
  assert.equal(s.total, 2);
  const title = trayTitle("online_total", s);
  assert.match(title, /^1\/2 · /);
});

test("mergeServiceRows joins list and overview", () => {
  const rows = mergeServiceRows(
    [{ id: 12, name: "NovaXNS JP", type: 2, target: "x" }],
    { services: { "12": { current_up: 10, current_down: 0, delay: [1, 2, 3.5] } } }
  );
  assert.equal(rows[0].typeLabel, "Ping");
  assert.equal(rows[0].delay, 3.5);
  assert.equal(rows[0].failing, false);
});

test("buildAttention lists offline and failing probes", () => {
  const now = Date.now();
  const { items } = buildAttention({
    nowMs: now,
    servers: [
      { id: 1, name: "up", last_active: new Date(now).toISOString() },
      { id: 2, name: "down", last_active: "2000-01-01T00:00:00Z" },
    ],
    services: [{ id: 9, name: "probe", typeLabel: "Ping", currentUp: 0, currentDown: 5, failing: true }],
    alertRules: [{ id: 1, name: "离线通知", enable: true }],
  });
  assert.ok(items.some(i => i.kind === "offline" && i.title === "down"));
  assert.ok(items.some(i => i.kind === "probe" && i.title === "probe"));
});

test("detectTransitions reports newly offline ids", () => {
  const { wentOffline } = detectTransitions(new Set(["1", "2"]), new Set(["1"]));
  assert.deepEqual(wentOffline, ["2"]);
});

test("formatRate scales bytes", () => {
  assert.equal(formatRate(0), "0.0B/s");
  assert.match(formatRate(1536), /K\/s$/);
});

test("mergeServerList preserves public_note when REST omits it", () => {
  const prev = new Map([
    ["17", { id: 17, name: "jp", public_note: "note-kept", state: { cpu: 5 } }],
  ]);
  const next = mergeServerList(prev, [{ id: 17, name: "jp", state: { cpu: 7 } }]);
  const s = next.get("17");
  assert.equal(s.public_note, "note-kept");
  assert.equal(s.state.cpu, 7);
  assert.equal(next.size, 1);
});

test("mergeServerList adds new servers and drops removed ones", () => {
  const prev = new Map([["1", { id: 1, name: "a" }]]);
  const next = mergeServerList(prev, [{ id: 1, name: "a" }, { id: 2, name: "b" }]);
  assert.deepEqual(Array.from(next.keys()).sort(), ["1", "2"]);
  const after = mergeServerList(next, [{ id: 1, name: "a" }]);
  assert.deepEqual(Array.from(after.keys()), ["1"]);
});

test("mergeServiceRows copies display_index for ordering", () => {
  const rows = mergeServiceRows(
    [{ id: 1, name: "B", type: 2, display_index: 5 }, { id: 2, name: "A", type: 1, display_index: 1 }],
    { services: {} }
  );
  assert.deepEqual(rows.map(r => r.name), ["A", "B"]);
  assert.equal(rows[0].display_index, 1);
});
