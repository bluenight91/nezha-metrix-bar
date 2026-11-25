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
  pickRateScale,
  formatBytes,
  mergeServiceRows,
  maskServiceTarget,
  buildAttention,
  trayTitle,
  buildCycleTransfers,
  formatMonthDay,
  formatMonthDayTime,
  formatCycleRange,
  computeCycleTimeProgress,
  formatCycleRemaining,
  formatDuration,
  buildMonitorRows,
  toggleMonitorSelection,
  alignMonitorSeries,
  downsamplePoints,
  resolveDetailPeriod,
  periodDays,
  buildOnlineSummary,
  buildDailyOnlineRows,
  formatDailyDuration,
  detectTransitions,
  resolveGroupSelection,
  resourceColor,
  formatRelativeTime,
  filterServers,
  detectTrafficThresholds,
  computeCyclePace,
  detectTrafficPaceAlerts,
  buildBatchNotificationSummary,
  resolveWidgetServer,
  pushFleetSample,
  buildSparkPoints,
  formatShortRate,
  formatCompactNotchValue,
  buildTrayContent,
  resolvePanelWidth,
  chooseGroupNavMode,
  shouldUseFullDetailHeight,
  sortServerList,
  resolveOutputDemand,
  parseNotificationTarget,
  inferAlertSeverity,
  parseInboxAlert,
  trackInboxArrival,
  isInboxUnread,
  setInboxRead,
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

test("formatCycleRange omits redundant year for same-year cycles and shortens cross-year ranges", () => {
  assert.equal(formatCycleRange("2026-10-25T00:00:00+08:00", "2026-11-25T00:00:00+08:00"), "10/25 – 11/25");
  assert.equal(formatCycleRange("2026-07-01T00:00:00+08:00", "2027-07-01T00:00:00+08:00"), "26/7/1 – 27/7/1");
  assert.equal(formatCycleRange("", ""), "");
  assert.equal(formatCycleRange("2026-11-01T00:00:00+08:00", ""), "11/1");
});

test("computeCycleTimeProgress calculates elapsed ratio and clamps boundaries", () => {
  const from = "2026-11-01T00:00:00Z";
  const to = "2026-12-01T00:00:00Z";
  const mid = Date.parse("2026-11-16T00:00:00Z");
  const info = computeCycleTimeProgress(from, to, mid);
  assert.ok(info);
  assert.ok(Math.abs(info.timePct - 50) < 0.01);
  assert.equal(info.remainingMs, 15 * 86_400_000);
  assert.equal(info.ended, false);

  const before = computeCycleTimeProgress(from, to, Date.parse("2026-10-31T00:00:00Z"));
  assert.equal(before.timePct, 0);
  assert.equal(before.ended, false);

  const after = computeCycleTimeProgress(from, to, Date.parse("2026-12-02T00:00:00Z"));
  assert.equal(after.timePct, 100);
  assert.equal(after.remainingMs, 0);
  assert.equal(after.ended, true);

  assert.equal(computeCycleTimeProgress("", to, mid), null);
  assert.equal(computeCycleTimeProgress(to, from, mid), null);
});

