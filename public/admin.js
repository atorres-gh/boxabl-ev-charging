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
    if (tab === "admins") loadAdmins();
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
  showMsg($("ack-msg"), "");
  if (!data.acks.length) {
    body.innerHTML = `<tr><td colspan="6">No acknowledgments yet.</td></tr>`;
    return;
  }
  body.innerHTML = data.acks
    .map((a) => {
      const name = a.printedName ? esc(a.printedName) : "<em>missing</em>";
      const complete =
        a.printedName &&
        a.signatureDataUrl &&
        String(a.signatureDataUrl).startsWith("data:image/");
      const sig = complete
        ? `<img class="sig-preview" src="${esc(a.signatureDataUrl)}" alt="Signature">`
        : "<em>missing</em>";
      const download = complete
        ? `<button type="button" class="btn btn-ghost" data-download-pdf="${esc(a.email)}">Download signed PDF</button>`
        : "—";
      return `<tr><td>${esc(a.email)}</td><td>${name}</td><td>${sig}</td><td>${esc(a.acknowledgedAt)}</td><td>${esc(a.policyVersion)}</td><td>${download}</td></tr>`;
    })
    .join("");
}

$("btn-reload").addEventListener("click", () => {
  loadReservations().catch((e) => showMsg($("admin-msg"), e.message, "error"));
});

document.addEventListener("click", async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;

  const downloadEmail = t.getAttribute("data-download-pdf");
  if (downloadEmail) {
    t.disabled = true;
    try {
      const res = await fetch(
        "/api/admin/policy-acks/" + encodeURIComponent(downloadEmail) + "/signed-pdf",
        { credentials: "same-origin" }
      );
      if (res.status === 401) {
        location.href = "/";
        return;
      }
      if (res.status === 403) {
        location.href = "/app.html";
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Download failed.");
      }
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") || "";
      const m = /filename="([^"]+)"/.exec(cd);
      const filename = m ? m[1] : "signed-policy.pdf";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
      showMsg($("ack-msg"), "Downloaded " + filename, "ok");
    } catch (err) {
      showMsg($("ack-msg"), err.message, "error");
    } finally {
      t.disabled = false;
    }
    return;
  }

  const removeAdmin = t.getAttribute("data-remove-admin");
  if (removeAdmin) {
    if (!confirm("Remove admin access for " + removeAdmin + "?")) return;
    t.disabled = true;
    try {
      await api("/api/admin/admins/remove", {
        method: "POST",
        body: JSON.stringify({ email: removeAdmin }),
      });
      showMsg($("ad-msg"), "Removed.", "ok");
      await loadAdmins();
    } catch (err) {
      showMsg($("ad-msg"), err.message, "error");
    } finally {
      t.disabled = false;
    }
    return;
  }

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


async function loadAdmins() {
  const data = await api("/api/admin/admins");
  const body = $("admins-body");
  showMsg($("ad-msg"), "");
  const seedSet = new Set(data.seed || []);
  const rows = (data.all || []).map((email) => {
    const builtIn = seedSet.has(email);
    const type = builtIn ? "Built-in" : "Added";
    const action = builtIn
      ? `<span class="sub">Can't remove here</span>`
      : `<button type="button" class="btn btn-danger" data-remove-admin="${esc(email)}">Remove</button>`;
    return `<tr><td>${esc(email)}</td><td>${type}</td><td>${action}</td></tr>`;
  });
  body.innerHTML = rows.length
    ? rows.join("")
    : `<tr><td colspan="3">No admins configured.</td></tr>`;
}

$("admins-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/admin/admins", {
      method: "POST",
      body: JSON.stringify({ email: $("ad-email").value.trim() }),
    });
    $("ad-email").value = "";
    showMsg($("ad-msg"), "Admin added.", "ok");
    await loadAdmins();
  } catch (err) {
    showMsg($("ad-msg"), err.message, "error");
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
