export function normalizeBaseURL(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  let u = s.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    const url = new URL(u);
    if (!url.hostname) return "";
    return url.origin;
  } catch {
    return "";
  }
}

export function unwrapNezha(body) {
  if (!body || typeof body !== "object") throw new Error("Invalid response");
  if (body.error || body.success === false) {
    throw new Error(String(body.error || "Request failed"));
  }
  return body.data;
}

export function isServerOnline(server, nowMs = Date.now(), windowMs = 30000) {
  if (!server) return false;
  if (typeof server.online === "boolean") return server.online;
  const la = server.last_active;
  if (!la) return false;
  const t = Date.parse(la);
  if (!Number.isFinite(t)) return false;
  return nowMs - t < windowMs;
}

export function mergeServerFrame(prevMap, frame) {
  const next = new Map(prevMap);
  const list = Array.isArray(frame?.servers) ? frame.servers : [];
  const onlineArr = Array.isArray(frame?.online) ? new Set(frame.online) : null;
  for (const s of list) {
    if (!s || s.id == null) continue;
    const id = String(s.id);
    const prev = next.get(id) || {};
    const merged = { ...prev, ...s };
    if (s.public_note === undefined && prev.public_note !== undefined) {
      merged.public_note = prev.public_note;
    }
    if (onlineArr) merged.online = onlineArr.has(s.id) || onlineArr.has(Number(s.id)) || onlineArr.has(id);
    next.set(id, merged);
  }
  return next;
}

export function mergeServerList(prevMap, list) {
  const next = new Map();
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || s.id == null) continue;
    const id = String(s.id);
    const prev = prevMap.get(id) || {};
    const merged = { ...prev, ...s };
    if (s.public_note === undefined && prev.public_note !== undefined) {
      merged.public_note = prev.public_note;
    }
    if (s.online === undefined) delete merged.online;
    next.set(id, merged);
  }
  return next;
}

export function buildGroupIndex(groupPayload) {
  const byServer = new Map();
  const groups = [];
  const arr = Array.isArray(groupPayload) ? groupPayload : [];
  for (const item of arr) {
    const g = item?.group || item;
    if (!g || g.id == null) continue;
    const id = String(g.id);
    const name = g.name || id;
    const servers = Array.isArray(item.servers) ? item.servers.map(String) : [];
    groups.push({ id, name, servers });
    for (const sid of servers) {
      const key = String(sid);
      const memberships = byServer.get(key) || [];
      if (!memberships.some(group => group.id === id)) memberships.push({ id, name });
      byServer.set(key, memberships);
    }
  }
  groups.sort((a, b) => a.name.localeCompare(b.name));
  return { groups, byServer };
}

export function resolveGroupSelection(selectedGroup, groups) {
  if (!selectedGroup || selectedGroup === "all") return "all";
  const list = Array.isArray(groups) ? groups : [];
  return list.some(g => String(g.id) === String(selectedGroup)) ? String(selectedGroup) : "all";
}

export function scopedServers({
  servers,
  groupId = "all",
  watchMode = "all",
  watchlist = new Set(),
  byServerGroup = new Map(),
}) {
  let list = Array.from(servers.values());
  if (groupId && groupId !== "all") {
    list = list.filter(s => {
      const memberships = byServerGroup.get(String(s.id)) || [];
      return memberships.some(g => String(g.id) === String(groupId));
    });
  }
  if (watchMode === "starred" && watchlist && watchlist.size > 0) {
    list = list.filter(s => watchlist.has(String(s.id)));
  }
  return list;
}

