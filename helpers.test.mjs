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
  formatBytes,
  mergeServiceRows,
  buildAttention,
  trayTitle,
  buildCycleTransfers,
  formatMonthDay,
  formatMonthDayTime,
  formatDuration,
  buildMonitorRows,
  buildOnlineSummary,
  buildDailyOnlineRows,
  formatDailyDuration,
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
    ["17", { id: 17, name: "edge-c", public_note: "keep-me", state: { cpu: 1 } }],
  ]);
  const next = mergeServerFrame(prev, {
    now: 1,
    servers: [{ id: 17, name: "edge-c", state: { cpu: 9 } }],
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
      state: {
        cpu: 10,
        net_in_speed: 1024,
        net_out_speed: 2048,
        net_in_transfer: 1024 * 1024 * 1024,
        net_out_transfer: 512 * 1024 * 1024,
      },
    },
    {
      id: 2,
      last_active: "2000-01-01T00:00:00Z",
      state: { cpu: 1, net_in_speed: 0, net_out_speed: 0, net_in_transfer: 1024, net_out_transfer: 2048 },
    },
  ]);
  assert.equal(s.online, 1);
  assert.equal(s.total, 2);
  assert.equal(s.transferDown, 1024 * 1024 * 1024 + 1024);
  assert.equal(s.transferUp, 512 * 1024 * 1024 + 2048);
  const title = trayTitle("online_total", s);
  assert.match(title, /^1\/2 · /);
});

test("buildCycleTransfers flattens cycle stats per server", () => {
  const rows = buildCycleTransfers({
    cycle_transfer_stats: {
      "8": {
        name: "yearly",
        from: "2026-07-01T16:18:00+08:00",
        to: "2027-07-01T16:18:00+08:00",
        max: 1099511627776,
        server_name: { "38": "edge-a" },
        transfer: { "38": 378272093289 },
        next_update: { "38": "2026-11-12T16:24:24+08:00" },
      },
      "2": {
        name: "aliyun_cdt",
        max: 214748364800,
        server_name: { "29": "edge-b" },
        transfer: { "29": 161061273600 },
        next_update: { "29": "2026-11-12T16:12:43+08:00" },
      },
      "9": { name: "zero", max: 0, server_name: { "1": "x" } },
    },
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].serverName, "edge-b");
  assert.ok(Math.abs(rows[0].pct - 75) < 0.01);
  assert.equal(rows[1].cycle, "yearly");
  assert.ok(rows[1].pct > 30 && rows[1].pct < 40);
  assert.equal(rows[1].serverId, "38");
});

test("cycle date formatters render stable shapes", () => {
  assert.match(formatMonthDay("2026-11-01T00:00:00+08:00"), /^11\/1\/2026$/);
  assert.match(formatMonthDayTime("2026-11-12T16:15:00+08:00"), /^11\/12 \d{2}:\d{2}$/);
  assert.equal(formatMonthDay(""), "");
});

test("buildMonitorRows computes loss and sorts by delay", () => {
  const rows = buildMonitorRows([
    { monitor_id: 2, monitor_name: "fast", created_at: [1, 2, 3, 4], avg_delay: [5, 6, null, 7] },
    { monitor_id: 9, monitor_name: "slow", created_at: [1, 2], avg_delay: [80, null] },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "fast");
  assert.equal(rows[0].lossPct, 25);
  assert.equal(rows[0].delay, 7);
  assert.equal(rows[1].name, "slow");
  assert.equal(rows[1].lossPct, 50);
  assert.equal(rows[1].points.length, 1);
});

test("buildOnlineSummary derives rates and windows", () => {
  const s = buildOnlineSummary({ total_online_seconds: 86378, online_rate: 99.97, currently_online: true, daily: [{ date: "2026-11-11", online_seconds: 100 }] }, 86400);
  assert.equal(s.onlineSeconds, 86378);
  assert.equal(s.offlineSeconds, 22);
  assert.ok(s.ratePct > 99);
  assert.equal(s.daily.length, 1);
  assert.equal(s.currentlyOnline, true);
});

test("formatDuration renders hours and days", () => {
  assert.equal(formatDuration(0), "0h 0m");
  assert.equal(formatDuration(86378), "23h 59m");
  assert.equal(formatDuration(180000), "2d 2h");
});

test("buildDailyOnlineRows colors by day rate with partial today", () => {
  const now = new Date("2026-11-12T16:30:00+08:00").getTime();
  const rows = buildDailyOnlineRows(
    [
      { date: "2026-11-10", online_seconds: 86410 },
      { date: "2026-11-09", online_seconds: 84480 },
      { date: "2026-11-12", online_seconds: 59400 },
    ],
    now
  );
  const by = Object.fromEntries(rows.map(r => [r.date, r]));
  assert.equal(by["2026-11-10"].color, "success");
  assert.equal(by["2026-11-09"].color, "warning");
  assert.equal(by["2026-11-12"].color, "success");
  assert.equal(by["2026-11-12"].isToday, true);
  assert.ok(Math.abs(by["2026-11-12"].pct - 100) < 2);

  const camel = buildDailyOnlineRows([{ date: "2026-11-10", onlineSeconds: 86410 }], now);
  assert.equal(camel[0].color, "success");
  assert.equal(camel[0].pct, 100);
});

test("formatDailyDuration caps at hours", () => {
  assert.equal(formatDailyDuration(86410), "24h 0m");
  assert.equal(formatDailyDuration(59400), "16h 30m");
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

test("formatBytes supports compact transfer totals", () => {
  assert.equal(formatBytes(0), "0.0 B");
  assert.equal(formatBytes(1536 * 1024 * 1024, 1, true), "1.5G");
  assert.equal(formatBytes(869 * 1024, 1, true), "869K");
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