test("formatCycleRemaining formats minutes, hours, days, and ended state in zh and en", () => {
  assert.equal(formatCycleRemaining(0, "zh"), "已结束");
  assert.equal(formatCycleRemaining(-5000, "en"), "Ended");
  assert.equal(formatCycleRemaining(25 * 60_000, "zh"), "剩 25 分钟");
  assert.equal(formatCycleRemaining(25 * 60_000, "en"), "25m left");
  assert.equal(formatCycleRemaining(8.5 * 3_600_000, "zh"), "剩 9 小时");
  assert.equal(formatCycleRemaining(8.5 * 3_600_000, "en"), "9h left");
  assert.equal(formatCycleRemaining(24 * 3_600_000, "zh"), "剩 1 天");
  assert.equal(formatCycleRemaining(6.3 * 86_400_000, "zh"), "剩 6 天");
  assert.equal(formatCycleRemaining(6.3 * 86_400_000, "en"), "6d left");
  assert.equal(formatCycleRemaining(Number.NaN, "zh"), "");
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


test("summarizeScoped excludes stale offline rates but keeps transfer totals", () => {
  const now = Date.parse("2026-11-12T00:00:00Z");
  const summary = summarizeScoped([
    {
      id: 1,
      last_active: new Date(now).toISOString(),
      state: { net_in_speed: 1024, net_out_speed: 2048, net_in_transfer: 100, net_out_transfer: 200 },
    },
    {
      id: 2,
      last_active: "2000-01-01T00:00:00Z",
      state: { net_in_speed: 4096, net_out_speed: 8192, net_in_transfer: 300, net_out_transfer: 400 },
    },
  ], now);
  assert.equal(summary.netDown, 1024);
  assert.equal(summary.netUp, 2048);
  assert.equal(summary.transferDown, 400);
  assert.equal(summary.transferUp, 600);
});

test("mergeServerList drops inherited online boolean when REST omits it", () => {
  const prev = new Map([
    ["1", { id: 1, online: true, last_active: "2000-01-01T00:00:00Z" }],
  ]);
  const next = mergeServerList(prev, [{ id: 1, last_active: "2000-01-01T00:00:00Z" }]);
  assert.equal(next.get("1").online, undefined);
  assert.equal(isServerOnline(next.get("1"), Date.parse("2026-11-12T00:00:00Z")), false);
});

test("buildGroupIndex and scopedServers preserve multiple group memberships", () => {
  const { byServer } = buildGroupIndex([
    { group: { id: 1, name: "A" }, servers: [7] },
    { group: { id: 2, name: "B" }, servers: [7] },
  ]);
  assert.equal(byServer.get("7").length, 2);
  const servers = new Map([[7, { id: 7, name: "shared" }]]);
  for (const groupId of [1, 2]) {
    const scoped = scopedServers({ servers, groupId, byServerGroup: byServer });
    assert.deepEqual(scoped.map(s => s.id), [7]);
  }
});

test("resolveGroupSelection falls back to all for removed groups", () => {
  const groups = [{ id: "1", name: "A" }, { id: "2", name: "B" }];
  assert.equal(resolveGroupSelection("2", groups), "2");
  assert.equal(resolveGroupSelection("deleted", groups), "all");
  assert.equal(resolveGroupSelection("all", groups), "all");
});


test("resourceColor reserves warning and danger for high usage", () => {
  assert.equal(resourceColor(6), "accent");
  assert.equal(resourceColor(79.9), "accent");
  assert.equal(resourceColor(80), "warning");
  assert.equal(resourceColor(90), "danger");
});

test("formatRelativeTime renders compact localized ages", () => {
  const now = Date.parse("2026-11-12T12:00:00Z");
  assert.equal(formatRelativeTime("2026-11-12T11:59:40Z", now, "zh"), "刚刚");
  assert.equal(formatRelativeTime("2026-11-12T11:55:00Z", now, "zh"), "5 分钟前");
  assert.equal(formatRelativeTime("2026-11-12T09:00:00Z", now, "en"), "3h ago");
  assert.equal(formatRelativeTime("", now, "zh"), "");
});


test("buildCycleTransfers exposes remaining quota", () => {
  const [row] = buildCycleTransfers({
    cycle_transfer_stats: {
      "1": { name: "monthly", max: 1000, server_name: { "1": "demo" }, transfer: { "1": 800 } },
    },
  });
  assert.equal(row.remaining, 200);
});

test("buildAttention includes cycle traffic at warning and critical thresholds", () => {
  const { items } = buildAttention({
    servers: [],
    services: [],
    alertRules: [],
    cycleTransfers: [
      { id: "1:1", serverName: "demo", cycle: "monthly", pct: 80, remaining: 200 },
      { id: "2:2", serverName: "critical", cycle: "weekly", pct: 96, remaining: 40 },
      { id: "3:3", serverName: "normal", cycle: "monthly", pct: 79, remaining: 210 },
    ],
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, "traffic");
  assert.equal(items[0].severity, "warning");
  assert.equal(items[1].severity, "critical");
});

test("detectTrafficThresholds reports only upward crossings and allows reset", () => {
  const rows = [{ id: "1:1", pct: 79, serverName: "demo", cycle: "monthly" }];
  let previous = new Map();
  let result = detectTrafficThresholds(previous, rows);
  assert.equal(result.crossed.length, 0);
  previous = result.nextLevels;
  rows[0].pct = 80;
  result = detectTrafficThresholds(previous, rows);
  assert.equal(result.crossed.length, 1);
  assert.equal(result.crossed[0].level, 1);
  result = detectTrafficThresholds(result.nextLevels, rows);
  assert.equal(result.crossed.length, 0);
  rows[0].pct = 95;
  result = detectTrafficThresholds(result.nextLevels, rows);
  assert.equal(result.crossed[0].level, 2);
  rows[0].pct = 0;
  result = detectTrafficThresholds(result.nextLevels, rows);
  rows[0].pct = 82;
  result = detectTrafficThresholds(result.nextLevels, rows);
  assert.equal(result.crossed[0].level, 1);
});

test("filterServers matches name and public note case-insensitively", () => {
  const list = [
    { id: 1, name: "Tokyo", public_note: "production" },
    { id: 2, name: "Frankfurt", public_note: "Backup" },
  ];
  assert.deepEqual(filterServers(list, "tok").map(s => s.id), [1]);
  assert.deepEqual(filterServers(list, "back").map(s => s.id), [2]);
  assert.equal(filterServers(list, " ").length, 2);
});


test("resolveWidgetServer accepts an ID or one case-insensitive exact name", () => {
  const servers = new Map([
    ["1", { id: 1, name: "Edge-One" }],
    ["2", { id: 2, name: "Edge-Two" }],
  ]);
  assert.equal(resolveWidgetServer(servers, "2").server, servers.get("2"));
  assert.equal(resolveWidgetServer(servers, "edge-one").server, servers.get("1"));
  assert.equal(resolveWidgetServer(servers, " Edge-One ").status, "ok");
});

test("resolveWidgetServer reports empty, missing, and ambiguous selectors", () => {
  const servers = new Map([
    ["1", { id: 1, name: "duplicate" }],
    ["2", { id: 2, name: "Duplicate" }],
  ]);
  assert.equal(resolveWidgetServer(servers, "").status, "empty");
  assert.equal(resolveWidgetServer(servers, "missing").status, "missing");
  assert.equal(resolveWidgetServer(servers, "DUPLICATE").status, "ambiguous");
});


test("pushFleetSample bounds ring buffer and buildSparkPoints emits finite coordinates", () => {
  let hist = [];
  for (let i = 0; i < 65; i += 1) {
    hist = pushFleetSample(hist, { netDown: i * 100, netUp: i * 50, avgCpu: i, online: 2, total: 2 }, 1000 + i, 60);
  }
  assert.equal(hist.length, 60);
  assert.equal(hist[0].ts, 1005);
  assert.equal(hist[59].totalRate, 64 * 150);
  const pts = buildSparkPoints(hist, "cpu", 10);
  assert.equal(pts.length, 10);
  assert.deepEqual(pts[0], { x: 0, y: 55 });
  assert.deepEqual(pts[9], { x: 9, y: 64 });
});

test("formatShortRate and formatCompactNotchValue fit compact notch budgets", () => {
  assert.equal(formatShortRate(0), "0B");
  assert.equal(formatShortRate(512 * 1024), "512K");
  assert.equal(formatShortRate(1.5 * 1024 * 1024), "1.5M");
  const summary = { online: 21, total: 21, netDown: 200 * 1024, netUp: 140 * 1024, avgCpu: 18.4 };
  assert.equal(formatCompactNotchValue("rate", summary), "340K");
  assert.equal(formatCompactNotchValue("down", summary), "↓200K");
  assert.equal(formatCompactNotchValue("up", summary), "↑140K");
  assert.equal(formatCompactNotchValue("cpu", summary), "18%");
  assert.equal(formatCompactNotchValue("online", summary), "21/21");
});

test("buildTrayContent builds valid height-22 rich trees and returns null for text modes", () => {
  const summary = { online: 21, total: 21, netDown: 1024 * 1024, netUp: 512 * 1024, avgCpu: 22 };
  assert.equal(buildTrayContent({ format: "online_total", summary }), null);
  const history = [
    { ts: 1, cpu: 10, totalRate: 1000 },
    { ts: 2, cpu: 22, totalRate: 2000 },
  ];
  const stacked = buildTrayContent({ format: "stacked_rate", summary, history, canIcon: true, brandSvg: "<svg/>" });
  assert.equal(stacked.props.height, 22);
  assert.equal(stacked.props.gap, 3);
  assert.ok(stacked.props.width >= 16 && stacked.props.width <= 240);
  assert.equal(stacked.children[0].type, "Icon");
  assert.equal(stacked.children[1].type, "Column");
  assert.ok(stacked.children[1].props.width < 44, "stacked rate column should stay snug to avoid a wide gap after the logo");

  const stackedNoIcon = buildTrayContent({ format: "stacked_rate", summary, history, canIcon: true, showIcon: false, brandSvg: "<svg/>" });
  assert.equal(stackedNoIcon.children.some(c => c.type === "Icon"), false);
  assert.ok(stackedNoIcon.props.width < stacked.props.width);

  const rateSpark = buildTrayContent({ format: "rate_spark", summary, history, canIcon: false });
  assert.equal(rateSpark.props.height, 22);
  assert.ok(rateSpark.children.some(c => c.type === "Chart"));

  const cpuSpark = buildTrayContent({ format: "cpu_spark", summary, history, canIcon: true, brandSvg: "<svg/>" });
  assert.equal(cpuSpark.props.height, 22);
  assert.equal(cpuSpark.props.gap, 3);
  assert.ok(cpuSpark.children.some(c => c.type === "Chart"));
  const cpuSparkNoIcon = buildTrayContent({ format: "cpu_spark", summary, history, canIcon: true, showIcon: false, brandSvg: "<svg/>" });
  assert.equal(cpuSparkNoIcon.children.some(c => c.type === "Icon"), false);
  assert.ok(cpuSparkNoIcon.props.width < cpuSpark.props.width);
  assert.equal(trayTitle("rate_spark", summary), "21/21 · ↑512K/s ↓1.00M/s");
  assert.equal(trayTitle("cpu_spark", summary), "21/21 · 22%");
});

test("resolvePanelWidth maps small/medium/large presets and falls back to medium", () => {
  assert.equal(resolvePanelWidth("small"), 400);
  assert.equal(resolvePanelWidth("medium"), 460);
  assert.equal(resolvePanelWidth("large"), 520);
  assert.equal(resolvePanelWidth(""), 460);
  assert.equal(resolvePanelWidth("unknown"), 460);
  assert.equal(resolvePanelWidth(null), 460);
});

test("chooseGroupNavMode picks bar, scroll, or select based on count and available width", () => {
  assert.equal(chooseGroupNavMode([{ label: "全部", value: "all" }], 380), "none");
  const sixRegions = [
    { label: "全部", value: "all" },
    { label: "🇨🇳 CN", value: "1" },
    { label: "🇭🇰 HK", value: "2" },
    { label: "🇯🇵 JP", value: "3" },
    { label: "🇸🇬 SGP", value: "4" },
    { label: "🇺🇸 US", value: "5" },
  ];
  assert.equal(chooseGroupNavMode(sixRegions, 380), "bar");

  const longGroups = [
    { label: "全部", value: "all" },
    { label: "Hong Kong Edge", value: "1" },
    { label: "Singapore Core", value: "2" },
    { label: "Tokyo Transit", value: "3" },
    { label: "Frankfurt EU", value: "4" },
    { label: "Los Angeles US", value: "5" },
  ];
  assert.equal(chooseGroupNavMode(longGroups, 380), "scroll");

  const manyGroups = Array.from({ length: 9 }, (_, i) => ({ label: `G${i}`, value: String(i) }));
  assert.equal(chooseGroupNavMode(manyGroups, 480), "select");
});

test("sortServerList sorts multiple columns with direction while keeping offline servers last", () => {
  const now = Date.parse("2026-11-22T00:00:00Z");
  const list = [
    { id: 1, name: "beta", last_active: new Date(now).toISOString(), state: { cpu: 10, mem_used: 800, net_in_speed: 500, load_1: 0.4 }, host: { mem_total: 1000 } },
    { id: 2, name: "alpha", last_active: new Date(now).toISOString(), state: { cpu: 40, mem_used: 200, net_in_speed: 100, load_1: 1.5 }, host: { mem_total: 1000 } },
    { id: 3, name: "dead", last_active: "2000-01-01T00:00:00Z", state: { cpu: 99, mem_used: 999, net_in_speed: 9999, load_1: 9.0 }, host: { mem_total: 1000 } },
  ];
  assert.deepEqual(sortServerList(list, "cpu", "desc", now).map(s => s.id), [2, 1, 3]);
  assert.deepEqual(sortServerList(list, "cpu", "asc", now).map(s => s.id), [1, 2, 3]);
  assert.deepEqual(sortServerList(list, "mem", "desc", now).map(s => s.id), [1, 2, 3]);
  assert.deepEqual(sortServerList(list, "name", "asc", now).map(s => s.id), [2, 1, 3]);
});

test("resolveOutputDemand normalizes missing and explicit output snapshots", () => {
  const unknown = resolveOutputDemand(null);
  assert.equal(unknown.known, false);
  assert.equal(unknown.panel, true);
  assert.deepEqual(unknown.widgetFamilies, ["small", "medium", "large"]);

  const quiet = resolveOutputDemand({ tray: true, panel: false, notch: "compact", widget: { known: true, families: ["medium"] } });
  assert.equal(quiet.known, true);
  assert.equal(quiet.panel, false);
  assert.equal(quiet.notch, "compact");
  assert.deepEqual(quiet.widgetFamilies, ["medium"]);
});

test("parseNotificationTarget maps notification tags to panel navigation targets", () => {
  assert.deepEqual(parseNotificationTarget("nezha-off-17"), { tab: "servers", serverId: "17" });
  assert.deepEqual(parseNotificationTarget("nezha-probe-9"), { tab: "services", serviceId: "9" });
  assert.deepEqual(parseNotificationTarget("nezha-traffic-5:1-2"), { tab: "servers", serverId: "5" });
  assert.deepEqual(parseNotificationTarget("nezha-inbox-box1:42"), { tab: "alerts", inboxKey: "box1:42" });
  assert.deepEqual(parseNotificationTarget("nezha-off-batch"), { tab: "alerts" });
  assert.deepEqual(parseNotificationTarget("nezha-probe-batch"), { tab: "services" });
  assert.deepEqual(parseNotificationTarget("nezha-traffic-batch"), { tab: "traffic" });
  assert.deepEqual(parseNotificationTarget("nezha-inbox-batch"), { tab: "alerts" });
});

test("parseInboxAlert extracts structured Nezha webhook JSON and email alerts", () => {
  const webhook = parseInboxAlert(
    { inbox_id: "b1", seq: 7, source: "webhook", received_at: 1760000000 },
    JSON.stringify({ title: "服务器离线告警", server: { name: "kfc-jp" }, content: "kfc-jp 离线超过 60s" })
  );
  assert.equal(webhook.title, "服务器离线告警");
  assert.equal(webhook.serverName, "kfc-jp");
  assert.equal(webhook.severity, "critical");
  assert.match(webhook.body, /kfc-jp/);

  const recovered = parseInboxAlert(
    { inbox_id: "b1", seq: 8, source: "email", received_at: 1760000010, subject: "Nezha Alert" },
    { subject: "节点已恢复 online", text: "kfc-jp 已重新上线" }
  );
  assert.equal(recovered.severity, "info");
  assert.equal(inferAlertSeverity("CPU 阈值 90% 警告"), "warning");
});

test("trackInboxArrival suppresses first-load noise and tracks read/unread state", () => {
  const boxes = {};
  const first = trackInboxArrival(boxes, "box1", [{ seq: 10 }, { seq: 9 }]);
  assert.equal(first.length, 0);
  assert.equal(isInboxUnread(boxes, "box1", 10), false);

  const second = trackInboxArrival(boxes, "box1", [{ seq: 12 }, { seq: 11 }, { seq: 10 }]);
  assert.deepEqual(second.map(m => m.seq), [12, 11]);
  assert.equal(isInboxUnread(boxes, "box1", 12), true);
  assert.equal(setInboxRead(boxes, "box1", 12, true), true);
  assert.equal(isInboxUnread(boxes, "box1", 12), false);
  assert.equal(setInboxRead(boxes, "box1", 10, false), true);
  assert.equal(isInboxUnread(boxes, "box1", 10), true);
});


test("pickRateScale chooses human-friendly rate units for chart Y axes", () => {
  assert.deepEqual(pickRateScale(0), { divisor: 1, unit: "B/s" });
  assert.deepEqual(pickRateScale(500), { divisor: 1, unit: "B/s" });
  assert.deepEqual(pickRateScale(800 * 1024), { divisor: 1024, unit: "KB/s" });
  assert.deepEqual(pickRateScale(2_000_000), { divisor: 1024 ** 2, unit: "MB/s" });
  assert.deepEqual(pickRateScale(2 * 1024 ** 3), { divisor: 1024 ** 3, unit: "GB/s" });
});

test("buildMonitorRows treats zero/negative delays as packet loss, computes min/max/avg, and sorts by display_index", () => {
  const rows = buildMonitorRows([
    { monitor_id: 9, monitor_name: "Cloudflare", display_index: 1, created_at: [1, 2, 3, 4], avg_delay: [1.5, 0, 2.5, 1.0] },
    { monitor_id: 2, monitor_name: "Chinanet", display_index: 10, created_at: [1, 2, 3, 4], avg_delay: [290, 142, 363, -1] },
    { monitor_id: 1, monitor_name: "Unicom", display_index: 10, created_at: [1, 2], avg_delay: [0, 0] },
  ]);
  assert.deepEqual(rows.map(r => r.name), ["Unicom", "Chinanet", "Cloudflare"]);

  assert.equal(rows[0].lossPct, 100);
  assert.equal(rows[0].delay, null);
  assert.equal(rows[0].avgDelay, null);
  assert.equal(rows[0].minDelay, null);
  assert.equal(rows[0].maxDelay, null);
  assert.equal(rows[0].points.length, 0);

  assert.equal(rows[1].lossPct, 25);
  assert.equal(rows[1].delay, 363);
  assert.equal(rows[1].minDelay, 142);
  assert.equal(rows[1].maxDelay, 363);
  assert.equal(Number(rows[1].avgDelay.toFixed(1)), 265.0);
  assert.equal(rows[1].points.length, 3);

  assert.equal(rows[2].lossPct, 25);
  assert.equal(rows[2].delay, 1.0);
  assert.equal(rows[2].minDelay, 1.0);
  assert.equal(rows[2].maxDelay, 2.5);
  assert.equal(Number(rows[2].avgDelay.toFixed(2)), 1.67);
});

test("downsamplePoints preserves full time span within maxPoints", () => {
  const short = [{ ts: 1, value: 1 }, { ts: 2, value: 2 }];
  assert.deepEqual(downsamplePoints(short, 10), short);

  const many = Array.from({ length: 300 }, (_, i) => ({ ts: 1000 + i * 60_000, value: i + 1 }));
  const sampled = downsamplePoints(many, 60);
  assert.equal(sampled.length, 60);
  assert.equal(sampled[0].ts, many[0].ts);
  assert.equal(sampled[sampled.length - 1].ts, many[many.length - 1].ts);
});

test("resolveDetailPeriod clamps guests to 1d and allows 30d with auth", () => {
  assert.equal(resolveDetailPeriod("7d", false), "1d");
  assert.equal(resolveDetailPeriod("30d", false), "1d");
  assert.equal(resolveDetailPeriod("1d", true), "1d");
  assert.equal(resolveDetailPeriod("7d", true), "7d");
  assert.equal(resolveDetailPeriod("30d", true), "30d");
  assert.equal(resolveDetailPeriod("invalid", true), "1d");
  assert.equal(periodDays("1d"), 1);
  assert.equal(periodDays("7d"), 7);
  assert.equal(periodDays("30d"), 30);
});

test("toggleMonitorSelection supports multi-select comparison and auto-resets when all selected", () => {
  let sel = new Set();
  sel = toggleMonitorSelection(sel, "1", 3);
  assert.deepEqual([...sel], ["1"]);
  sel = toggleMonitorSelection(sel, "2", 3);
  assert.deepEqual([...sel], ["1", "2"]);
  // Selecting the 3rd of 3 collapses back to empty (= show all)
  sel = toggleMonitorSelection(sel, "3", 3);
  assert.equal(sel.size, 0);

  // Removing an existing selection keeps remaining items
  sel = toggleMonitorSelection(new Set(["1", "2"]), "1", 3);
  assert.deepEqual([...sel], ["2"]);
  sel = toggleMonitorSelection(sel, "2", 3);
  assert.equal(sel.size, 0);
});

test("alignMonitorSeries snaps staggered monitor timestamps onto a shared x grid", () => {
  const base = 1795300020000;
  const ptsA = Array.from({ length: 200 }, (_, i) => ({ ts: base + i * 60_000, value: 200 + (i % 10) }));
  // Staggered by +30s and missing one point in the middle (simulating packet loss)
  const ptsB = Array.from({ length: 200 }, (_, i) => ({ ts: base + i * 60_000 + 30_000, value: 1.5 }))
    .filter((_, i) => i !== 75);

  const aligned = alignMonitorSeries([ptsA, ptsB], 60);
  assert.equal(aligned.length, 2);
  assert.equal(aligned[0].length, 60);
  assert.equal(aligned[1].length, 60);
  assert.deepEqual(
    aligned[0].map(p => p.ts),
    aligned[1].map(p => p.ts),
    "all active monitors must share identical x timestamps for multi-series hover"
  );
});

test("maskServiceTarget masks IPv4, IPv6, hostnames, and full URLs while keeping shape readable", () => {
  assert.equal(maskServiceTarget(""), "");
  assert.equal(maskServiceTarget("   "), "");

  // IPv4 with and without port
  assert.equal(maskServiceTarget("198.51.100.42"), "198.*.*.42");
  assert.equal(maskServiceTarget("198.51.100.42:8443"), "198.*.*.42:8443");

  // IPv6 with and without brackets/port
  assert.equal(maskServiceTarget("2001:db8:85a3::8a2e:370:7334"), "2001:****:7334");
  assert.equal(maskServiceTarget("[2001:db8::1]:443"), "[2001:****:1]:443");
  assert.equal(maskServiceTarget("::1"), "::****");

  // Hostnames with and without port
  assert.equal(maskServiceTarget("example.com"), "e***.com");
  assert.equal(maskServiceTarget("api.example.com"), "a***.e***.com");
  assert.equal(maskServiceTarget("hk.example.com:443"), "h***.e***.com:443");

  // Full URLs (root path, deep path + query, userinfo + IPv4, IPv6)
  assert.equal(maskServiceTarget("https://mon.example.com/"), "https://m***.e***.com");
  assert.equal(maskServiceTarget("https://api.example.com:8443/v1/health?token=secret"), "https://a***.e***.com:8443/***");
  assert.equal(maskServiceTarget("http://admin:pass@198.51.100.42:8080/ping"), "http://***@198.*.*.42:8080/***");
  assert.equal(maskServiceTarget("https://[2001:db8::1]:8443/status"), "https://[2001:****:1]:8443/***");
  assert.equal(maskServiceTarget("https://[2001:db8::1]:443/status"), "https://[2001:****:1]/***");

  // Arbitrary fallback string should never leak raw secret
  const maskedRaw = maskServiceTarget("internal-secret-target");
  assert.ok(maskedRaw.includes("*") && !maskedRaw.includes("secret"));
});

test("shouldUseFullDetailHeight expands rich detail views and auto-fits compact ones", () => {
  assert.equal(shouldUseFullDetailHeight({ tab: "overview", loading: true }), true);
  assert.equal(shouldUseFullDetailHeight({ tab: "overview", hasResourceChart: true }), true);
  assert.equal(shouldUseFullDetailHeight({ tab: "overview", hasNetworkChart: true }), true);
  assert.equal(shouldUseFullDetailHeight({ tab: "overview", monitorCount: 1 }), true);
  assert.equal(shouldUseFullDetailHeight({ tab: "overview", loading: false, hasResourceChart: false, hasNetworkChart: false, monitorCount: 0 }), false);

  assert.equal(shouldUseFullDetailHeight({ tab: "network", loading: true }), true);
  assert.equal(shouldUseFullDetailHeight({ tab: "network", monitorCount: 3 }), true);
  assert.equal(shouldUseFullDetailHeight({ tab: "network", monitorCount: 12 }), true);
  assert.equal(shouldUseFullDetailHeight({ tab: "network", monitorCount: 2 }), false);
  assert.equal(shouldUseFullDetailHeight({ tab: "network", monitorCount: 0 }), false);

  assert.equal(shouldUseFullDetailHeight({ tab: "online", loading: true }), true);
  assert.equal(shouldUseFullDetailHeight({ tab: "online", dailyCount: 7 }), true);
  assert.equal(shouldUseFullDetailHeight({ tab: "online", dailyCount: 30 }), true);
  assert.equal(shouldUseFullDetailHeight({ tab: "online", dailyCount: 1 }), false);
});

test("computeCyclePace flags cycles burning significantly faster than elapsed time", () => {
  const from = "2026-11-01T00:00:00Z";
  const to = "2026-12-01T00:00:00Z";
  const day10 = Date.parse("2026-11-11T00:00:00Z"); // ~33.3% elapsed
  const day2 = Date.parse("2026-11-03T00:00:00Z"); // ~6.7% elapsed (<10% guard)

  const fast = computeCyclePace({ from, to, pct: 55, used: 550, max: 1000, remaining: 450 }, day10);
  assert.equal(fast.warning, true);
  assert.ok(Math.abs(fast.projectedPct - 165) < 0.2);
  assert.ok(fast.estExhaustMs > 0);

  const normal = computeCyclePace({ from, to, pct: 36, used: 360, max: 1000, remaining: 640 }, day10);
  assert.equal(normal.warning, false);

  const early = computeCyclePace({ from, to, pct: 40, used: 400, max: 1000, remaining: 600 }, day2);
  assert.equal(early, null, "cycles under 10% elapsed should not false-alarm");

  const alreadyFull = computeCyclePace({ from, to, pct: 100, used: 1000, max: 1000, remaining: 0 }, day10);
  assert.equal(alreadyFull.warning, false);

  const ended = computeCyclePace({ from, to, pct: 60, used: 600, max: 1000, remaining: 400 }, Date.parse("2026-12-02T00:00:00Z"));
  assert.equal(ended, null);
});

test("detectTrafficPaceAlerts triggers once below 80% and resets after recovery", () => {
  const from = "2026-11-01T00:00:00Z";
  const to = "2026-12-01T00:00:00Z";
  const day10 = Date.parse("2026-11-11T00:00:00Z");

  const step1 = detectTrafficPaceAlerts(new Set(), [
    { id: "1:1", serverName: "alpha", cycle: "monthly", from, to, pct: 55, used: 550, max: 1000, remaining: 450 },
    { id: "1:2", serverName: "beta", cycle: "monthly", from, to, pct: 85, used: 850, max: 1000, remaining: 150 },
  ], day10);
  assert.deepEqual(step1.triggered.map(x => x.id), ["1:1"], "skips >=80% already covered by threshold alerts");

  const step2 = detectTrafficPaceAlerts(step1.nextWarned, [
    { id: "1:1", serverName: "alpha", cycle: "monthly", from, to, pct: 60, used: 600, max: 1000, remaining: 400 },
  ], day10);
  assert.equal(step2.triggered.length, 0, "does not repeat while still warned");

  const step3 = detectTrafficPaceAlerts(step2.nextWarned, [
    { id: "1:1", serverName: "alpha", cycle: "monthly", from, to, pct: 35, used: 350, max: 1000, remaining: 650 },
  ], day10);
  assert.equal(step3.nextWarned.size, 0);

  const step4 = detectTrafficPaceAlerts(step3.nextWarned, [
    { id: "1:1", serverName: "alpha", cycle: "monthly", from, to, pct: 56, used: 560, max: 1000, remaining: 440 },
  ], day10);
  assert.deepEqual(step4.triggered.map(x => x.id), ["1:1"]);
});

test("buildBatchNotificationSummary formats concise zh and en summaries", () => {
  assert.equal(buildBatchNotificationSummary(["alpha", "beta"], "zh"), "alpha、beta");
  assert.equal(buildBatchNotificationSummary(["alpha", "beta", "gamma", "delta"], "zh"), "alpha、beta、gamma 等 4 项");
  assert.equal(buildBatchNotificationSummary(["alpha", "beta", "gamma", "delta"], "en"), "alpha, beta, gamma +1 more");
  assert.equal(buildBatchNotificationSummary([], "zh"), "");
});
