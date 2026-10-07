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
  if (res.status === 403) {
    location.href = "/app.html";
    throw new Error("Admin access required.");
  }
  if (!res.ok) throw new Error(data.error || "Request failed.");
  return data;
}

document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.getAttribute("data-tab");
    document.querySelectorAll(".tab-panel").forEach((p) => {
      p.hidden = p.id !== "panel-" + tab;
    });
    if (tab === "acks") loadAcks();
    if (tab === "reservations") loadReservations();
  });
});

async function loadReservations() {
  const date = $("filter-date").value;
  const q = date ? "?date=" + encodeURIComponent(date) : "";
  const data = await api("/api/admin/reservations" + q);
  const body = $("res-body");
  if (!data.reservations.length) {
    body.innerHTML = `<tr><td colspan="4">No reservations.</td></tr>`;
    return;
  }
  body.innerHTML = data.reservations
    .map((r) => {
      const canRelease = r.status === "booked" || r.status === "admin_override";
      return `<tr>
        <td>${r.date} ${r.startHm}–${r.endHm}<br><span class="sub">${r.weekday}${r.releasable ? " · grace elapsed" : ""}</span></td>
        <td>${r.email}<br>Spot ${r.spot}</td>
        <td><span class="badge ${r.status}">${r.status.replace(/_/g, " ")}</span></td>
        <td>${canRelease ? `<button class="btn btn-danger" data-release="${r.id}">Release</button>` : "—"}</td>
      </tr>`;
    })
    .join("");
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadAcks() {
  const data = await api("/api/admin/policy-acks");
  const body = $("ack-body");
  if (!data.acks.length) {
    body.innerHTML = `<tr><td colspan="5">No acknowledgments yet.</td></tr>`;
    return;
  }
  body.innerHTML = data.acks
    .map((a) => {
      const name = a.printedName ? esc(a.printedName) : "<em>missing</em>";
      const sig =
        a.signatureDataUrl && String(a.signatureDataUrl).startsWith("data:image/")
          ? `<img class="sig-preview" src="${esc(a.signatureDataUrl)}" alt="Signature">`
          : "<em>missing</em>";
      return `<tr><td>${esc(a.email)}</td><td>${name}</td><td>${sig}</td><td>${esc(a.acknowledgedAt)}</td><td>${esc(a.policyVersion)}</td></tr>`;
    })
    .join("");
}

$("btn-reload").addEventListener("click", () => {
  loadReservations().catch((e) => showMsg($("admin-msg"), e.message, "error"));
});

document.addEventListener("click", async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const id = t.getAttribute("data-release");
  if (!id) return;
  if (!confirm("Release this stall? (Counts as company cancel — does not consume charging day.)")) return;
  try {
    await api("/api/admin/reservations/" + id + "/release", { method: "POST", body: "{}" });
    showMsg($("admin-msg"), "Released.", "ok");
    await loadReservations();
  } catch (err) {
    showMsg($("admin-msg"), err.message, "error");
  }
});

$("override-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/admin/override", {
      method: "POST",
      body: JSON.stringify({
        email: $("ov-email").value.trim(),
        date: $("ov-date").value,
        start: $("ov-start").value,
        end: $("ov-end").value,
        notes: $("ov-notes").value,
      }),
    });
    showMsg($("ov-msg"), "Override created.", "ok");
  } catch (err) {
    showMsg($("ov-msg"), err.message, "error");
  }
});

$("btn-load-flags").addEventListener("click", async () => {
  try {
    const email = $("fl-email").value.trim();
    const data = await api("/api/admin/flags?email=" + encodeURIComponent(email));
    const f = data.flags || {};
    $("fl-contractor").checked = !!f.contractorException;
    $("fl-hours").checked = !!f.hoursException;
    $("fl-cadence").checked = !!f.cadenceException;
    $("fl-notes").value = f.notes || "";
    showMsg($("fl-msg"), f.email ? "Loaded." : "No flags yet — set and save.", "info");
  } catch (err) {
    showMsg($("fl-msg"), err.message, "error");
  }
});

$("flags-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/admin/flags", {
      method: "POST",
      body: JSON.stringify({
        email: $("fl-email").value.trim(),
        contractorException: $("fl-contractor").checked,
        hoursException: $("fl-hours").checked,
        cadenceException: $("fl-cadence").checked,
        notes: $("fl-notes").value,
      }),
    });
    showMsg($("fl-msg"), "Flags saved.", "ok");
  } catch (err) {
    showMsg($("fl-msg"), err.message, "error");
  }
});

async function boot() {
  const me = await api("/api/me");
  if (!me.admin) {
    location.href = "/app.html";
    return;
  }
  $("who").textContent = me.email;
  await loadReservations();
}

boot().catch(() => {
  location.href = "/";
});
