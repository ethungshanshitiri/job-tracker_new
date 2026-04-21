/**
 * app.js — Faculty Job Tracker frontend
 *
 * Loads data/jobs.json, applies client-side filtering/sorting,
 * and renders institute cards with expandable job rows.
 */

(function () {
  "use strict";

  // ── State ──────────────────────────────────────────────────────────────────

  let allData = [];
  let filters = {
    search: "",
    type: "all",   // all | IIT | NIT
    rank: "all",   // all | Assistant Professor | Associate Professor
    dept: "all",   // all | electrical_engineering | electronics_communication | computer_science
    mode: "all",   // all | rolling | deadline
  };
  let sortBy = "deadline";

  // ── DOM refs ───────────────────────────────────────────────────────────────

  const loadingState     = document.getElementById("loading-state");
  const emptyState       = document.getElementById("empty-state");
  const cardsContainer   = document.getElementById("cards-container");
  const lastUpdatedText  = document.getElementById("last-updated-text");
  const activeCount      = document.getElementById("active-count");
  const statShowing      = document.getElementById("stat-showing");
  const footerGenerated  = document.getElementById("footer-generated");
  const searchInput      = document.getElementById("search");
  const sortSelect       = document.getElementById("sort-select");

  // ── Boot ───────────────────────────────────────────────────────────────────

  async function boot() {
    try {
      const res = await fetch("data/jobs.json?_=" + Date.now());
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();

      allData = json.results || [];
      const generatedAt = json.generatedAt;

      // Update header meta
      if (generatedAt) {
        const d = new Date(generatedAt);
        lastUpdatedText.textContent = "Updated " + formatRelativeTime(d);
        footerGenerated.textContent = "Generated " + d.toUTCString();
      }

      activeCount.textContent = allData.length;

      // Show stale-data banner if data is older than 25 hours
      if (generatedAt) {
        const age = Date.now() - new Date(generatedAt).getTime();
        if (age > 25 * 60 * 60 * 1000 || allData.length === 0) {
          showStaleBanner(allData.length === 0);
        }
      }

      loadingState.classList.add("hidden");
      render();

    } catch (err) {
      loadingState.classList.add("hidden");
      showStaleBanner(true);
      render();
      console.error("Failed to load jobs.json:", err);
    }
  }

  // ── Filter + sort pipeline ─────────────────────────────────────────────────

  function applyFilters(data) {
    return data
      .map((inst) => {
        // Filter jobs within each institute
        const filteredJobs = inst.jobs.filter((job) => {
          if (filters.rank !== "all" && job.rank !== filters.rank) return false;
          if (filters.dept !== "all" && job.departmentFamily !== filters.dept) return false;
          if (filters.mode === "rolling" && !job.rolling) return false;
          if (filters.mode === "deadline" && job.rolling) return false;
          return true;
        });

        if (filteredJobs.length === 0) return null;

        // Institute-level filters
        if (filters.type !== "all" && inst.type !== filters.type) return null;

        const q = filters.search.toLowerCase().trim();
        if (q) {
          const nameMatch = inst.name.toLowerCase().includes(q);
          const deptMatch = filteredJobs.some((j) =>
            j.department.toLowerCase().includes(q)
          );
          if (!nameMatch && !deptMatch) return null;
        }

        return { ...inst, jobs: filteredJobs };
      })
      .filter(Boolean);
  }

  function applySorting(data) {
    const FAR_FUTURE = "9999-12-31";

    return [...data].sort((a, b) => {
      if (sortBy === "name") {
        return a.name.localeCompare(b.name);
      }
      if (sortBy === "checked") {
        return new Date(b.checkedAt) - new Date(a.checkedAt);
      }
      if (sortBy === "deadline") {
        // Rolling basis entries sort after deadline-based ones
        const aDeadline = earliestDeadline(a.jobs) || FAR_FUTURE;
        const bDeadline = earliestDeadline(b.jobs) || FAR_FUTURE;
        return aDeadline.localeCompare(bDeadline);
      }
      return 0;
    });
  }

  function earliestDeadline(jobs) {
    const deadlines = jobs.map((j) => j.deadline).filter(Boolean);
    if (deadlines.length === 0) return null;
    return deadlines.sort()[0];
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  function render() {
    const filtered = applySorting(applyFilters(allData));

    statShowing.textContent = filtered.length + " result" + (filtered.length !== 1 ? "s" : "");

    cardsContainer.innerHTML = "";

    if (filtered.length === 0) {
      emptyState.classList.remove("hidden");
      return;
    }
    emptyState.classList.add("hidden");

    filtered.forEach((inst) => {
      cardsContainer.appendChild(buildCard(inst));
    });
  }

  // ── Card builder ───────────────────────────────────────────────────────────

  function buildCard(inst) {
    const card = document.createElement("article");
    card.className = "institute-card";
    card.setAttribute("aria-label", inst.name + " openings");

    const badgeClass = inst.type === "IIT" ? "badge-iit" : "badge-nit";
    const ts = inst.checkedAt ? formatRelativeTime(new Date(inst.checkedAt)) : "—";
    const jobCount = inst.jobs.length;

    // Count unique mode types
    const hasRolling = inst.jobs.some((j) => j.rolling);
    const hasDeadline = inst.jobs.some((j) => !j.rolling);

    const modeLabels = [];
    if (hasRolling) modeLabels.push('<span class="status-pill status-rolling">Rolling</span>');
    if (hasDeadline) modeLabels.push('<span class="status-pill status-deadline">Deadline</span>');

    card.innerHTML = `
      <div class="card-header" role="button" tabindex="0" aria-expanded="false" aria-controls="jobs-${inst.id}">
        <div class="card-institute-info">
          <span class="card-type-badge ${badgeClass}">${inst.type}</span>
          <div class="card-institute-name">${escHtml(inst.name)}</div>
          <div class="card-meta">
            <span class="card-job-count">${jobCount} opening${jobCount !== 1 ? "s" : ""}</span>
            ${modeLabels.join("")}
          </div>
        </div>
        <div class="card-right">
          <svg class="card-expand-icon" width="18" height="18" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
          <a class="card-source-link" href="${escHtml(inst.url)}" target="_blank" rel="noopener"
             aria-label="Official recruitment page for ${escHtml(inst.name)}" onclick="event.stopPropagation()">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
              <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            Official page
          </a>
          <span class="card-timestamp">Checked ${ts}</span>
        </div>
      </div>
      <div class="card-jobs" id="jobs-${inst.id}" role="list">
        ${inst.jobs.map((job) => buildJobRow(job)).join("")}
      </div>
    `;

    // Expand / collapse
    const header = card.querySelector(".card-header");
    header.addEventListener("click", () => toggleCard(card, header));
    header.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleCard(card, header);
      }
    });

    return card;
  }

  function toggleCard(card, header) {
    const expanded = card.classList.toggle("expanded");
    header.setAttribute("aria-expanded", expanded);
  }

  function buildJobRow(job) {
    let statusPill, statusClass;
    if (job.rolling) {
      statusPill = "Rolling basis";
      statusClass = "status-rolling";
    } else if (job.deadline) {
      statusPill = "Fixed deadline";
      statusClass = "status-deadline";
    } else {
      statusPill = "See page";
      statusClass = "status-unknown";
    }

    let deadlineHtml = "";
    if (job.deadline) {
      const isSoon = isWithinDays(job.deadline, 30);
      deadlineHtml = `<span class="job-deadline ${isSoon ? "soon" : ""}">Due ${formatDate(job.deadline)}</span>`;
    }

    const lowConf = job.confidence === "low";

    return `
      <div class="job-row" role="listitem">
        <div class="job-row-left">
          <span class="job-rank">${escHtml(job.rank)}</span>
          <span class="job-dept">${escHtml(job.department)}</span>
          <span class="confidence-tag ${lowConf ? "" : "hidden"}">⚠ Low confidence — verify manually</span>
        </div>
        <div class="job-row-right">
          <span class="status-pill ${statusClass}">${statusPill}</span>
          ${deadlineHtml}
        </div>
      </div>
    `;
  }

  // ── Stale banner ───────────────────────────────────────────────────────────

  function showStaleBanner(isEmpty) {
    const banner = document.createElement("div");
    banner.className = "stale-banner";
    if (isEmpty) {
      banner.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span>No data loaded yet. The scraper workflow needs to run at least once.
        See the <a href="https://github.com/job-tracker/blob/main/README.md" target="_blank">README</a> for setup instructions,
        or trigger the workflow manually via GitHub Actions.</span>
      `;
    } else {
      banner.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span>Data may be stale (older than 25 hours). Verify deadlines on official pages.</span>
      `;
    }
    cardsContainer.before(banner);
  }

  // ── Event wiring ───────────────────────────────────────────────────────────

  function wireEvents() {
    // Search
    searchInput.addEventListener("input", debounce(() => {
      filters.search = searchInput.value;
      render();
    }, 220));

    // Sort
    sortSelect.addEventListener("change", () => {
      sortBy = sortSelect.value;
      render();
    });

    // Toggle buttons
    document.querySelectorAll(".toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const filterKey = btn.dataset.filter;
        const value = btn.dataset.value;
        filters[filterKey] = value;

        // Update active state within group
        btn.closest(".toggle-group").querySelectorAll(".toggle-btn").forEach((b) => {
          b.classList.toggle("active", b === btn);
        });

        render();
      });
    });

    // Reset
    document.getElementById("btn-reset").addEventListener("click", resetFilters);
    document.getElementById("btn-clear-empty")?.addEventListener("click", resetFilters);
  }

  function resetFilters() {
    filters = { search: "", type: "all", rank: "all", dept: "all", mode: "all" };
    searchInput.value = "";
    sortSelect.value = "deadline";
    sortBy = "deadline";

    document.querySelectorAll(".toggle-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.value === "all");
    });

    render();
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  function escHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatRelativeTime(date) {
    const diff = Date.now() - date.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    const days = Math.floor(hrs / 24);
    return days + "d ago";
  }

  function formatDate(isoDate) {
    if (!isoDate) return "";
    const [y, m, d] = isoDate.split("-");
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return d + " " + months[parseInt(m, 10) - 1] + " " + y;
  }

  function isWithinDays(isoDate, days) {
    if (!isoDate) return false;
    const deadline = new Date(isoDate).getTime();
    const threshold = Date.now() + days * 24 * 60 * 60 * 1000;
    return deadline <= threshold;
  }

  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  wireEvents();
  boot();
})();