export function summarizeScoped(list, nowMs = Date.now()) {
  let online = 0;
  let netDown = 0;
  let netUp = 0;
  let transferDown = 0;
  let transferUp = 0;
  let cpuSum = 0;
  let cpuN = 0;
  for (const s of list) {
    const on = isServerOnline(s, nowMs);
    const st = s.state || {};
    if (on) {
      online += 1;
      netDown += Number(st.net_in_speed) || 0;
      netUp += Number(st.net_out_speed) || 0;
    }
    transferDown += Number(st.net_in_transfer) || 0;
    transferUp += Number(st.net_out_transfer) || 0;
    if (on && Number.isFinite(Number(st.cpu))) {
      cpuSum += Number(st.cpu);
      cpuN += 1;
    }
  }
  return {
    online,
    total: list.length,
    offline: Math.max(0, list.length - online),
    netDown,
    netUp,
    transferDown,
    transferUp,
    avgCpu: cpuN ? cpuSum / cpuN : 0,
  };
}

export function formatRate(bytesPerSec, compact = false) {
  const n = Number(bytesPerSec) || 0;
  const abs = Math.abs(n);
  const units = ["B/s", "K/s", "M/s", "G/s", "T/s"];
  let v = abs;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const digits = compact ? (v >= 100 ? 0 : v >= 10 ? 1 : 2) : v >= 100 ? 0 : 1;
  return `${v.toFixed(digits)}${units[i]}`;
}

export function formatBytes(bytes, digits = 1, compact = false) {
  const n = Number(bytes) || 0;
  const abs = Math.abs(n);
  const units = compact ? ["B", "K", "M", "G", "T"] : ["B", "KB", "MB", "GB", "TB"];
  let v = abs;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const d = compact ? (v >= 100 ? 0 : v >= 10 ? 1 : 2) : digits;
  let text = v.toFixed(d);
  if (compact && d > 0) text = text.replace(/\.?0+$/, "");
  return compact ? `${text}${units[i]}` : `${text} ${units[i]}`;
}

export function pct(used, total) {
  const t = Number(total) || 0;
  if (t <= 0) return 0;
  return Math.max(0, Math.min(100, ((Number(used) || 0) / t) * 100));
}

export function serviceTypeLabel(type) {
  const t = Number(type);
  if (t === 1) return "HTTP";
  if (t === 2) return "Ping";
  if (t === 3) return "TCP";
  return "Other";
}

export function mergeServiceRows(listPayload, overviewPayload) {
  const list = Array.isArray(listPayload) ? listPayload : [];
  const overview =
    overviewPayload && typeof overviewPayload === "object"
      ? overviewPayload.services || overviewPayload
      : {};
  return list
    .map(item => {
      const ov = overview[String(item.id)] || overview[item.id] || {};
      const up = Number(ov.current_up) || 0;
      const down = Number(ov.current_down) || 0;
      const total = up + down;
      const delayArr = Array.isArray(ov.delay) ? ov.delay : [];
      const lastDelay = delayArr.length ? Number(delayArr[delayArr.length - 1]) : NaN;
      const upPercent = total > 0 ? (up / total) * 100 : 100;
      return {
        id: item.id,
        name: item.name || ov.service_name || String(item.id),
        display_index: item.display_index,
        type: item.type,
        typeLabel: serviceTypeLabel(item.type),
        target: item.target || "",
        currentUp: up,
        currentDown: down,
        upPercent,
        delay: Number.isFinite(lastDelay) ? lastDelay : null,
        failing: down > 0 && up === 0,
      };
    })
    .sort((a, b) => Number(a.display_index || 0) - Number(b.display_index || 0) || String(a.name).localeCompare(String(b.name)));
}

export function buildAttention({ servers = [], services = [], alertRules = [], cycleTransfers = [], nowMs = Date.now() }) {
  const items = [];
  for (const s of servers) {
    if (!isServerOnline(s, nowMs)) {
      items.push({ kind: "offline", id: `srv-${s.id}`, serverId: String(s.id), title: s.name || String(s.id), meta: s.last_active || "" });
    }
  }
  for (const svc of services) {
    if (svc.failing || (svc.currentDown > 0 && svc.currentUp === 0)) {
      items.push({
        kind: "probe",
        id: `svc-${svc.id}`,
        serviceId: String(svc.id),
        title: svc.name,
        meta: `${svc.typeLabel} · down`,
      });
    }
  }
  for (const c of cycleTransfers) {
    if (c.pct < 80) continue;
    items.push({
      kind: "traffic",
      id: `traffic-${c.id}`,
      serverId: String(c.serverId),
      title: c.serverName,
      meta: `${c.cycle} · ${c.pct.toFixed(1)}% · ${formatBytes(c.remaining, 1, true)} left`,
      severity: c.pct >= 95 ? "critical" : "warning",
    });
  }
  const rules = Array.isArray(alertRules) ? alertRules : [];
  return { items, rules };
}

