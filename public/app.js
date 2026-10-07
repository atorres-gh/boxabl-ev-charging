const $ = (id) => document.getElementById(id);

function showMsg(el, text, kind) {
  el.textContent = text || "";
  el.className = "msg" + (text ? " show " + (kind || "") : "");
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    location.href = "/";
    throw new Error("Sign in required.");
  }
  if (!res.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function badge(status) {
  return `<span class="badge ${status}">${status.replace(/_/g, " ")}</span>`;
}

function whoLabel(r) {
  const name = (r.displayName || "").trim();
  if (name && r.unknownPerson) return `${escText(name)} (unknown)`;
  if (name) return escText(name);
  return escText(r.email);
}

function escText(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderItem(r, { mine } = {}) {
  const actions = [];
  if (mine && (r.status === "booked" || r.status === "admin_override")) {
    actions.push(`<button class="btn btn-ghost" data-done="${r.id}">I'm done</button>`);
    actions.push(`<button class="btn btn-danger" data-cancel="${r.id}">Cancel</button>`);
  }
  if (r.releasable) actions.push(`<span class="badge releasable">Grace elapsed — releasable</span>`);
  if (r.needsPolicyAck) actions.push(`<span class="badge needs-sig">Needs policy signature</span>`);
  if (r.source === "outlook") actions.push(`<span class="badge outlook">From Outlook</span>`);
  return `<div class="item">
    <div>
      <div class="title">${r.date} (${r.weekday}) · ${r.startHm}–${r.endHm}</div>
      <div class="sub">${whoLabel(r)} · Spot ${r.spot} · ${escText(r.station)} ${badge(r.status)}</div>
    </div>
    <div class="actions">${actions.join("")}</div>
  </div>`;
}

let config = null;
let me = null;
let sigPad = null;

function initSignaturePad() {
  const canvas = $("sig-canvas");
  if (!canvas) return null;
  const ctx = canvas.getContext("2d");
  const state = { drawing: false, dirty: false };

  function resize() {
    const wrap = canvas.parentElement;
    const cssW = Math.max(280, wrap.clientWidth || 560);
    const cssH = 160;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(cssW * ratio);
    canvas.height = Math.floor(cssH * ratio);
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    clear();
  }

  function clear() {
    const cssW = canvas.clientWidth || 560;
    const cssH = canvas.clientHeight || 160;
    ctx.fillStyle = "#faf8f3";
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.strokeStyle = "#0b1d36";
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    state.dirty = false;
  }

  function pos(e) {
    const rect = canvas.getBoundingClientRect();
    const src = e.touches && e.touches[0] ? e.touches[0] : e;
    return { x: src.clientX - rect.left, y: src.clientY - rect.top };
  }

  function start(e) {
    e.preventDefault();
    state.drawing = true;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }

  function move(e) {
    if (!state.drawing) return;
    e.preventDefault();
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    state.dirty = true;
  }

  function end(e) {
    if (!state.drawing) return;
    e.preventDefault();
    state.drawing = false;
  }

  canvas.addEventListener("mousedown", start);
  canvas.addEventListener("mousemove", move);
  canvas.addEventListener("mouseup", end);
  canvas.addEventListener("mouseleave", end);
  canvas.addEventListener("touchstart", start, { passive: false });
  canvas.addEventListener("touchmove", move, { passive: false });
  canvas.addEventListener("touchend", end);
  canvas.addEventListener("touchcancel", end);

  resize();
  window.addEventListener("resize", () => {
    const wasDirty = state.dirty;
    const snapshot = wasDirty ? canvas.toDataURL("image/png") : null;
    resize();
    if (snapshot) {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.clientWidth, canvas.clientHeight);
        state.dirty = true;
      };
      img.src = snapshot;
    }
  });

  return {
    clear,
    isDirty: () => state.dirty,
    toDataUrl: () => (state.dirty ? canvas.toDataURL("image/png") : ""),
  };
}

function collectAckPayload() {
  const wrap = $("ack-wrap");
  if (wrap.hidden) return {};
  const printedName = ($("printed-name").value || "").trim();
  const signatureDataUrl = sigPad ? sigPad.toDataUrl() : "";
  return {
    acknowledged: $("ack").checked,
    printedName,
    signatureDataUrl,
  };
}

