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
      const who = r.displayName
        ? `${esc(r.displayName)}${r.unknownPerson ? " <em>(unknown)</em>" : ""}<br><span class="sub">${esc(r.email)}</span>`
        : esc(r.email);
      const flags = [];
      if (r.needsPolicyAck) flags.push('<span class="badge needs-sig">Needs policy signature</span>');
      if (r.source === "outlook") flags.push('<span class="badge outlook">From Outlook</span>');
      if (r.unknownPerson) flags.push('<span class="badge needs-sig">Unsigned / unknown</span>');
      const actions = [];
      if (canRelease) actions.push(`<button class="btn btn-danger" data-release="${r.id}">Release</button>`);
      if (r.needsPolicyAck && !r.unknownPerson && r.email && !String(r.email).includes("@imported.local")) {
        actions.push(
          `<button type="button" class="btn btn-ghost" data-external-ack="${esc(r.email)}" data-external-name="${esc(r.displayName || "")}">Mark signed externally</button>`
        );
      }
      return `<tr>
        <td>${r.date} ${r.startHm}–${r.endHm}<br><span class="sub">${r.weekday}${r.releasable ? " · grace elapsed" : ""}</span></td>
        <td>${who}<br>Spot ${r.spot}</td>
        <td><span class="badge ${r.status}">${r.status.replace(/_/g, " ")}</span> ${flags.join(" ")}</td>
        <td>${actions.length ? actions.join(" ") : "—"}</td>
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
    body.innerHTML = `<tr><td colspan="7">No acknowledgments yet.</td></tr>`;
    return;
  }
  body.innerHTML = data.acks
    .map((a) => {
      const name = a.printedName ? esc(a.printedName) : "<em>missing</em>";
      const external = a.source === "admin_external";
      const inAppSig =
        !external &&
        a.signatureDataUrl &&
        String(a.signatureDataUrl).startsWith("data:image/");
      let sig;
      if (external) {
        const note = a.externalNote
          ? `<br><span class="sub">${esc(a.externalNote)}</span>`
          : "";
        const by = a.overriddenBy
          ? `<br><span class="sub">Recorded by ${esc(a.overriddenBy)}</span>`
          : "";
        sig = `<span class="badge external">External / admin override</span>${note}${by}`;
      } else if (inAppSig) {
        sig = `<img class="sig-preview" src="${esc(a.signatureDataUrl)}" alt="Signature">`;
      } else {
        sig = "<em>missing</em>";
      }
      const download = inAppSig
        ? `<button type="button" class="btn btn-ghost" data-download-pdf="${esc(a.email)}">Download signed PDF</button>`
        : external
          ? `<span class="sub">External copy</span>`
          : "—";
      const revoke = `<button type="button" class="btn btn-danger" data-revoke-ack="${esc(a.email)}">Revoke</button>`;
      return `<tr><td>${esc(a.email)}</td><td>${name}</td><td>${sig}</td><td>${esc(a.acknowledgedAt)}</td><td>${esc(a.policyVersion)}</td><td>${download}</td><td>${revoke}</td></tr>`;
    })
    .join("");
}

$("btn-reload").addEventListener("click", () => {
  loadReservations().catch((e) => showMsg($("admin-msg"), e.message, "error"));
});

$("btn-outlook-sync").addEventListener("click", async () => {
  showMsg($("admin-msg"), "Pulling from Outlook…", "info");
  try {
    const data = await api("/api/admin/outlook-sync", { method: "POST", body: "{}" });
    showMsg(
      $("admin-msg"),
      `Outlook pull (${data.sync}): imported ${data.imported}, updated ${data.updated}, cancelled ${data.cancelled}, flagged ${data.flagged}.`,
      "ok"
    );
    await loadReservations();
  } catch (e) {
    showMsg($("admin-msg"), e.message, "error");
  }
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

  const revokeEmail = t.getAttribute("data-revoke-ack");
  if (revokeEmail) {
    if (
      !confirm(
        "Revoke the signed policy for " +
          revokeEmail +
          "?\n\nThey will need to sign again (or get an external override) before reserving."
      )
    ) {
      return;
    }
    const note = prompt("Optional note (why revoked — e.g. new policy version):", "") || "";
    t.disabled = true;
    try {
      await api("/api/admin/policy-acks/revoke", {
        method: "POST",
        body: JSON.stringify({ email: revokeEmail, note: note.trim() }),
      });
      showMsg($("ack-msg"), "Revoked. They must re-sign before reserving.", "ok");
      await loadAcks();
      await loadReservations().catch(() => {});
    } catch (err) {
      showMsg($("ack-msg"), err.message, "error");
    } finally {
      t.disabled = false;
    }
    return;
  }

  const extEmail = t.getAttribute("data-external-ack");
  if (extEmail) {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
    const ackTab = document.querySelector('.tabs button[data-tab="acks"]');
    if (ackTab) ackTab.classList.add("active");
    document.querySelectorAll(".tab-panel").forEach((p) => {
      p.hidden = p.id !== "panel-acks";
    });
    $("ext-email").value = extEmail;
    const nm = t.getAttribute("data-external-name") || "";
    if (nm && !nm.includes("@")) $("ext-name").value = nm;
    $("ext-name").focus();
    loadAcks().catch(() => {});
    showMsg($("ext-ack-msg"), "Confirm printed name and optional note, then submit.", "info");
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


$("external-ack-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const payload = {
      email: $("ext-email").value.trim(),
      printedName: $("ext-name").value.trim(),
      externalNote: $("ext-note").value.trim(),
    };
    const d = $("ext-date").value;
    if (d) payload.acknowledgedAt = d;
    await api("/api/admin/policy-acks/external", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    showMsg($("ext-ack-msg"), "Recorded as external / admin override. They can reserve without the in-app pad.", "ok");
    $("ext-note").value = "";
    $("ext-date").value = "";
    await loadAcks();
    await loadReservations().catch(() => {});
  } catch (err) {
    showMsg($("ext-ack-msg"), err.message, "error");
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
  try {
    const cfg = await api("/api/config");
    if (cfg.outlook) {
      $("outlook-status").textContent =
        `Outlook sync: ${cfg.outlook.sync} · room ${cfg.outlook.roomEmail} (${cfg.outlook.roomName}). Cron pulls every 5 min when live; stub logs only.`;
    }
  } catch (_) {}
  await loadReservations();
}

boot().catch(() => {
  location.href = "/";
});