export function detectTrafficThresholds(previousLevels, cycleTransfers) {
  const nextLevels = new Map();
  const crossed = [];
  for (const c of Array.isArray(cycleTransfers) ? cycleTransfers : []) {
    const level = c.pct >= 95 ? 2 : c.pct >= 80 ? 1 : 0;
    const previous = Number(previousLevels.get(c.id)) || 0;
    nextLevels.set(c.id, level);
    if (level > previous) crossed.push({ ...c, level });
  }
  return { nextLevels, crossed };
}

export function filterServers(list, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return list;
  return list.filter(s => `${s.name || s.id || ""}\n${s.public_note || ""}`.toLowerCase().includes(q));
}

export function trayTitle(format, summary) {
  const on = `${summary.online}/${summary.total}`;
  const total = formatRate(summary.netDown + summary.netUp, true);
  const down = formatRate(summary.netDown, true);
  const up = formatRate(summary.netUp, true);
  switch (format) {
    case "total":
      return total;
    case "online":
      return on;
    case "online_both":
      return `${on} · ↑${up} ↓${down}`;
    case "online_total":
    default:
      return `${on} · ${total}`;
  }
}

export function buildCycleTransfers(payload) {
  const stats = (payload && payload.cycle_transfer_stats) || {};
  const out = [];
  for (const [cycleId, item] of Object.entries(stats)) {
    if (!item || typeof item !== "object") continue;
    const max = Number(item.max) || 0;
    if (max <= 0) continue;
    const names = item.server_name || {};
    const transfer = item.transfer || {};
    const nextUpdate = item.next_update || {};
    for (const serverId of Object.keys(names)) {
      const used = Number(transfer[serverId]) || 0;
      out.push({
        id: `${cycleId}:${serverId}`,
        cycle: String(item.name || cycleId),
        serverId: String(serverId),
        serverName: String(names[serverId] || serverId),
        from: String(item.from || ""),
        to: String(item.to || ""),
        nextUpdate: String(nextUpdate[serverId] || ""),
        max,
        used,
        remaining: Math.max(0, max - used),
        pct: Math.max(0, Math.min(100, (used / max) * 100)),
      });
    }
  }
  out.sort((a, b) => b.pct - a.pct || a.serverName.localeCompare(b.serverName));
  return out;
}

export function formatMonthDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

export function formatMonthDayTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = n => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }
  return `${h}h ${m}m`;
}

export function buildMonitorRows(monitors) {
  const list = Array.isArray(monitors) ? monitors : [];
  const out = [];
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    const ts = Array.isArray(m.created_at) ? m.created_at : [];
    const delays = Array.isArray(m.avg_delay) ? m.avg_delay : [];
    const total = delays.length;
    let up = 0;
    let lastDelay = null;
    const points = [];
    for (let i = 0; i < delays.length; i++) {
      const v = delays[i];
      if (v == null || !Number.isFinite(Number(v))) continue;
      up += 1;
      lastDelay = Number(v);
      if (i < ts.length) points.push({ ts: Number(ts[i]), value: Number(v) });
    }
    const down = Math.max(0, total - up);
    out.push({
      id: String(m.monitor_id ?? m.id ?? m.monitor_name ?? ""),
      name: String(m.monitor_name || m.monitor_id || "?"),
      displayIndex: Number(m.display_index) || 0,
      total,
      up,
      down,
      lossPct: total > 0 ? (down / total) * 100 : 0,
      delay: lastDelay,
      points,
    });
  }
  out.sort((a, b) => (a.delay ?? Infinity) - (b.delay ?? Infinity) || a.name.localeCompare(b.name));
  return out;
}