async function boot() {
  me = await api("/api/me");
  config = await api("/api/config");
  $("who").textContent = me.email;
  $("station-title").textContent = config.station;
  if (me.admin) $("admin-link").hidden = false;
  const flag = $("policy-flag");
  if (me.needsPolicyAck || !me.policyAck) {
    flag.hidden = false;
    flag.textContent = me.policyAck
      ? "You have an Outlook charging booking on file but still need to sign the policy here (printed name + signature)."
      : "Please sign the EV charging policy below (printed name + signature) before or with your first reservation. Outlook bookings alone do not count as signed.";
    $("ack-wrap").hidden = false;
    sigPad = initSignaturePad();
  } else {
    flag.hidden = true;
  }

  const sel = $("date");
  sel.innerHTML = "";
  for (const d of config.bookableDates || []) {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d;
    sel.appendChild(opt);
  }
  if (!sel.options.length) {
    const opt = document.createElement("option");
    opt.value = config.today;
    opt.textContent = config.today;
    sel.appendChild(opt);
  }

  $("spot-info").value = `Auto-assign (${config.spotCount} spot${config.spotCount === 1 ? "" : "s"})`;
  await refresh();
}

async function refresh() {
  const date = $("date").value || config.today;
  const [day, mine] = await Promise.all([
    api("/api/day?date=" + encodeURIComponent(date)),
    api("/api/reservations"),
  ]);
  const board = $("day-board");
  if (!day.reservations.length) {
    board.innerHTML = `<p class="empty">No active reservations on ${date}.</p>`;
  } else {
    board.innerHTML = day.reservations.map((r) => renderItem(r)).join("");
  }
  const mineEl = $("mine");
  if (!mine.reservations.length) {
    mineEl.innerHTML = `<p class="empty">You have no reservations yet.</p>`;
  } else {
    mineEl.innerHTML = mine.reservations.map((r) => renderItem(r, { mine: true })).join("");
  }
}

$("btn-check").addEventListener("click", async () => {
  const msg = $("reserve-msg");
  try {
    const q = new URLSearchParams({
      date: $("date").value,
      start: $("start").value,
      end: $("end").value,
    });
    const data = await api("/api/eligibility?" + q.toString());
    const e = data.eligibility;
    if (e.ok) {
      let hint = `Eligible on ${e.date} (${e.weekday}). Window ${e.openHm}–${e.closeHm}, max ${e.maxHours}h.`;
      if (e.lastChargingDay) {
        hint += ` Last charging day: ${e.lastChargingDay}. Next after that: ${e.nextEligibleAfterLast}.`;
      }
      showMsg(msg, hint, "ok");
    } else {
      showMsg(msg, e.errors.join(" "), "error");
    }
  } catch (err) {
    showMsg(msg, err.message, "error");
  }
});

$("btn-sig-clear").addEventListener("click", () => {
  if (sigPad) sigPad.clear();
});

$("reserve-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("reserve-msg");
  const ack = collectAckPayload();
  if (!$("ack-wrap").hidden) {
    if (!ack.acknowledged) {
      showMsg(msg, "Check the box to acknowledge the charging policy.", "error");
      return;
    }
    if (!ack.printedName) {
      showMsg(msg, "Enter your printed name.", "error");
      return;
    }
    if (!ack.signatureDataUrl) {
      showMsg(msg, "Draw your signature in the box.", "error");
      return;
    }
  }
  $("btn-reserve").disabled = true;
  try {
    const body = {
      date: $("date").value,
      start: $("start").value,
      end: $("end").value,
      ...ack,
    };
    await api("/api/reservations", { method: "POST", body: JSON.stringify(body) });
    showMsg(msg, "Reserved. Unplug and move when your session ends.", "ok");
    $("ack-wrap").hidden = true;
    const flag = $("policy-flag");
    if (flag) flag.hidden = true;
    me = await api("/api/me");
    await refresh();
  } catch (err) {
    showMsg(msg, err.message, "error");
  } finally {
    $("btn-reserve").disabled = false;
  }
});

$("date").addEventListener("change", () => refresh().catch(() => {}));

document.addEventListener("click", async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const cancelId = t.getAttribute("data-cancel");
  const doneId = t.getAttribute("data-done");
  try {
    if (cancelId) {
      if (!confirm("Cancel this reservation and free the stall?")) return;
      await api("/api/reservations/" + cancelId + "/cancel", { method: "POST", body: "{}" });
      await refresh();
    }
    if (doneId) {
      if (!confirm("Mark session done and free the stall now?")) return;
      await api("/api/reservations/" + doneId + "/done", { method: "POST", body: "{}" });
      await refresh();
    }
  } catch (err) {
    alert(err.message);
  }
});

boot().catch((err) => {
  console.error(err);
  location.href = "/";
});
