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
    for (const sid of servers) byServer.set(String(sid), { id, name });
  }
  groups.sort((a, b) => a.name.localeCompare(b.name));
  return { groups, byServer };
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
      const g = byServerGroup.get(String(s.id));
      return g && String(g.id) === String(groupId);
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
  let cpuSum = 0;
  let cpuN = 0;
  for (const s of list) {
    const on = isServerOnline(s, nowMs);
    if (on) online += 1;
    const st = s.state || {};
    netDown += Number(st.net_in_speed) || 0;
    netUp += Number(st.net_out_speed) || 0;
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

export function formatBytes(bytes, digits = 1) {
  const n = Number(bytes) || 0;
  const abs = Math.abs(n);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = abs;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(digits)} ${units[i]}`;
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

export function buildAttention({ servers, services, alertRules, nowMs = Date.now() }) {
  const items = [];
  for (const s of servers) {
    if (!isServerOnline(s, nowMs)) {
      items.push({ kind: "offline", id: `srv-${s.id}`, title: s.name || String(s.id), meta: s.last_active || "" });
    }
  }
  for (const svc of services) {
    if (svc.failing || (svc.currentDown > 0 && svc.currentUp === 0)) {
      items.push({
        kind: "probe",
        id: `svc-${svc.id}`,
        title: svc.name,
        meta: `${svc.typeLabel} · down`,
      });
    }
  }
  const rules = Array.isArray(alertRules) ? alertRules : [];
  return { items, rules };
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

export function detectTransitions(prevOnlineIds, nextOnlineIds) {
  const wentOffline = [];
  for (const id of prevOnlineIds) {
    if (!nextOnlineIds.has(id)) wentOffline.push(id);
  }
  return { wentOffline };
}