export function buildOnlineSummary(online, windowSeconds) {
  const o = online && typeof online === "object" ? online : {};
  const onlineSeconds = Number(o.total_online_seconds) || 0;
  const win = Number(windowSeconds) > 0 ? Number(windowSeconds) : Math.max(1, onlineSeconds);
  const rate = Number(o.online_rate);
  return {
    currentlyOnline: !!o.currently_online,
    lastActive: String(o.last_active || ""),
    windowStart: String(o.window_start || ""),
    windowEnd: String(o.window_end || ""),
    onlineSeconds,
    offlineSeconds: Math.max(0, win - onlineSeconds),
    ratePct: Number.isFinite(rate) ? rate : (onlineSeconds / win) * 100,
    daily: Array.isArray(o.daily)
      ? o.daily.map(d => ({ date: String(d.date || ""), onlineSeconds: Number(d.online_seconds) || 0 }))
      : [],
  };
}

export function buildDailyOnlineRows(daily, nowMs = Date.now(), window = null) {
  const list = Array.isArray(daily) ? daily : [];
  const now = new Date(nowMs);
  const pad = n => String(n).padStart(2, "0");
  const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const winStart = window && window.start ? new Date(window.start).getTime() : NaN;
  const winEnd = window && window.end ? new Date(window.end).getTime() : NaN;
  return list.map(d => {
    const onlineSeconds = Math.max(0, Number(d.onlineSeconds ?? d.online_seconds) || 0);
    const parts = String(d.date || "").split("-").map(Number);
    let expected = 86400;
    if (parts.length === 3 && parts.every(Number.isFinite)) {
      const dayStart = new Date(parts[0], parts[1] - 1, parts[2]).getTime();
      const dayEnd = dayStart + 86400 * 1000;
      const from = Number.isFinite(winStart) ? Math.max(dayStart, winStart) : dayStart;
      const to = Math.min(Number.isFinite(winEnd) ? winEnd : dayEnd, dayEnd, nowMs);
      expected = Math.max(1, Math.round((to - from) / 1000));
    }
    const pct = Math.max(0, Math.min(100, (onlineSeconds / expected) * 100));
    const color = pct >= 99 ? "success" : pct >= 95 ? "warning" : "danger";
    return { date: String(d.date || ""), onlineSeconds, expected, pct, color, isToday: d.date === todayKey };
  });
}

export function formatDailyDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

export function detectTransitions(prevOnlineIds, nextOnlineIds) {
  const wentOffline = [];
  for (const id of prevOnlineIds) {
    if (!nextOnlineIds.has(id)) wentOffline.push(id);
  }
  return { wentOffline };
}


export function resourceColor(value) {
  const n = Number(value) || 0;
  if (n >= 90) return "danger";
  if (n >= 80) return "warning";
  return "accent";
}

export function formatRelativeTime(iso, nowMs = Date.now(), locale = "zh") {
  if (!iso) return "";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const seconds = Math.max(0, Math.floor((nowMs - time) / 1000));
  const zh = locale === "zh";
  if (seconds < 60) return zh ? "刚刚" : "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return zh ? `${days} 天前` : `${days}d ago`;
}


export function resolveWidgetServer(servers, selector) {
  const list = Array.from((servers && typeof servers.values === "function" ? servers.values() : servers) || []);
  const query = String(selector || "").trim();
  if (!query) return { status: "empty" };
  const byId = list.find(server => String(server && server.id) === query);
  if (byId) return { status: "ok", server: byId };
  const normalized = query.toLowerCase();
  const matches = list.filter(server => String(server && server.name || "").toLowerCase() === normalized);
  if (matches.length === 1) return { status: "ok", server: matches[0] };
  return { status: matches.length > 1 ? "ambiguous" : "missing" };
}
