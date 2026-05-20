"use strict";

const STORAGE_KEY = "robotics-attendance-hub-v1";
const GIT_SYNC_KEY = "robotics-attendance-git-sync";
const SUPABASE_SYNC_KEY = "robotics-attendance-supabase-sync";
const SUPABASE_STATE_ID = "main";
const BACKUP_PIN_SESSION_KEY = "robotics-attendance-backup-pin-hash";
const FIRST_LOGIN_SEEN_KEY = "robotics-attendance-first-login-walkthrough";
const SHIPPED_SUPABASE_CONFIG =
  typeof window !== "undefined" && window.JTECHMASTERS_SUPABASE ? window.JTECHMASTERS_SUPABASE : {};
const DB_SAVE_RATE_LIMIT_MS = 500;
const SUPABASE_REFRESH_INTERVAL_MS = 30000; // kept for compatibility but auto-refresh disabled
const SUPABASE_PING_INTERVAL_MS = 1000;
const SUPABASE_MAIN_SCREEN_PING_INTERVAL_MS = 60000;
const SUPABASE_PING_TIMEOUT_MS = 2000;
const SUPABASE_RECONNECT_INTERVAL_MS = 5000;
let supabasePingTimer = null;
let supabaseLocked = false; // true when offline/locked and trying slower reconnects
let supabaseLastKnownUpdatedAt = null;
let dbSaveTimer = null;
let authUsersLoaded = false;
const MAX_SCORE = 7;
const START_SCORE = 2;
const WARNING_THRESHOLD = 0;

const attendanceActions = {
  present: { label: "Showed up", delta: 0.5 },
  excused: { label: "Excused absence", delta: -0.5 },
  absent: { label: "No show", delta: -1 },
};

const OUTSIDE_MEETING_DELTA = 0.05;

const publicPostTypes = ["Update", "Blog", "Link", "Photo", "Social"];
const DEFAULT_LONG_BLOG_TITLE = "Build log: first sprint goals";
const DEFAULT_LONG_BLOG_BODY =
  "Our first sprint is focused on turning early ideas into testable robot systems. Programming is preparing the drivetrain control plan, CAD is sketching the first layout, and build is checking what parts can be reused from last season.\n\nThe goal is not to make every decision immediately. We want a simple prototype path, a shared vocabulary across sections, and enough documentation that new members can understand why each design choice exists.";

const sectionDefinitions = [
  { name: "Engineering", subsections: ["Programming", "CAD", "Build"] },
  { name: "Media", subsections: ["Photography", "Video", "Design"] },
  { name: "Marketing and Communications", subsections: ["Outreach", "Sponsors", "Social Media"] },
];

const sections = sectionDefinitions.map((section) => section.name);

function normalizeAssignments(user) {
  if (Array.isArray(user.assignments) && user.assignments.length) {
    return user.assignments.map((assignment) => ({
      section: String(assignment.section || "All"),
      subsection: String(assignment.subsection || "All"),
    }));
  }

  const section = String(user.section || "All");
  const subsection = String(
    user.subsection ||
      (user.role === "Coach" || user.role === "Section Head"
        ? "All"
        : firstSubsection(section)),
  );
  return [{ section, subsection }];
}

function userAssignments(user) {
  return normalizeAssignments(user);
}

function userHasSection(user, section) {
  if (section === "All") return true;
  return userAssignments(user).some(
    (assignment) => assignment.section === "All" || assignment.section === section,
  );
}

function userHasAnySection(user, sectionsToCheck) {
  return userAssignments(user).some((assignment) =>
    sectionsToCheck.some((section) => assignment.section === "All" || assignment.section === section),
  );
}

function userHasAssignment(user, section, subsection) {
  return userAssignments(user).some((assignment) => {
    if (assignment.section !== "All" && assignment.section !== section) return false;
    if (subsection === "All") return true;
    return assignment.subsection === "All" || assignment.subsection === subsection;
  });
}

function getPrimarySection(user) {
  return userAssignments(user)[0]?.section || "All";
}

function getPrimarySubsection(user) {
  return userAssignments(user)[0]?.subsection || "All";
}

function renderAssignmentLabels(user) {
  return userAssignments(user)
    .map((assignment) =>
      assignment.subsection === "All"
        ? `<span class="assignment-bubble">${escapeHtml(assignment.section)}</span>`
        : `<span class="assignment-bubble">${escapeHtml(assignment.section)} / ${escapeHtml(assignment.subsection)}</span>`,
    )
    .join(" ");
}

function renderAssignmentOptions() {
  return sectionDefinitions
    .flatMap((section) => [
      { section: section.name, subsection: "All" },
      ...section.subsections.map((subsection) => ({ section: section.name, subsection })),
    ])
    .map(
      (assignment) =>
        `<option value="${escapeHtml(assignment.section)}|${escapeHtml(assignment.subsection)}">${escapeHtml(
          assignment.subsection === "All"
            ? `${assignment.section} / Whole section`
            : `${assignment.section} / ${assignment.subsection}`,
        )}</option>`,
    )
    .join("");
}

function initAssignmentsInput() {
  const input = document.querySelector("#assignments-text");
  const suggestions = document.querySelector(".suggestions");
  const selectedContainer = document.querySelector("#selected-assignments");
  const currentSectionLabel = document.querySelector("#current-section-label");
  const hiddenInput = document.querySelector("#assignments-hidden");
  let selectedAssignments = [];
  let currentSection = null;
  let currentMode = "section"; // "section" or "subsection"

  if (input === null || suggestions === null || selectedContainer === null || currentSectionLabel === null || hiddenInput === null) { 
    showAlert("Could not initialize assignments input due to missing elements.", "Initialization Error");
    return;
  }

  function updateHiddenInput() {
    hiddenInput.value = selectedAssignments
      .map((assignment) => `${assignment.section || "All"} / ${assignment.subsection || "All"}`)
      .join(", ");
  }

  function updateCurrentSectionLabel() {
    if (currentMode === "subsection" && currentSection) {
      currentSectionLabel.textContent = `${currentSection} >`;
      currentSectionLabel.classList.add("active-section-label");
    } else {
      currentSectionLabel.textContent = "";
      currentSectionLabel.classList.remove("active-section-label");
    }
  }

  function renderSelected() {
    selectedContainer.innerHTML = selectedAssignments
      .map((assignment, index) => {
        const sectionText = String(assignment.section || "All").trim() || "All";
        const subsectionText = String(assignment.subsection || "All").trim() || "All";
        const displayText = subsectionText === "All" ? sectionText : `${sectionText} / ${subsectionText}`;
        return `
          <span class="assignment-bubble selected-assignment">
            ${escapeHtml(displayText)}
            <button type="button" class="remove-assignment" data-index="${index}">×</button>
          </span>
        `;
      })
      .join("");

    selectedContainer.querySelectorAll(".remove-assignment").forEach((button) => {
      button.addEventListener("click", () => {
        const index = Number(button.dataset.index);
        selectedAssignments.splice(index, 1);
        renderSelected();
      });
    });

    updateHiddenInput();
  }

  function showSuggestions(items) {
    if (!items.length) {
      suggestions.style.display = "none";
      return;
    }

    suggestions.innerHTML = items
      .map((item, index) => `<div class="suggestion-item" data-index="${index}">${escapeHtml(item.label)}</div>`)
      .join("");

    suggestions.style.display = "block";

    suggestions.querySelectorAll(".suggestion-item").forEach((item) => {
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        const index = Number(item.dataset.index);
        const selection = items[index];
        if (selection) {
          selectSuggestion(selection);
        }
      });
    });
  }

  function selectSuggestion(selection) {
    if (!selection) return;

    if (currentMode === "section") {
      currentSection = String(selection.section || "").trim();
      currentMode = "subsection";
      input.value = "";
      input.placeholder = `Subsections for ${currentSection}...`;
      updateCurrentSectionLabel();
      updateSuggestions();
      return;
    }

    const sectionName = String(currentSection || selection.section || "All").trim() || "All";
    const subsectionName = String(selection.subsection || "All").trim() || "All";
    selectedAssignments.push({ section: sectionName, subsection: subsectionName });
    currentSection = null;
    currentMode = "section";
    input.value = "";
    input.placeholder = "Start typing a section...";
    renderSelected();
    updateCurrentSectionLabel();
    suggestions.style.display = "none";
  }

  function updateSuggestions() {
    const query = input.value.toLowerCase();
    let items = [];

    if (currentMode === "section") {
      items = sectionDefinitions
        .filter((section) => section.name.toLowerCase().startsWith(query))
        .map((section) => ({ section: section.name, label: section.name }));
    } else if (currentSection) {
      const sectionDef = sectionDefinitions.find(
        (section) => section.name.toLowerCase() === String(currentSection).trim().toLowerCase(),
      );
      if (sectionDef) {
        items = ["All", ...sectionDef.subsections]
          .filter((sub) => sub.toLowerCase().startsWith(query))
          .map((sub) => ({ section: sectionDef.name, subsection: sub, label: sub }));
      }
    }

    showSuggestions(items);
  }

  input.addEventListener("input", updateSuggestions);

  input.addEventListener("keydown", (event) => {
    if (event.key === "Backspace" && !input.value && currentMode === "subsection") {
      event.preventDefault();
      currentMode = "section";
      currentSection = null;
      input.value = "";
      input.placeholder = "Start typing a section...";
      updateCurrentSectionLabel();
      updateSuggestions();
    }
  });

  input.addEventListener("blur", () => {
    setTimeout(() => {
      suggestions.style.display = "none";
    }, 150);
  });

  input.addEventListener("focus", updateSuggestions);
  updateCurrentSectionLabel();
  renderSelected();
}

const seedUsers = [
  {
    id: "u-coach",
    authUserId: "00000000-0000-4000-8000-000000000001",
    name: "Morgan Coach",
    email: "coach@team.local",
    role: "Coach",
    section: "All",
    subsection: "All",
    score: MAX_SCORE,
  },
  {
    id: "u-eng-head",
    authUserId: "00000000-0000-4000-8000-000000000002",
    name: "Sam Engineering",
    email: "engineering@team.local",
    role: "Section Head",
    section: "Engineering",
    subsection: "All",
    score: START_SCORE,
  },
  {
    id: "u-media-head",
    authUserId: "00000000-0000-4000-8000-000000000003",
    name: "Riley Media",
    email: "media@team.local",
    role: "Section Head",
    section: "Media",
    subsection: "All",
    score: START_SCORE,
  },
  {
    id: "u-alex",
    authUserId: "00000000-0000-4000-8000-000000000004",
    name: "Alex Vermeer",
    email: "alex@team.local",
    role: "Member",
    section: "Engineering",
    subsection: "Programming",
    score: START_SCORE,
  },
  {
    id: "u-nova",
    authUserId: "00000000-0000-4000-8000-000000000005",
    name: "Nova Jansen",
    email: "nova@team.local",
    role: "Member",
    section: "Media",
    subsection: "Photography",
    score: START_SCORE,
  },
  {
    id: "u-lee",
    authUserId: "00000000-0000-4000-8000-000000000006",
    name: "Lee Bakker",
    email: "lee@team.local",
    role: "Member",
    section: "Marketing and Communications",
    subsection: "Outreach",
    score: START_SCORE,
  },
];

const defaultDb = () => {
  return {
    users: [],
    meetings: [],
    messages: [],
    publicPosts: [],
    site: {
      aboutTitle: "",
      aboutBody:"",
      announcements: [],
      socials: [],
    },
  };
};

let db = loadDb();
let supabaseClient = null;
let currentAuthSession = null;
let currentUser = getSessionUser();
let currentView = "dashboard";
let gitAutosaveTimer = null;
let gitAutosaveBusy = false;
let supabaseAutosaveTimer = null;
let supabaseRemoteBusy = false;
let supabaseRefreshTimer = null;
let supabaseInitialLoadDone = false;
const authProfileSaveTimers = new Map();

const viewRoot = document.querySelector("#view-root");
const viewTitle = document.querySelector("#view-title");

document.addEventListener("DOMContentLoaded", async () => {
  wireLogin();
  wireChrome();
  await initSupabaseAuth();
  await loadDbFromSupabase();
  currentUser = getSessionUser();
  renderPublicSite();
  showAuthState();
});

function loadDb() {
  localStorage.removeItem(STORAGE_KEY);
  const raw = null;
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    return migrateDb(parsed);
  } catch {
    showAlert("An error occurred while loading the database.", "Load error");
    return migrateDb({});
  }
}

function migrateDb(source) {
  const fresh = defaultDb();
  const next = {
    users: [],
    meetings: Array.isArray(source.meetings) ? source.meetings : fresh.meetings,
    messages: Array.isArray(source.messages) ? source.messages : fresh.messages,
    publicPosts: Array.isArray(source.publicPosts) ? source.publicPosts : fresh.publicPosts,
    site: source.site && typeof source.site === "object" ? source.site : fresh.site,
  };
  let changed = false;
  if (!Array.isArray(source.publicPosts) || !source.site) changed = true;
  if (!Array.isArray(next.site.socials)) {
    next.site.socials = fresh.site.socials;
    changed = true;
  }
  if (!Array.isArray(next.site.announcements)) {
    if (next.site.announcement && typeof next.site.announcement === "object") {
      next.site.announcements = [
        {
          ...fresh.site.announcements[0],
          ...next.site.announcement,
          id: String(next.site.announcement.id || crypto.randomUUID()),
        },
      ];
    } else {
      next.site.announcements = fresh.site.announcements;
    }
    changed = true;
  } else {
    next.site.announcements = next.site.announcements.map((announcement) => ({
      ...fresh.site.announcements[0],
      ...announcement,
      id: String(announcement.id || crypto.randomUUID()),
    }));
  }
  if (!next.site.aboutTitle) {
    next.site.aboutTitle = fresh.site.aboutTitle;
    changed = true;
  }
  if (!next.site.aboutBody) {
    next.site.aboutBody = fresh.site.aboutBody;
    changed = true;
  }
  next.publicPosts.forEach((post) => {
    if (
      post.type === "Blog" &&
      post.title === "Build log" &&
      post.body === "Short public blog posts can summarize robot progress without exposing member-only operations."
    ) {
      post.title = DEFAULT_LONG_BLOG_TITLE;
      post.body = DEFAULT_LONG_BLOG_BODY;
      changed = true;
    }
  });
  next.messages.forEach((message) => {
    if (!message.audience) {
      message.audience = { type: "user", userId: message.toId };
      changed = true;
    }
  });
  next.meetings.forEach((meeting) => {
    if (!meeting.subsection) {
      meeting.subsection = "All";
      changed = true;
    }
  });
  return next;
}

function saveDb() {
  if (dbSaveTimer) {
    clearTimeout(dbSaveTimer);
  }

  dbSaveTimer = setTimeout(() => {
    scheduleSupabaseAutosave();
    scheduleGitAutosave();
    dbSaveTimer = null;
  }, DB_SAVE_RATE_LIMIT_MS);
}

function getSessionUser() {
  const session = getAuthSession();
  const authUser = session?.user;
  if (!authUser) return null;
  const email = String(authUser.email || "").toLowerCase();
  const storedProfile =
    db.users.find((user) => user.authUserId === authUser.id) ||
    db.users.find((user) => String(user.email || "").toLowerCase() === email) ||
    null;
  return authProfileFromSupabaseUser(authUser, storedProfile);
}

function authProfileFromSupabaseUser(authUser, storedProfile = null) {
  const metadata = {
    ...(authUser.user_metadata || {}),
    ...(authUser.app_metadata || {}),
  };
  const fallbackEmail = String(authUser.email || storedProfile?.email || "").toLowerCase();
  const fallbackAssignments = storedProfile?.assignments || [{ section: "All", subsection: "All" }];
  const assignments = Array.isArray(metadata.assignments) && metadata.assignments.length
    ? metadata.assignments.map((assignment) => ({
        section: String(assignment.section || "All"),
        subsection: String(assignment.subsection || "All"),
      }))
    : [{
        section: String(metadata.section || storedProfile?.section || fallbackAssignments[0]?.section || "All"),
        subsection: String(metadata.subsection || storedProfile?.subsection || fallbackAssignments[0]?.subsection || "All"),
      }];
  const role = String(metadata.role || storedProfile?.role || "Member");
  const name = String(
    metadata.name ||
      metadata.full_name ||
      metadata.display_name ||
      storedProfile?.name ||
      fallbackEmail ||
      "Temporary Coach",
  );

  return {
    ...(storedProfile || {}),
    id: storedProfile?.id || authUser.id,
    authUserId: authUser.id,
    name,
    email: fallbackEmail,
    role,
    section: assignments[0]?.section || "All",
    subsection: assignments[0]?.subsection || "All",
    sections: assignments.map((assignment) => assignment.section),
    subsections: assignments.map((assignment) => assignment.subsection),
    assignments,
    score: Number(metadata.score ?? storedProfile?.score ?? MAX_SCORE),
    portfolio: storedProfile?.portfolio || [],
    activityLog: storedProfile?.activityLog || [],
    needsPasswordChange: Boolean(metadata.needsPasswordChange ?? storedProfile?.needsPasswordChange),
    temporaryCoach: false,
  };
}

function getSupabaseClient() {
  const config = getSupabaseSyncConfig();
  if (!isSupabaseConfigured(config)) return null;
  if (!window.supabase?.createClient) {
    throw new Error("Supabase JavaScript client is not loaded.");
  }
  if (!supabaseClient) {
    supabaseClient = window.supabase.createClient(config.url, config.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }
  return supabaseClient;
}

async function safeFetch(input, init, timeout = 0) {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    throw new Error("Internet connection appears to be offline.");
  }

  let controller;
  let timer;
  const requestInit = { ...init };
  if (timeout) {
    controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeout);
    requestInit.signal = controller.signal;
  }

  try {
    return await fetch(input, requestInit);
  } catch (error) {
    if (timer) clearTimeout(timer);
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      throw new Error("Internet connection appears to be offline.");
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("No response from server during the network ping.");
    }
    throw new Error(error?.message || "Network request failed.");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stopSupabasePing() {
  clearTimeout(supabasePingTimer);
  supabasePingTimer = null;
}

function startSupabasePing() {
  supabaseLocked = false;
  if (supabasePingTimer) return;
  removeSyncOverlay();
  scheduleSupabasePing(0);
}

function getSupabasePingInterval() {
  if (currentView === "dashboard") {
    return SUPABASE_MAIN_SCREEN_PING_INTERVAL_MS;
  }
  return SUPABASE_PING_INTERVAL_MS;
}

function scheduleSupabasePing(delay) {
  const config = getSupabaseSyncConfig();
  if (!config.enabled || !config.url || !config.anonKey) return;
  clearTimeout(supabasePingTimer);
  const interval = typeof delay === "number"
    ? delay
    : supabaseLocked
    ? SUPABASE_RECONNECT_INTERVAL_MS
    : getSupabasePingInterval();
  supabasePingTimer = setTimeout(() => pingSupabaseServer(), interval);
}

function createSyncOverlay() {
  if (document.getElementById("sync-overlay")) return;
  const overlay = document.createElement("div");
  overlay.id = "sync-overlay";
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    background: "rgba(0,0,0,0.6)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: "99999",
    color: "#fff",
    pointerEvents: "auto",
  });

  const box = document.createElement("div");
  Object.assign(box.style, {
    background: "#222",
    padding: "24px",
    borderRadius: "8px",
    maxWidth: "90%",
    textAlign: "center",
    boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
  });
  box.innerHTML = `
    <div style="font-size:18px; margin-bottom:12px;">Connection lost</div>
    <div style="margin-bottom:12px;">Trying to reconnect&hellip;</div>
    <div class="spinner" style="width:28px;height:28px;margin:0 auto;border:4px solid rgba(255,255,255,0.15);border-top-color:#fff;border-radius:50%;animation:spin 1s linear infinite"></div>
    <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
  `;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function showSyncOverlay(message) {
  createSyncOverlay();
  const box = document.querySelector("#sync-overlay div");
  if (box && message) box.childNodes[1] && (box.childNodes[1].textContent = message);
}

function removeSyncOverlay() {
  const el = document.getElementById("sync-overlay");
  if (el) el.remove();
}

async function pingSupabaseServer() {
  const config = getSupabaseSyncConfig();
  if (!config.enabled || !config.url || !config.anonKey) return;

  try {
    const params = new URLSearchParams({ resource: "ping", id: config.stateId });
    if (supabaseLastKnownUpdatedAt) {
      params.set("lastUpdatedAt", supabaseLastKnownUpdatedAt);
    }

    const response = await safeFetch(
      `${supabaseFunctionUrl(config)}?${params.toString()}`,
      { headers: supabaseHeaders() },
      SUPABASE_PING_TIMEOUT_MS,
    );

    if (!response.ok) {
      throw new Error(`Supabase ping failed: ${response.status}`);
    }

    const payload = await response.json();
    if (payload.ping === 2) {
      supabaseLastKnownUpdatedAt = payload.updatedAt || supabaseLastKnownUpdatedAt;
      // if we were locked, remove lock and perform full load
      if (supabaseLocked) {
        supabaseLocked = false;
        removeSyncOverlay();
        updateSupabaseStatus("Reconnected. Loading updates...");
      }
      await loadDbFromSupabase(false);
      scheduleSupabasePing();
      return;
    }

    if (payload.updatedAt) {
      supabaseLastKnownUpdatedAt = payload.updatedAt;
    }
    // if previously locked, clear lock and restore UI
    if (supabaseLocked) {
      supabaseLocked = false;
      removeSyncOverlay();
      updateSupabaseStatus("Reconnected.");
    }
    updateSupabaseStatus(`Supabase ping OK ${formatDate(new Date().toISOString())}.`);
    scheduleSupabasePing();
  } catch (error) {
    // enter locked state but keep attempting reconnects at a slower interval
    supabaseLocked = true;
    updateSupabaseStatus(error.message || "Supabase ping failed. Attempting to reconnect...");
    try {
      showSyncOverlay(error?.message || "Connection lost. Trying to reconnect...");
    } catch (e) {
      // ignore overlay errors
    }
    scheduleSupabasePing(SUPABASE_RECONNECT_INTERVAL_MS);
  }
}

async function initSupabaseAuth() {
  const client = getSupabaseClient();
  if (!client) return;
  const { data, error } = await client.auth.getSession();
  if (error) {
    currentAuthSession = null;
    return;
  }
  currentAuthSession = data.session || null;
  client.auth.onAuthStateChange((_event, session) => {
    currentAuthSession = session || null;
    currentUser = hasBackupAccess() ? backupAccessProfile() : getSessionUser();
  });
}

function getAuthSession() {
  return currentAuthSession;
}

function getBackupPinHash() {
  return sessionStorage.getItem(BACKUP_PIN_SESSION_KEY) || "";
}

function hasBackupAccess() {
  return Boolean(getBackupPinHash());
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function backupAccessProfile() {
  return {
    id: "backup-access",
    authUserId: "backup-access",
    name: "Backup Access",
    email: "backup@local",
    role: "Coach",
    section: "All",
    subsection: "All",
    assignments: [{ section: "All", subsection: "All" }],
    score: MAX_SCORE,
    portfolio: [],
    activityLog: [],
    backupAccess: true,
  };
}

async function signInWithSupabaseAuth(email, password) {
  const authGate = await callSupabaseAuthAction("authenticate-user", { email, password });
  if (!authGate?.ok) {
    throw new Error(authGate?.error || "Email or password is incorrect.");
  }

  const client = getSupabaseClient();
  if (!client) {
    throw new Error("Supabase is not configured yet. Add the URL and anon key to supabase-config.js.");
  }
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw new Error(error.message || "Email or password is incorrect.");
  currentAuthSession = data.session || null;
  return getSessionUser();
}

async function checkLoginStatus(email) {
  if (!email) return null;
  try {
    return await callSupabaseAuthAction("check-login-status", { email });
  } catch (error) {
    return null;
  }
}

async function notifyLoginFailure(email) {
  if (!email) return null;
  try {
    return await callSupabaseAuthAction("notify-wrong-password", { email });
  } catch (error) {
    return { error: error.message };
  }
}

async function resetLoginAttempts(email) {
  if (!email) return null;
  try {
    return await callSupabaseAuthAction("reset-login-attempts", { email });
  } catch (error) {
    return null;
  }
}

async function sendSupabaseMagicLink(email) {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error("Supabase is not configured yet. Add the URL and anon key to supabase-config.js.");
  }
  const { error } = await client.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: window.location.origin + window.location.pathname,
    },
  });
  if (error) throw new Error(error.message || "Could not send sign-in link.");
}

async function callSupabaseAuthAction(action, body) {
  const config = getSupabaseSyncConfig();
  if (!isSupabaseConfigured(config)) {
    throw new Error("Supabase is not configured yet. Add the URL and anon key to supabase-config.js.");
  }
  if (!getAuthSession()?.access_token && !["authenticate-user", "verify-backup-pin", "check-login-status", "notify-wrong-password", "reset-login-attempts", "unblock-auth-user"].includes(action)) {
    if (!hasBackupAccess()) {
      throw new Error("Sign in again before changing Supabase Auth users.");
    }
  }

  let response;
  try {
    response = await safeFetch(supabaseFunctionUrl(config), {
      method: "POST",
      headers: {
        ...supabaseHeaders(),
        "x-state-id": config.stateId,
        ...(hasBackupAccess() ? { "x-backup-pin-hash": getBackupPinHash() } : {}),
      },
      body: JSON.stringify({
        action,
        ...(hasBackupAccess() ? { backupPinHash: getBackupPinHash() } : {}),
        ...body,
      }),
    });
  } catch (error) {
    const detail = error?.message ? ` (${error.message})` : "";
    throw new Error(
      `Could not reach the Supabase Edge Function "${config.functionName}". Refresh the page after deploying the latest function and check that CORS/preflight succeeds.${detail}`
    );
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        `This user does not exist.`
      );
    }
    throw new Error(payload.error || `Supabase Auth action failed: ${response.status}`);
  }
  return payload;
}

function normalizeAuthUserProfile(user) {
  const assignments = Array.isArray(user.assignments) && user.assignments.length
    ? user.assignments.map((assignment) => ({
        section: String(assignment.section || "All"),
        subsection: String(assignment.subsection || "All"),
      }))
    : [{
        section: String(user.section || "All"),
        subsection: String(user.subsection || "All"),
      }];
  const authUserId = String(user.authUserId || user.id || "");
  return {
    id: authUserId || String(user.id || crypto.randomUUID()),
    authUserId,
    name: String(user.name || user.email || "Member"),
    email: String(user.email || "").toLowerCase(),
    role: String(user.role || "Member"),
    section: assignments[0]?.section || "All",
    subsection: assignments[0]?.subsection || "All",
    sections: assignments.map((assignment) => assignment.section),
    subsections: assignments.map((assignment) => assignment.subsection),
    assignments,
    score: clampScore(Number(user.score ?? START_SCORE)),
    portfolio: Array.isArray(user.portfolio) ? user.portfolio : [],
    activityLog: Array.isArray(user.activityLog) ? user.activityLog : [],
    needsPasswordChange: Boolean(user.needsPasswordChange),
    invalidPasswordAttempts: Number(user.invalidPasswordAttempts ?? 0),
    lockoutCount: Number(user.lockoutCount ?? 0),
    lockoutUntil: user.lockoutUntil ? String(user.lockoutUntil) : null,
    blocked: Boolean(user.blocked),
    maxInvalidAttempts: Number(user.maxInvalidAttempts ?? 3),
    maxLockouts: Number(user.maxLockouts ?? 3),
    lockoutDurationMinutes: Number(user.lockoutDurationMinutes ?? 10),
    coachLockoutDurationMinutes: Number(user.coachLockoutDurationMinutes ?? 5),
  };
}

async function saveAuthProfile(user) {
  const result = await callSupabaseAuthAction("update-auth-profile", {
    profile: user,
  });
  if (result.authUserId && user.authUserId !== result.authUserId) {
    user.authUserId = result.authUserId;
    user.id = result.authUserId;
  }
  return result;
}

function authMetadataFromProfile(user) {
  return {
    name: String(user.name || ""),
    role: String(user.role || "Member"),
    section: String(user.section || "All"),
    subsection: String(user.subsection || "All"),
    assignments: Array.isArray(user.assignments) ? user.assignments : [],
    score: Number(user.score ?? START_SCORE),
    portfolio: Array.isArray(user.portfolio) ? user.portfolio : [],
    activityLog: Array.isArray(user.activityLog) ? user.activityLog : [],
    needsPasswordChange: Boolean(user.needsPasswordChange),
    invalidPasswordAttempts: Number(user.invalidPasswordAttempts ?? 0),
    lockoutCount: Number(user.lockoutCount ?? 0),
    lockoutUntil: user.lockoutUntil ?? null,
    blocked: Boolean(user.blocked),
    maxInvalidAttempts: Number(user.maxInvalidAttempts ?? 3),
    maxLockouts: Number(user.maxLockouts ?? 3),
    lockoutDurationMinutes: Number(user.lockoutDurationMinutes ?? 10),
    coachLockoutDurationMinutes: Number(user.coachLockoutDurationMinutes ?? 5),
  };
}

async function updateOwnSupabasePassword(member, password) {
  const client = getSupabaseClient();
  if (!client) showAlert("Supabase is not configured yet.");
  const profile = {
    ...member,
    needsPasswordChange: false,
  };
  const { data, error } = await client.auth.updateUser({
    password,
    data: authMetadataFromProfile(profile),
  });
  if (error) showAlert(error.message || "Could not update your password.");
  currentAuthSession = data?.session || getAuthSession();
  return data?.user || null;
}

async function loadAuthUsersFromSupabase(manual = false) {
  const config = getSupabaseSyncConfig();
  if (!config.enabled && !manual) return;
  if (!isSupabaseConfigured(config)) {
    updateSupabaseStatus("Supabase is missing a project URL or anon key.");
    return;
  }
  if (!getAuthSession()?.access_token) {
    if (!hasBackupAccess()) {
      updateSupabaseStatus("Sign in before loading Supabase Auth users.");
      return;
    }
  }

  const headers = {
    ...supabaseHeaders(),
    ...(hasBackupAccess() ? { "x-backup-pin-hash": getBackupPinHash() } : {}),
  };

  try {
    const response = await safeFetch(
      `${supabaseFunctionUrl(config)}?resource=users&id=${encodeURIComponent(config.stateId)}`,
      {
        headers,
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) showAlert(payload.error || `Supabase Auth users load failed: ${response.status}`);
    if (payload.usersError) showAlert(payload.usersError);
    db.users = Array.isArray(payload.users) ? payload.users.map(normalizeAuthUserProfile) : [];
    authUsersLoaded = true;
    currentUser = hasBackupAccess() ? backupAccessProfile() : getSessionUser();
    updateSupabaseStatus(`Loaded Supabase Auth users ${formatDate(new Date().toISOString())}.`);
    if (currentUser && viewRoot && viewTitle) render();
  } catch (error) {
    authUsersLoaded = false;
    updateSupabaseStatus(error.message || "Could not load Supabase Auth users.");
    if (manual) await showAlert(error.message || "Could not load Supabase Auth users.", "Supabase Auth");
  }
}

function scheduleAuthProfileSave(user) {
  if (!user?.authUserId) return;
  clearTimeout(authProfileSaveTimers.get(user.authUserId));
  authProfileSaveTimers.set(
    user.authUserId,
    setTimeout(() => {
      authProfileSaveTimers.delete(user.authUserId);
      saveAuthProfile(user).catch((error) => updateSupabaseStatus(error.message || "Could not save Auth profile."));
    }, 300),
  );
}

async function signOutOfSupabaseAuth() {
  const client = getSupabaseClient();
  if (client) await client.auth.signOut().catch(() => {});
  currentAuthSession = null;
  currentUser = null;
}

function setLoginButtonLoading(isLoading) {
  const loginButton = document.querySelector("#login-form button[type='submit']");
  if (!loginButton) return;
  if (isLoading) {
    if (!loginButton.dataset.originalHtml) {
      loginButton.dataset.originalHtml = loginButton.innerHTML;
    }
    loginButton.disabled = true;
    loginButton.innerHTML = `<span class="button-loader"></span> Signing in...`;
  } else {
    loginButton.disabled = false;
    if (loginButton.dataset.originalHtml) {
      loginButton.innerHTML = loginButton.dataset.originalHtml;
    }
  }
}

function wireLogin() {
  wireBackupAccessGesture();
  handlePublicEntryHash();

  document.querySelector("#open-login")?.addEventListener("click", () => {
    document.querySelector("#public-site").classList.add("hidden");
    document.querySelector("#login-screen").classList.remove("hidden");
    refreshIcons();
  });

  document.querySelector("#back-public")?.addEventListener("click", () => {
    document.querySelector("#login-screen").classList.add("hidden");
    document.querySelector("#public-site").classList.remove("hidden");
    document.querySelector("#login-error").textContent = "";
  });

  document.querySelector("#login-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = document.querySelector("#login-email").value.trim().toLowerCase();
    const password = document.querySelector("#login-password").value;
    if (!password) {
      document.querySelector("#login-error").textContent =
        "Enter a password, or use Email sign-in link if this Supabase user has no password.";
      return;
    }

    setLoginButtonLoading(true);
    document.querySelector("#login-error").textContent = "";

    try {
      const status = await checkLoginStatus(email);
      if (status?.blocked) {
        document.querySelector("#login-error").textContent =
          status.message || "Your account is blocked until a coach unlocks it.";
        return;
      }
      if (status?.locked) {
        const lockoutUntil = status.lockoutUntil ? new Date(status.lockoutUntil) : null;
        const remainingMinutes = lockoutUntil ? Math.max(1, Math.ceil((lockoutUntil - new Date()) / 60000)) : 0;
        document.querySelector("#login-error").textContent =
          status.message || `Too many failed login attempts. Try again in ${remainingMinutes} minute${remainingMinutes !== 1 ? "s" : ""}.`;
        return;
      }

      const user = await signInWithSupabaseAuth(email, password);
      await resetLoginAttempts(email);
      await loadDbFromSupabase(true);
      await loadAuthUsersFromSupabase(true);
      if (!user) {
        await signOutOfSupabaseAuth();
        document.querySelector("#login-error").textContent =
          "Supabase Auth accepted this login, but no matching member profile exists in the app data.";
        return;
      }
      showAuthState();
      await maybeRunFirstLoginFlow();
    } catch (error) {
      const defaultMessage = error.message || "Email or password is incorrect.";
      const isLockError = /blocked|locked/i.test(defaultMessage);
      const result = isLockError ? null : await notifyLoginFailure(email);
      document.querySelector("#login-error").textContent =
        result?.message || result?.error || defaultMessage;
    } finally {
      setLoginButtonLoading(false);
    }
  });

  document.querySelector("#magic-link-login")?.addEventListener("click", async () => {
    const email = document.querySelector("#login-email").value.trim().toLowerCase();
    if (!email) {
      document.querySelector("#login-error").textContent = "Enter your email first.";
      return;
    }
    try {
      await sendSupabaseMagicLink(email);
      document.querySelector("#login-error").textContent = "Check your email for the Supabase sign-in link.";
    } catch (error) {
      document.querySelector("#login-error").textContent = error.message || "Could not send sign-in link.";
    }
  });
}

function wireBackupAccessGesture() {
  document.addEventListener("keydown", async (event) => {
    if (!(event.ctrlKey && event.altKey && event.shiftKey && event.key.toLowerCase() === "b")) return;
    event.preventDefault();
    await openBackupAccessPrompt();
  });
}

function handlePublicEntryHash() {
  if (window.location.hash === "#login") {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    setTimeout(() => document.querySelector("#open-login")?.click(), 0);
  }
  if (window.location.hash === "#backup") {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    setTimeout(() => openBackupAccessPrompt(), 0);
  }
}

async function openBackupAccessPrompt() {
  if (!document.getElementById("modal-prompt")) {
    window.location.href = `${rootPath()}#backup`;
    return;
  }
  const pin = await showPrompt("Enter the 16 digit backup PIN.", "", "Backup Access", "password");
  if (!pin) return;
  const normalized = String(pin).replace(/\D/g, "");
  if (normalized.length !== 16) {
    await showAlert("Backup PIN must be exactly 16 digits.", "Backup Access");
    return;
  }

  try {
    const backupPinHash = await sha256Hex(normalized);
    const result = await callSupabaseAuthAction("verify-backup-pin", { backupPinHash });
    if (!result.ok) showAlert("Backup PIN was rejected.");
    sessionStorage.setItem(BACKUP_PIN_SESSION_KEY, backupPinHash);
    currentUser = backupAccessProfile();
    currentView = "members";
    document.querySelector("#public-site")?.classList.add("hidden");
    document.querySelector("#login-screen")?.classList.add("hidden");
    await loadAuthUsersFromSupabase(true);
    showAuthState();
  } catch (error) {
    await showAlert(error.message || "Backup access failed.", "Backup Access");
  }
}

function rootPath() {
  const path = window.location.pathname;
  if (path.includes("/blogs/") || path.includes("/about/")) return "../";
  return "index.html";
}

async function maybeRunFirstLoginFlow() {
  if (!currentUser || currentUser.backupAccess) return;
  const seenKey = `${FIRST_LOGIN_SEEN_KEY}:${currentUser.authUserId}`;
  if (currentUser.needsPasswordChange) {
    await showAlert("Please set a new password before continuing.", "First Sign-In");
    const changed = await handlePasswordChange(currentUser, true);
    if (!changed) return;
  }
  if (!sessionStorage.getItem(seenKey)) {
    sessionStorage.setItem(seenKey, "1");
    await showAlert(
      "Welcome. Use Dashboard for your score and messages, Presence for meeting attendance, Agenda for upcoming events, and Portfolio for project work.",
      "Quick Walkthrough",
    );
  }
}

function wireChrome() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => {
      currentView = button.dataset.view;
      render();
    });
  });

  document.querySelector("#logout")?.addEventListener("click", async () => {
    sessionStorage.removeItem(BACKUP_PIN_SESSION_KEY);
    await signOutOfSupabaseAuth();
    showAuthState();
  });
}

function showAuthState() {
  const isLoggedIn = Boolean(currentUser);
  document.querySelector("#public-site")?.classList.toggle("hidden", isLoggedIn);
  document.querySelector("#login-screen")?.classList.add("hidden");
  document.querySelector("#app")?.classList.toggle("hidden", !isLoggedIn);
  if (isLoggedIn) {
    if (!viewRoot || !viewTitle) return;
    document.querySelector("#user-name").textContent = currentUser.name;
    document.querySelector("#role-label").textContent =
      currentUser.backupAccess
        ? "Backup access"
        : currentUser.role === "Coach"
        ? "Coach access"
        : `${currentUser.role} - ${currentUser.section}${currentUser.subsection && currentUser.subsection !== "All" ? ` / ${currentUser.subsection}` : ""}`;
    updateNavVisibility();
    render();
  } else {
    renderPublicSite();
  }
  refreshIcons();
}

function updateNavVisibility() {
  const hideForMembers = currentUser?.role === "Member";
  document.querySelectorAll(".nav-item").forEach((button) => {
    const memberHiddenViews = ["members", "site"];
    button.hidden = hideForMembers && memberHiddenViews.includes(button.dataset.view);
  });
  if (hideForMembers && ["members", "site"].includes(currentView)) {
    currentView = "dashboard";
  }
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

// Modal System
function showModal(modalId) {
  document.getElementById("modal-overlay").classList.remove("hidden");
  document.getElementById("modal-container").classList.remove("hidden");
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.remove("hidden");
}

function hideModals() {
  document.getElementById("modal-overlay").classList.add("hidden");
  document.getElementById("modal-container").classList.add("hidden");
  document.querySelectorAll(".modal").forEach((m) => m.classList.add("hidden"));
  refreshIcons();
}

function showAlert(message, title = "Alert") {
  return new Promise((resolve) => {
    document.getElementById("modal-alert-title").textContent = title;
    document.getElementById("modal-alert-message").textContent = message;
    showModal("modal-alert");
    refreshIcons();

    const okButton = document.getElementById("modal-alert-ok");
    const closeButton = document.querySelector("#modal-alert .modal-close");
    
    const cleanup = () => {
      okButton.removeEventListener("click", cleanup);
      closeButton.removeEventListener("click", cleanup);
      hideModals();
      resolve(true);
    };

    okButton.addEventListener("click", cleanup);
    closeButton.addEventListener("click", cleanup);
  });
}

function showConfirm(message, title = "Confirm") {
  return new Promise((resolve) => {
    document.getElementById("modal-confirm-title").textContent = title;
    document.getElementById("modal-confirm-message").textContent = message;
    showModal("modal-confirm");
    refreshIcons();

    const yesButton = document.getElementById("modal-confirm-yes");
    const noButton = document.getElementById("modal-confirm-no");
    const closeButton = document.querySelector("#modal-confirm .modal-close");
    
    const cleanup = (result) => {
      yesButton.removeEventListener("click", handleYes);
      noButton.removeEventListener("click", handleNo);
      closeButton.removeEventListener("click", handleNo);
      hideModals();
      resolve(result);
    };

    const handleYes = () => cleanup(true);
    const handleNo = () => cleanup(false);

    yesButton.addEventListener("click", handleYes);
    noButton.addEventListener("click", handleNo);
    closeButton.addEventListener("click", handleNo);
  });
}

function showPrompt(message, defaultValue = "", title = "Input", inputType = "text") {
  return new Promise((resolve) => {
    document.getElementById("modal-prompt-title").textContent = title;
    document.getElementById("modal-prompt-message").textContent = message;
    const input = document.getElementById("modal-prompt-input");
    input.type = inputType;
    input.value = defaultValue;
    input.placeholder = "Enter text here...";
    showModal("modal-prompt");
    refreshIcons();
    input.focus();

    const okButton = document.getElementById("modal-prompt-ok");
    const cancelButton = document.getElementById("modal-prompt-cancel");
    const closeButton = document.querySelector("#modal-prompt .modal-close");
    
    const cleanup = (result) => {
      okButton.removeEventListener("click", handleOk);
      cancelButton.removeEventListener("click", handleCancel);
      closeButton.removeEventListener("click", handleCancel);
      input.removeEventListener("keypress", handleKeypress);
      hideModals();
      input.type = "text";
      resolve(result);
    };

    const handleOk = () => cleanup(input.value);
    const handleCancel = () => cleanup(null);
    const handleKeypress = (e) => {
      if (e.key === "Enter") cleanup(input.value);
      if (e.key === "Escape") cleanup(null);
    };

    okButton.addEventListener("click", handleOk);
    cancelButton.addEventListener("click", handleCancel);
    closeButton.addEventListener("click", handleCancel);
    input.addEventListener("keypress", handleKeypress);
  });
}

function render() {
  if (!viewRoot || !viewTitle) return;
  const hideMemberTabs = currentUser.role === "Member";
  document.querySelectorAll(".nav-item").forEach((button) => {
    const view = button.dataset.view;
    const visible = !(hideMemberTabs && (view === "members" || view === "meetings"));
    button.classList.toggle("active", view === currentView);
    button.style.display = visible ? "" : "none";
  });

  if (hideMemberTabs && (currentView === "members" || currentView === "meetings")) {
    currentView = "dashboard";
  }

  let renderers;
  if (currentUser.role === "Coach" || currentUser.role === "Section Head") {
    const titles = {
      dashboard: "Dashboard",
      members: "Members",
      meetings: "Presence",
      agenda: "Agenda",
      messages: "Messages",
      portfolio: "Portfolio",
      site: "Public Site"
    };
    viewTitle.textContent = titles[currentView];
    renderers = {
      dashboard: renderDashboard,
      members: renderMembers,
      meetings: renderMeetings,
      agenda: renderAgenda,
      messages: renderMessages,
      portfolio: renderPortfolio,
      site: renderSiteManager,
    };
  } else {
    const titles = {
      dashboard: "Dashboard",
      agenda: "Agenda",
      messages: "Messages",
      portfolio: "Portfolio",
      site: "Public Site",
    };
    viewTitle.textContent = titles[currentView];
    renderers = {
      dashboard: renderDashboard,
      agenda: renderAgenda,
      messages: renderMessages,
      portfolio: renderPortfolio,
      site: renderSiteManager,
    };
  }
  renderers[currentView]();
  renderAppAnnouncement();
  refreshIcons();
}

function visibleMembers() {
  if (currentUser.role === "Coach") return db.users;
  if (currentUser.role === "Section Head") {
    const mySections = userAssignments(currentUser).map((assignment) => assignment.section);
    return db.users.filter(
      (user) => user.role !== "Coach" && userHasAnySection(user, mySections),
    );
  }
  return db.users.filter((user) => user.id === currentUser.id);
}

function visibleMessagesFor(user) {
  return db.messages.filter((message) => message.fromId === user.id || messageMatchesAudience(message, user));
}

function messageMatchesAudience(message, user) {
  if (Array.isArray(message.recipientIds)) return message.recipientIds.includes(user.id);
  const audience = message.audience || { type: "user", userId: message.toId };
  if (audience.type === "team") return true;
  if (audience.type === "section") return userHasSection(user, audience.section) || message.fromId === user.id;
  if (audience.type === "subsection") {
    return userHasAssignment(user, audience.section, audience.subsection) || message.fromId === user.id;
  }
  return audience.userId === user.id;
}

function messageRecipientsForAudience(audience) {
  if (audience.type === "team") return db.users;
  if (audience.type === "section") {
    return db.users.filter((user) => userHasSection(user, audience.section));
  }
  if (audience.type === "subsection") {
    return db.users.filter((user) => userHasAssignment(user, audience.section, audience.subsection));
  }
  return db.users.filter((user) => user.id === audience.userId);
}

function directMessageUsers() {
  return db.users.filter((user) => user.id !== currentUser.id);
}

function messageAudienceKindOptions() {
  return [
    { value: "section", label: "Section" },
    { value: "team", label: "Whole team" },
    { value: "private", label: "Private" },
  ];
}

function messageAudienceTargetOptions(kind) {
  if (kind === "team") return [{ value: "team", label: "Whole team" }];
  if (kind === "private") {
    return directMessageUsers().map((user) => ({
      value: `user:${user.id}`,
      label: `${user.name} - ${user.role}`,
    }));
  }
  return [];
}

function renderOptions(options) {
  return options
    .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
    .join("");
}

function sectionSelectOptions() {
  return sections.map((section) => ({ value: section, label: section }));
}

function subsectionSelectOptions(section) {
  const subsections = sectionDefinitions.find((item) => item.name === section)?.subsections || [];
  return [
    { value: "All", label: "Whole section" },
    ...subsections.map((subsection) => ({ value: subsection, label: subsection })),
  ];
}

function privateUserOptions(section) {
  return directMessageUsers()
    .filter((user) => userHasSection(user, section))
    .map((user) => ({ value: user.id, label: `${user.name} - ${user.role}` }));
}

function parseMessageAudience(kind, sectionValue, subsectionValue, privateUserId) {
  if (kind === "team") return { type: "team" };
  const section = String(sectionValue || "");
  if (kind === "section") {
    const subsection = String(subsectionValue || "All");
    if (subsection === "All" && canSendToSection(section)) return { type: "section", section };
    if (canSendToSubsection(section, subsection)) return { type: "subsection", section, subsection };
    return null;
  }
  if (
    kind === "private" &&
    directMessageUsers().some((user) => user.id === privateUserId && userHasSection(user, section))
  ) {
    return { type: "user", userId: privateUserId };
  }
  return null;
}

function canSendToSection(section) {
  return sections.includes(section);
}

function canSendToSubsection(section, subsection) {
  const sectionDef = sectionDefinitions.find((item) => item.name === section);
  return Boolean(sectionDef?.subsections.includes(subsection));
}

function editableMembers() {
  if (currentUser.role === "Coach") return db.users;
  if (currentUser.role === "Section Head") {
    const mySections = userAssignments(currentUser).map((assignment) => assignment.section);
    return db.users.filter((user) => user.role !== "Coach" && userHasAnySection(user, mySections));
  }
  return [];
}

function canManageMember(member) {
  if (currentUser.role === "Coach") return true;
  if (currentUser.role !== "Section Head") return false;
  const mySections = userAssignments(currentUser).map((assignment) => assignment.section);
  return member.role !== "Coach" && userHasAnySection(member, mySections);
}

function canManageMeeting(meeting) {
  if (currentUser.role === "Coach") return true;
  return currentUser.role === "Section Head" && userHasSection(currentUser, meeting.scope);
}

function meetingMembers(meeting) {
  if (meeting.scope === "Global") return db.users.filter((user) => user.role !== "Coach");
  return db.users.filter((user) => userHasAssignment(user, meeting.scope, meeting.subsection));
}

function renderDashboard() {
  const members = visibleMembers();
  const myMessages = visibleMessagesFor(currentUser);
  const upcoming = getVisibleMeetings()
    .filter((meeting) => new Date(meeting.startsAt) >= new Date())
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))
    .slice(0, 4);
  const warnings = members.filter((member) => member.score < WARNING_THRESHOLD);
  const lockedUsers = members.filter((member) => member.lockoutUntil && new Date(member.lockoutUntil) > new Date());
  const blockedUsers = members.filter((member) => Boolean(member.blocked));

  if (currentUser.role === "Member") {
    const user = db.users.find((member) => member.id === currentUser.id);
    const lockoutUntil = user?.lockoutUntil ? new Date(user.lockoutUntil) : null;
    const isLocked = lockoutUntil ? lockoutUntil > new Date() : false;
    const isBlocked = Boolean(user?.blocked);

    let warningPanel = "";
    if (isBlocked) {
      warningPanel = panel("Account Status", `<div class="warning-box blocked"><strong>⚠️ Account Blocked</strong><p>Your account has been locked due to multiple failed login attempts. Please contact a coach to unlock it.</p></div>`);
    } else if (isLocked) {
      const remainingMinutes = Math.max(1, Math.ceil((lockoutUntil - new Date()) / 60000));
      warningPanel = panel("Account Status", `<div class="warning-box cooldown"><strong>⏱️ Login Cooldown Active</strong><p>Your account is temporarily locked. You can try logging in again in ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}.</p></div>`);
    }

    viewRoot.innerHTML = `
      ${warningPanel}
      <div class="grid three">
        ${statCard("Personal Score", scorePill(user.score), "Score can exceed warning recovery plans, but maxes at 7.")}
        ${statCard("Upcoming", upcoming.length, "Meetings and events visible to your section.")}
        ${statCard("Messages", myMessages.length, "Internal messages received.")}
      </div>
      <div class="grid two">
        ${panel("Attendance History", renderActivityList(user.activityLog))}
        ${panel("Upcoming Meetings", renderMeetingList(upcoming))}
      </div>
      ${panel("Messages", renderMessageList(myMessages))}
    `;
    return;
  }

  const securityWarnings = 
    (blockedUsers.length > 0 ? `<li class="list-item warning"><strong>${blockedUsers.length} account${blockedUsers.length !== 1 ? 's' : ''} blocked</strong> - Requires coach action</li>` : "") +
    (lockedUsers.length > 0 ? `<li class="list-item warning"><strong>${lockedUsers.length} account${lockedUsers.length !== 1 ? 's' : ''} on cooldown</strong> - Failed login attempts</li>` : "");

  viewRoot.innerHTML = `
    <div class="grid three">
      ${statCard("Visible Members", members.length, "Strictly based on your role permissions.")}
      ${statCard("Below Warning", warnings.length, "Scores below 0 need attention.")}
      ${statCard("Upcoming Meetings", upcoming.length, "Scheduled meetings in your scope.")}
    </div>
    <div class="grid two">
      ${panel("Score Warnings", renderMemberMiniList(warnings))}
      ${panel("Upcoming Agenda", renderMeetingList(upcoming))}
    </div>
    ${
      securityWarnings
        ? panel("Security Alerts", `<ul class="list">${securityWarnings}</ul>`)
        : ""
    }
    ${panel("Recent Activity", renderActivityFeed(members))}
  `;
}

function renderMembers() {
  if (!authUsersLoaded) {
    viewRoot.innerHTML = `
      <div class="toolbar">
        <button id="load-auth-users" class="primary-btn"><i data-lucide="refresh-cw"></i>Load Supabase users</button>
      </div>
      <div class="empty-state">Loading members from Supabase Auth...</div>
    `;
    document.querySelector("#load-auth-users")?.addEventListener("click", () => loadAuthUsersFromSupabase(true));
    loadAuthUsersFromSupabase(false);
    return;
  } 

  const members = visibleMembers();
  const editable = editableMembers();
  const lockedUsers = members.filter((member) => member.lockoutUntil && new Date(member.lockoutUntil) > new Date());
  const blockedUsers = members.filter((member) => Boolean(member.blocked));
  const filterOptions =
    currentUser.role === "Coach"
      ? `<label>Section<select id="member-section-filter"><option value="All">All sections</option>${sections
          .map((section) => `<option value="${section}">${section}</option>`)
          .join("")}</select></label>`
      : "";
  if (currentUser.role === "Section Head") {
    const mySections = userAssignments(currentUser).map((assignment) => assignment.section);
  }
  viewRoot.innerHTML = `
    <div class="toolbar">
      ${filterOptions}
      ${
        currentUser.role === "Coach"
          ? `<button id="add-member" class="primary-btn"><i data-lucide="user-plus"></i>Add member</button>`
          : ""
      }
    </div>
    <div id="member-table"></div>
    ${
      currentUser.role === "Coach"
        ? panel(
            "New Member",
            `<form id="member-form" class="form-grid">
              <label>Name<input name="name" required></label>
              <label>Email<input name="email" type="email" required></label>
              <label>Role<select name="role"><option>Member</option><option>Section Head</option><option>Coach</option></select></label>
              <label>Assignments<div id="assignments-input" class="assignments-input">
                <div id="selected-assignments" class="selected-assignments"></div>
                <div class="input-row">
                  <span id="current-section-label" class="current-section-label"></span>
                  <input type="text" id="assignments-text" placeholder="Start typing a section...">
                </div>
                <div class="suggestions" style="display: none;"></div>
              </div></label>
              <label>Temporary password (optional)<input name="password" type="password" autocomplete="new-password" minlength="6" placeholder="Leave blank to generate one"></label>
              <input type="hidden" name="assignments" id="assignments-hidden">
              <p class="form-hint full">Optional password for the new user. Leave blank to generate a one-time temporary password on the backend.</p>
              <label>Starting score<input name="score" type="number" step="0.025" value="${START_SCORE}" required></label>
              <button class="primary-btn full" type="submit"><i data-lucide="save"></i>Create user</button>
            </form>`,
          )
        : ""
    }
  `;
  
  const renderTable = () => {
    const selected = document.querySelector("#member-section-filter")?.value || "All";
    const filtered =
      selected === "All"
        ? members
        : members.filter((member) => userHasSection(member, selected));
    document.querySelector("#member-table").innerHTML = renderMembersTable(filtered, editable);
    wireMemberTable();
    refreshIcons();
  };

  document.querySelector("#member-section-filter")?.addEventListener("change", renderTable);
  const memberForm = document.querySelector("#member-form");
  memberForm?.addEventListener("submit", handleCreateUser);
  if (currentUser.role === "Coach") initAssignmentsInput();
  renderTable();
}

function renderMembersTable(members, editable) {
  if (!members.length) return `<div class="empty-state">No members match this filter.</div>`;
  const rows = members
    .map((member) => {
      const canEdit = editable.some((item) => item.id === member.id);
      const lockoutUntil = member.lockoutUntil ? new Date(member.lockoutUntil) : null;
      const isLocked = lockoutUntil ? lockoutUntil > new Date() : false;
      const isBlocked = Boolean(member.blocked);
      const statusIcon = isBlocked ? "🔒" : isLocked ? "⏱️" : "";
      const statusClass = isBlocked ? "blocked" : isLocked ? "cooldown" : "";
      const unlockButton =
        currentUser.role === "Coach" && (isBlocked || isLocked) && member.id !== currentUser.id
          ? `<button class="small-btn unlock-member" data-member="${member.id}"><i data-lucide="unlock"></i>Unlock</button>`
          : "";
      return `
        <tr class="${statusClass}">
          <td><strong>${escapeHtml(member.name)}</strong><br><span class="muted">${escapeHtml(member.email)}</span>${statusIcon ? ` <span class="status-icon">${statusIcon}</span>` : ""}</td>
          <td>${member.role}</td>
          <td class="assignments-cell">${renderAssignmentLabels(member)}</td>
          <td>${scorePill(member.score)}</td>
          <td>
            ${
              canEdit
                ? `<div class="toolbar">
                    <input class="score-input" data-member="${member.id}" type="number" step="0.025" value="${member.score}">
                    <button class="small-btn save-score" data-member="${member.id}"><i data-lucide="save"></i>Save</button>
                    ${
                      currentUser.role === "Coach" && member.id !== currentUser.id
                        ? `<button class="small-btn outside-credit" data-member="${member.id}" ${hasOutsideCreditToday(member) ? "disabled" : ""}><i data-lucide="plus"></i>Outside +${OUTSIDE_MEETING_DELTA}</button>
                          <button class="small-btn reset-password" data-member="${member.id}"><i data-lucide="key-round"></i>Set password</button>
                          ${unlockButton}
                          <button class="danger-btn remove-member" data-member="${member.id}"><i data-lucide="trash-2"></i>Remove</button>`
                        : ""
                    }
                  </div>`
                : `<span class="muted">View only</span>`
            }
          </td>
          <td class="activity-cell" data-member="${member.id}">${renderActivityList(member.activityLog.slice(-1), true)}</td>
        </tr>
      `;
    })
    .join("");
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Role</th><th>Assignments</th><th>Score</th><th>Correction</th><th>Latest Activity</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function wireMemberTable() {
  document.querySelectorAll(".save-score").forEach((button) => {
    button.addEventListener("click", () => {
      const member = db.users.find((user) => user.id === button.dataset.member);
      if (!member || !canManageMember(member)) return;
      const input = document.querySelector(`.score-input[data-member="${member.id}"]`);
      const nextScore = Number(input.value);
      if (Number.isNaN(nextScore)) return;
      changeScore(member, nextScore - member.score, "Manual score correction", {
        type: "manual-correction",
        reversible: true,
      });
      saveDb();
      renderMembers();
    });
  });

  document.querySelectorAll(".activity-cell").forEach((cell) => {
    cell.addEventListener("click", () => {
      const memberId = cell.dataset.member;
      const member = db.users.find((user) => user.id === memberId);
      if (!member) return;
      const isExpanded = cell.classList.contains("expanded");
      if (isExpanded) {
        cell.innerHTML = renderActivityList(member.activityLog.slice(-1), true);
        cell.classList.remove("expanded");
      } else {
        cell.innerHTML = renderActivityList(member.activityLog, true);
        cell.classList.add("expanded");
      }
    });
  });

  document.querySelectorAll(".outside-credit").forEach((button) => {
    button.addEventListener("click", () => {
      if (currentUser.role !== "Coach") return;
      const member = db.users.find((user) => user.id === button.dataset.member);
      if (!member || hasOutsideCreditToday(member)) return;
      addOutsideMeetingCredit(member);
      saveDb();
      renderMembers();
    });
  });

  document.querySelectorAll(".reset-password").forEach((button) => {
    button.addEventListener("click", async () => {
      if (currentUser.role !== "Coach") return;
      const member = db.users.find((user) => user.id === button.dataset.member);
      if (!member || member.id === currentUser.id) return;
      await handlePasswordChange(member);
    });
  });

  document.querySelectorAll(".unlock-member").forEach((button) => {
    button.addEventListener("click", async () => {
      if (currentUser.role !== "Coach") return;
      const member = db.users.find((user) => user.id === button.dataset.member);
      if (!member || member.id === currentUser.id) return;
      try {
        await callSupabaseAuthAction("unblock-auth-user", { profile: member });
        await loadAuthUsersFromSupabase(true);
        renderMembers();
      } catch (error) {
        await showAlert(error.message || "Could not unlock this user.", "Unlock User");
      }
    });
  });

  document.querySelectorAll(".remove-member").forEach((button) => {
    button.addEventListener("click", async () => {
      if (currentUser.role !== "Coach") return;
      const member = db.users.find((user) => user.id === button.dataset.member);
      if (!member || member.id === currentUser.id) return;
      const confirmed = await showConfirm(
        `Are you sure you want to remove ${member.name}? This will also remove their messages and meeting attendance records.`,
        "Remove User",
      );
      if (!confirmed) return;
      try {
        await callSupabaseAuthAction("delete-auth-user", { profile: member });
      } catch (error) {
        await showAlert(error.message || "Could not remove the Supabase Auth user.", "Supabase Auth");
        return;
      }
      removeMember(member.id);
      saveDb();
      await saveDbToSupabase(false);
      renderMembers();
    });
  });
}

async function handleCreateUser(event) {
  event.preventDefault();
  if (currentUser.role !== "Coach") {
    renderMembers();
    return;
  }
  const form = new FormData(event.currentTarget);
  const email = form.get("email").trim().toLowerCase();
  if (db.users.some((user) => user.email.toLowerCase() === email)) {
    await showAlert("A user with that email already exists.", "Duplicate Email");
    return;
  }
  const role = form.get("role");
  const password = String(form.get("password") || "").trim();
  if (password && password.length < 6) {
    await showAlert("Temporary password must be at least 6 characters.", "Password Too Short");
    return;
  }
  const rawAssignmentsText = form.get("assignments") || "";
  const assignments = rawAssignmentsText
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s)
    .map((assignmentStr) => {
      const parts = assignmentStr.split(" / ").map((p) => p.trim());
      if (parts.length === 2) {
        return { section: parts[0], subsection: parts[1] };
      }
      return null;
    })
    .filter(Boolean);
  const normalizedAssignments =
    role === "Coach"
      ? [{ section: "All", subsection: "All" }]
      : assignments.length
      ? assignments
      : [{ section: "Engineering", subsection: "All" }];
  const score = clampScore(Number(form.get("score")));
  const user = {
    id: crypto.randomUUID(),
    authUserId: null,
    name: form.get("name").trim(),
    email,
    role,
    section: normalizedAssignments[0].section,
    subsection: normalizedAssignments[0].subsection,
    sections: normalizedAssignments.map((assignment) => assignment.section),
    subsections: normalizedAssignments.map((assignment) => assignment.subsection),
    assignments: normalizedAssignments,
    score,
    portfolio: [],
    activityLog: [],
    needsPasswordChange: true,
  };
  user.activityLog.push(logEntry("created", `User created with score ${score}.`, 0, score, score));

  try {
    const result = await callSupabaseAuthAction("create-auth-user", {
      ...(password ? { password } : {}),
      profile: {
        ...user,
        ...(password ? { password } : {}),
      },
    });
    user.authUserId = result.authUserId || null;
    if (result.authUserId) user.id = result.authUserId;
    if (result.temporaryPassword) {
      await showAlert(
        `Temporary password for ${email}: ${result.temporaryPassword}\n\nGive it to the member now. It will not be shown again.`,
        "Temporary Password",
      );
    } else if (password) {
      await showAlert(
        `User created for ${email}. The provided password has been set successfully. Share it securely with the member.`,
        "User Created",
      );
    }
  } catch (error) {
    await showAlert(error.message || "Could not create the Supabase Auth user.", "Supabase Auth");
    return;
  }

  db.users.push(normalizeAuthUserProfile(user));
  saveDb();
  await loadAuthUsersFromSupabase(true);
  event.currentTarget.reset();
  renderMembers();
}

function removeMember(memberId) {
  db.users = db.users.filter((user) => user.id !== memberId);
  db.messages = db.messages.filter((message) => {
    if (message.fromId === memberId) return false;
    const audience = message.audience || { type: "user", userId: message.toId };
    return audience.type !== "user" || audience.userId !== memberId;
  });
  db.meetings.forEach((meeting) => {
    delete meeting.attendance[memberId];
    meeting.scoreChanges = meeting.scoreChanges.filter((change) => change.memberId !== memberId);
  });
}

function addOutsideMeetingCredit(member) {
  changeScore(member, OUTSIDE_MEETING_DELTA, "Outside meeting attendance confirmed by coach", {
    type: "outside-meeting",
    reversible: true,
    eventDate: todayKey(),
  });
}

function hasOutsideCreditToday(member) {
  const today = todayKey();
  return member.activityLog.some(
    (entry) =>
      entry.type === "outside-meeting" && entry.eventDate === today && entry.reversed !== true,
  );
}

function renderMeetings() {
  const meetings = getVisibleMeetings().sort((a, b) => new Date(b.startsAt) - new Date(a.startsAt));
  const canCreate = currentUser.role !== "Member";
  viewRoot.innerHTML = `
    ${
      canCreate
        ? panel(
            "Create Meeting",
            `<form id="meeting-form" class="form-grid">
              <label>Title<input name="title" required></label>
              <label>Date and time<input name="startsAt" type="datetime-local" required></label>
              <label>Scope<select name="scope" ${currentUser.role === "Section Head" ? "disabled" : ""}>
                ${
                  currentUser.role === "Coach"
                    ? `<option>Global</option>${sections.map((section) => `<option>${section}</option>`).join("")}`
                    : `<option selected>${currentUser.section}</option>`
                }
              </select></label>
              <label>Subsection<select name="subsection">
                ${currentUser.role === "Coach" ? `<option>All</option>` : subsectionOptions(currentUser.section, true)}
              </select></label>
              <button class="primary-btn full" type="submit"><i data-lucide="calendar-plus"></i>Create meeting</button>
            </form>`,
          )
        : ""
    }
    <div class="grid">${meetings.map(renderMeetingCard).join("") || `<div class="empty-state">No meetings in your scope yet.</div>`}</div>
  `;

  document.querySelector("#meeting-form")?.addEventListener("submit", handleCreateMeeting);
  const meetingForm = document.querySelector("#meeting-form");
  meetingForm?.elements.scope.addEventListener("change", () => {
    meetingForm.elements.subsection.innerHTML =
      meetingForm.elements.scope.value === "Global"
        ? `<option>All</option>`
        : subsectionOptions(meetingForm.elements.scope.value, true);
  });
  document.querySelectorAll(".attendance-select").forEach((select) => {
    select.addEventListener("change", () => {
      const meeting = db.meetings.find((item) => item.id === select.dataset.meeting);
      if (!meeting || !canManageMeeting(meeting) || meeting.applied) return;
      meeting.attendance[select.dataset.member] = select.value;
      saveDb();
    });
  });
  document.querySelectorAll(".apply-meeting").forEach((button) => {
    button.addEventListener("click", () => applyMeeting(button.dataset.meeting));
  });
  document.querySelectorAll(".reverse-meeting").forEach((button) => {
    button.addEventListener("click", () => reverseMeeting(button.dataset.meeting));
  });
}

async function handleCreateMeeting(event) {
  event.preventDefault();
  const confirmed = await showConfirm(
    "Create this meeting? Members will be able to mark their attendance.",
    "Create Meeting"
  );
  if (!confirmed) return;
  const form = new FormData(event.currentTarget);
  const scope = currentUser.role === "Section Head" ? currentUser.section : form.get("scope");
  const subsection = scope === "Global" ? "All" : form.get("subsection");
  db.meetings.push({
    id: crypto.randomUUID(),
    title: form.get("title").trim(),
    startsAt: new Date(form.get("startsAt")).toISOString(),
    scope,
    subsection,
    createdBy: currentUser.id,
    attendance: {},
    applied: false,
    reversed: false,
    scoreChanges: [],
  });
  saveDb();
  renderMeetings();
}

function renderMeetingCard(meeting) {
  const members = meetingMembers(meeting).filter((member) => {
    if (currentUser.role === "Member") return member.id === currentUser.id;
    if (currentUser.role === "Section Head") {
      const mySections = userAssignments(currentUser).map((assignment) => assignment.section);
      return userHasAnySection(member, mySections);
    }
    return true;
  });
  const controls = members
    .map((member) => {
      const value = meeting.attendance[member.id] || "";
      return `
            <div class="attendance-row">
              <div>
                <strong>${escapeHtml(member.name)}</strong><br>
                <div class="assignments-cell">
                  ${renderAssignmentLabels(member)} 
                </div>
                ${scorePill(member.score)}
              </div>

              <select 
                class="attendance-select" 
                data-meeting="${meeting.id}" 
                data-member="${member.id}" 
                ${meeting.applied || !canManageMeeting(meeting) ? "disabled" : ""}
              >
                <option value="" ${value === "" ? "selected" : ""}>
                  Not marked
                </option>

                ${Object.entries(attendanceActions)
                  .filter(([, action]) => currentUser.role === "Coach" || !action.coachOnly)
                  .map(
                    ([key, action]) =>
                      `<option value="${key}" ${value === key ? "selected" : ""}>
                        ${action.label} (${formatDelta(action.delta)})
                      </option>`
                  )
                  .join("")}
              </select>
            </div>
      `;
    })
    .join("");
  const buttons = canManageMeeting(meeting)
    ? `<div class="toolbar">
        <button class="primary-btn apply-meeting" data-meeting="${meeting.id}" ${meeting.applied ? "disabled" : ""}><i data-lucide="check-check"></i>Apply scores</button>
        <button class="danger-btn reverse-meeting" data-meeting="${meeting.id}" ${!meeting.applied || meeting.reversed ? "disabled" : ""}><i data-lucide="undo-2"></i>Reverse scores</button>
      </div>`
    : "";

  return `
    <section class="panel meeting-card">
      <header>
        <div>
          <h3>${escapeHtml(meeting.title)}</h3>
          <p class="muted">${formatDate(meeting.startsAt)} - <span class="badge">${meetingScopeLabel(meeting)}</span> ${meeting.applied ? "- Applied" : ""} ${meeting.reversed ? "- Reversed" : ""}</p>
        </div>
      </header>
      <div class="attendance-grid">${controls || `<div class="empty-state">No members for this meeting scope.</div>`}</div>
      ${buttons}
    </section>
  `;
}

function applyMeeting(meetingId) {
  const meeting = db.meetings.find((item) => item.id === meetingId);
  if (!meeting || !canManageMeeting(meeting) || meeting.applied) return;
  meeting.scoreChanges = [];
  meetingMembers(meeting).forEach((member) => {
    const status = meeting.attendance[member.id];
    if (!status || !attendanceActions[status]) return;
    if (attendanceActions[status].coachOnly && currentUser.role !== "Coach") return;
    const delta = attendanceActions[status].delta;
    const entry = changeScore(member, delta, `${attendanceActions[status].label}: ${meeting.title}`, {
      type: "attendance",
      meetingId: meeting.id,
      reversible: true,
    });
    meeting.scoreChanges.push({ memberId: member.id, logId: entry.id, delta });
  });
  meeting.applied = true;
  meeting.reversed = false;
  saveDb();
  renderMeetings();
}

function reverseMeeting(meetingId) {
  const meeting = db.meetings.find((item) => item.id === meetingId);
  if (!meeting || !canManageMeeting(meeting) || !meeting.applied || meeting.reversed) return;
  meeting.scoreChanges.forEach((change) => {
    const member = db.users.find((user) => user.id === change.memberId);
    if (!member) return;
    changeScore(member, -change.delta, `Reversed score change for ${meeting.title}`, {
      type: "reversal",
      meetingId: meeting.id,
      reversible: false,
    });
    const original = member.activityLog.find((entry) => entry.id === change.logId);
    if (original) original.reversed = true;
  });
  meeting.reversed = true;
  saveDb();
  renderMeetings();
}

function getVisibleMeetings() {
  if (currentUser.role === "Coach") return db.meetings;
  if (currentUser.role === "Section Head") {
    return db.meetings.filter(
      (meeting) => meeting.scope === "Global" || userHasSection(currentUser, meeting.scope),
    );
  }
  return db.meetings.filter(
    (meeting) =>
      meeting.scope === "Global" ||
      userHasAssignment(currentUser, meeting.scope, meeting.subsection),
  );
}

function renderAgenda() {
  const meetings = getVisibleMeetings()
    .slice()
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
  viewRoot.innerHTML = panel(
    "Weekly Timeline",
    `<div class="timeline">${
      meetings
        .map(
          (meeting) => `
            <div class="timeline-item">
              <strong>${new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(meeting.startsAt))}</strong>
              <div>
                <strong>${escapeHtml(meeting.title)}</strong>
                <p class="muted">${formatDate(meeting.startsAt)} - ${meetingScopeLabel(meeting)}</p>
              </div>
            </div>`,
        )
        .join("") || `<div class="empty-state">No timeline items yet.</div>`
    }</div>`,
  );
}

function renderMessages() {
  const audienceKinds = messageAudienceKindOptions();
  const messages = visibleMessagesFor(currentUser)
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  viewRoot.innerHTML = `
    <div class="grid two">
      ${panel(
        "Send Message",
        `<form id="message-form" class="form-grid">
          <label>Algemeen<select name="audienceKind">${renderOptions(audienceKinds)}</select></label>
          <label data-message-field="section-picker">Section<select name="sectionTarget">${renderOptions(sectionSelectOptions())}</select></label>
          <label data-message-field="subsection-picker">Subsection<select name="subsectionTarget">${renderOptions(subsectionSelectOptions(sections[0]))}</select></label>
          <label data-message-field="private-picker" hidden>Person<select name="privateTarget">${renderOptions(privateUserOptions(sections[0]))}</select></label>
          <label class="full">Message<textarea name="body" required></textarea></label>
          <button class="primary-btn full" type="submit"><i data-lucide="send"></i>Send</button>
        </form>`,
      )}
      ${panel("Thread", `<div class="list message-thread">${renderMessageList(messages)}</div>`)}
    </div>
  `;
  const messageForm = document.querySelector("#message-form");
  const updateAudienceFields = () => {
    const kind = messageForm.elements.audienceKind.value;
    const section = messageForm.elements.sectionTarget.value;
    document.querySelectorAll("[data-message-field]").forEach((field) => {
      const key = field.dataset.messageField;
      const shouldHide =
        kind === "team" ||
        (kind === "section" && key === "private-picker") ||
        (kind === "private" && key === "subsection-picker");
      field.hidden = shouldHide;
      field.classList.toggle("hidden", shouldHide);
      field.querySelectorAll("select").forEach((select) => {
        select.disabled = shouldHide;
      });
    });
    if (kind === "private") {
      messageForm.elements.privateTarget.innerHTML = renderOptions(privateUserOptions(section));
    }
    if (kind === "section") {
      messageForm.elements.subsectionTarget.innerHTML = renderOptions(subsectionSelectOptions(section));
    }
  };
  messageForm.elements.audienceKind.addEventListener("change", () => {
    updateAudienceFields();
  });
  messageForm.elements.sectionTarget.addEventListener("change", () => {
    messageForm.elements.subsectionTarget.innerHTML = renderOptions(
      subsectionSelectOptions(messageForm.elements.sectionTarget.value),
    );
    messageForm.elements.privateTarget.innerHTML = renderOptions(
      privateUserOptions(messageForm.elements.sectionTarget.value),
    );
  });
  updateAudienceFields();
  document.querySelector("#message-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const audience = parseMessageAudience(
      form.get("audienceKind"),
      form.get("sectionTarget"),
      form.get("subsectionTarget"),
      form.get("privateTarget"),
    );
    if (!audience) {
      await showAlert("Choose a valid message target.", "Invalid Target");
      return;
    }
    const recipients = messageRecipientsForAudience(audience).filter((user) => user.id !== currentUser.id);
    if (!recipients.length) {
      await showAlert("No recipients match that audience.", "No Recipients");
      return;
    }
    if (audience.type === "team") {
      const confirmed = await showConfirm(
        `Send this message to the entire team (${recipients.length} recipients)?`,
        "Send to Whole Team"
      );
      if (!confirmed) return;
    }
    db.messages.push({
      id: crypto.randomUUID(),
      fromId: currentUser.id,
      toId: audience.userId || null,
      audience,
      recipientIds: recipients.map((user) => user.id),
      at: new Date().toISOString(),
      body: form.get("body").trim(),
      read: false,
    });
    saveDb();
    renderMessages();
  });
}

function renderPortfolio() {
  const targetMembers =
    currentUser.role === "Coach"
      ? db.users
      : db.users.filter((member) => member.id === currentUser.id);
  const options = targetMembers
    .map((member) => `<option value="${member.id}">${escapeHtml(member.name)}</option>`)
    .join("");
  viewRoot.innerHTML = `
    ${panel(
      "Log Work",
      `<form id="portfolio-form" class="form-grid">
        <label>Member<select name="memberId" ${currentUser.role !== "Coach" ? "disabled" : ""}>${options}</select></label>
        <label>Date<input name="date" type="date" value="${new Date().toISOString().slice(0, 10)}" required></label>
        <label>Project or task<input name="project" required></label>
        <label class="full">Notes<textarea name="notes" required></textarea></label>
        <button class="primary-btn full" type="submit"><i data-lucide="folder-plus"></i>Add entry</button>
      </form>`,
    )}
    ${panel("Portfolio Entries", renderPortfolioEntries(targetMembers))}
  `;
  document.querySelector("#portfolio-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const memberId = currentUser.role === "Coach" ? form.get("memberId") : currentUser.id;
    const member = db.users.find((user) => user.id === memberId);
    if (!member) return;
    if (currentUser.role !== "Coach" && member.id !== currentUser.id) return;
    member.portfolio.unshift({
      id: crypto.randomUUID(),
      date: form.get("date"),
      project: form.get("project").trim(),
      notes: form.get("notes").trim(),
      authorId: currentUser.id,
    });
    member.activityLog.push(logEntry("portfolio", `Portfolio entry added: ${form.get("project")}.`, 0, member.score, member.score));
    scheduleAuthProfileSave(member);
    saveDb();
    renderPortfolio();
  });
}

function renderPortfolioEntries(members) {
  const entries = members.flatMap((member) =>
    member.portfolio.map((entry) => ({ ...entry, memberName: member.name })),
  );
  if (!entries.length) return `<div class="empty-state">No portfolio entries yet.</div>`;
  return `<ul class="list">${entries
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .map(
      (entry) => `
        <li class="list-item">
          <header><strong>${escapeHtml(entry.project)}</strong><span class="badge">${entry.date}</span></header>
          <p class="muted">${escapeHtml(entry.memberName)}</p>
          <p>${escapeHtml(entry.notes)}</p>
        </li>`,
    )
    .join("")}</ul>`;
}

function renderSiteManager() {
  viewRoot.innerHTML = `
    <div class="grid two">
      ${panel(
        "About Us",
        `<form id="about-form" class="form-grid">
          <label>Heading<input name="aboutTitle" value="${escapeHtml(db.site.aboutTitle)}" required></label>
          <label class="full">About text<textarea name="aboutBody" required>${escapeHtml(db.site.aboutBody)}</textarea></label>
          <div class="full social-editor">
            ${renderSocialInputs(db.site.socials)}
          </div>
          <button class="primary-btn full" type="submit"><i data-lucide="save"></i>Save public about</button>
        </form>`,
      )}
      ${panel(
        "Site Banner",
        `<form id="announcement-form" class="form-grid">
          <div class="announcement-editor-header">
            <p class="muted">Create multiple banner messages for the public site.</p>
            <button id="add-announcement" type="button" class="secondary-btn full"><i data-lucide="plus"></i>Add banner</button>
          </div>
          <div id="announcement-list" class="announcement-list">
            ${db.site.announcements
              .map((announcement, index) => renderAnnouncementRow(announcement, index))
              .join("")}
          </div>
          <button class="primary-btn full" type="submit"><i data-lucide="megaphone"></i>Save banners</button>
        </form>`,
      )}
      ${panel(
        "Publish Post",
        `<form id="public-post-form" class="form-grid">
          <label>Type<select name="type">${publicPostTypes.map((type) => `<option>${type}</option>`).join("")}</select></label>
          <label>Title<input name="title" required></label>
          <p class="form-hint full">Use Blog for long progress articles. Use Update for quick 2-3 line notes.</p>
          <label class="full">Post text<textarea name="body" required></textarea></label>
          <label>Link URL<input name="url" type="url" placeholder="https://www.instagram.com/team"></label>
          <label>Link label<input name="urlLabel" placeholder="Open Instagram"></label>
          <button class="primary-btn full" type="submit"><i data-lucide="send"></i>Publish to main page</button>
        </form>`,
      )}
    </div>
    ${currentUser.role === "Coach" ? renderSupabaseSyncPanel() : ""}
    ${currentUser.role === "Coach" ? renderGitSyncPanel() : ""}
    ${panel("Published Posts", renderPostManagerList())}
    ${currentUser.role === "Coach" ? panel(
      "Data Management",
      `<form id="data-management-form" class="form-grid">
        <label>Remove activity logs older than<select name="months">${[1,3,6,12,24].map((m) => `<option value="${m}">${m} months</option>`).join("")}</select></label>
        <button class="danger-btn full" type="submit"><i data-lucide="trash-2"></i>Remove old logs</button>
      </form>`,
    ) : ""}
  `;

  document.querySelector("#about-form").addEventListener("submit", handleSaveAbout);
  document.querySelector("#announcement-form").addEventListener("submit", handleSaveAnnouncement);
  document.querySelector("#add-announcement")?.addEventListener("click", addAnnouncementRow);
  document.querySelectorAll(".remove-announcement").forEach((button) => {
    button.addEventListener("click", removeAnnouncementRow);
  });
  document.querySelector("#public-post-form").addEventListener("submit", handlePublishPost);
  document.querySelector("#supabase-sync-form")?.addEventListener("submit", handleSaveSupabaseSync);
  document.querySelector("#supabase-load-now")?.addEventListener("click", () => loadDbFromSupabase(true));
  document.querySelector("#supabase-save-now")?.addEventListener("click", () => saveDbToSupabase(true));
  document.querySelector("#git-sync-form")?.addEventListener("submit", handleSaveGitSync);
  document.querySelector("#git-sync-now")?.addEventListener("click", () => syncDbToGitHub(true));
  document.querySelectorAll(".delete-post").forEach((button) => {
    button.addEventListener("click", async () => {
      const post = db.publicPosts.find((item) => item.id === button.dataset.post);
      if (!post || !canDeletePost(post)) return;
      const confirmed = await showConfirm(`Delete "${post.title}" from the public page?`, "Delete Post");
      if (!confirmed) return;
      db.publicPosts = db.publicPosts.filter((item) => item.id !== post.id);
      saveDb();
      renderPublicSite();
      renderSiteManager();
    });
  });

  document.querySelector("#data-management-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const months = Number(form.get("months"));
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const cutoffIso = cutoff.toISOString();
    let removedCount = 0;
    db.users.forEach((user) => {
      const originalLength = user.activityLog.length;
      user.activityLog = user.activityLog.filter((entry) => entry.at >= cutoffIso);
      removedCount += originalLength - user.activityLog.length;
    });
    saveDb();
    await showAlert(`Removed ${removedCount} old activity log entries.`, "Data Cleanup Complete");
    renderSiteManager();
  });
}

function renderAnnouncementRow(announcement, index) {
  const rowId = escapeHtml(String(announcement.id || `new-${index}`));
  return `
    <fieldset class="announcement-row" data-row-id="${rowId}" data-updated-at="${escapeHtml(announcement.updatedAt || "")}">
      <div class="announcement-row-header">
        <p class="announcement-row-title">Banner ${index + 1}</p>
        <button type="button" class="ghost-btn remove-announcement" aria-label="Remove banner">Remove</button>
      </div>
      <label class="checkbox-label full"><input class="announcement-enabled" name="enabled-${rowId}" type="checkbox" ${announcement.enabled ? "checked" : ""}> Enabled</label>
      <label>Type<select class="announcement-type" name="type-${rowId}">${["Update", "Issue", "Maintenance", "Resolved"]
        .map(
          (type) =>
            `<option ${announcement.type === type ? "selected" : ""}>${type}</option>`,
        )
        .join("")}</select></label>
      <label>Title<input class="announcement-title" name="title-${rowId}" value="${escapeHtml(announcement.title)}" placeholder="Short site update"></label>
      <label class="full">Message<textarea class="announcement-body" name="body-${rowId}" placeholder="Keep it brief: technical problem, planned maintenance, or a new update.">${escapeHtml(announcement.body)}</textarea></label>
    </fieldset>
  `;
}

function renderSocialInputs(socials) {
  const rows = [...socials, { label: "", url: "" }, { label: "", url: "" }].slice(0, 5);
  return `
    <span class="section-label">Public links</span>
    <div class="social-editor-grid">
      ${rows
        .map(
          (social) => `
            <label>Label<input name="socialLabel" value="${escapeHtml(social.label)}" placeholder="Instagram"></label>
            <label>URL<input name="socialUrl" type="url" value="${escapeHtml(social.url)}" placeholder="https://www.instagram.com/"></label>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderGitSyncPanel() {
  const config = getGitSyncConfig();
  return panel(
    "Git Autosave",
    `<form id="git-sync-form" class="form-grid">
      <label class="checkbox-label full"><input name="enabled" type="checkbox" ${config.enabled ? "checked" : ""}> Autosave app data to GitHub</label>
      <label>Owner<input name="owner" value="${escapeHtml(config.owner)}" placeholder="ftcJTeChmasters" required></label>
      <label>Repository<input name="repo" value="${escapeHtml(config.repo)}" placeholder="FTC_32722_JTeChmasters_WEB" required></label>
      <label>Branch<input name="branch" value="${escapeHtml(config.branch)}" placeholder="master" required></label>
      <label>Data path<input name="path" value="${escapeHtml(config.path)}" placeholder="data/db.json" required></label>
      <label class="full">GitHub token<input name="token" type="password" placeholder="${config.token ? "Token saved in this browser" : "Fine-grained token with Contents read/write"}"></label>
      <p class="form-hint full">This writes the LocalStorage database to GitHub as JSON. The token is kept only in this browser and is never saved into the repo.</p>
      <button class="primary-btn" type="submit"><i data-lucide="save"></i>Save sync settings</button>
      <button id="git-sync-now" class="small-btn" type="button"><i data-lucide="refresh-cw"></i>Sync now</button>
      <p id="git-sync-status" class="form-hint full">${escapeHtml(config.status || "Not synced yet.")}</p>
    </form>`,
  );
}

function renderSupabaseSyncPanel() {
  const config = getSupabaseSyncConfig();
  const hasShippedConfig = Boolean(SHIPPED_SUPABASE_CONFIG.url && SHIPPED_SUPABASE_CONFIG.anonKey);
  return panel(
    "Supabase Backend",
    `<form id="supabase-sync-form" class="form-grid">
      <label class="checkbox-label full"><input name="enabled" type="checkbox" ${config.enabled ? "checked" : ""}> Use Supabase as shared backend</label>
      <label class="full">Project URL<input name="url" value="${escapeHtml(config.url)}" placeholder="https://your-project.supabase.co"></label>
      <label class="full">Anon key<input name="anonKey" type="password" placeholder="${config.anonKey ? "Anon key configured" : "Supabase anon public key"}"></label>
      <label>Edge function<input name="functionName" value="${escapeHtml(config.functionName)}" placeholder="app-state"></label>
      <label>State row id<input name="stateId" value="${escapeHtml(config.stateId)}" placeholder="main"></label>
      <p class="form-hint full">${hasShippedConfig ? "This site ships with the Supabase URL and public anon key, so every device uses the same backend." : "Add the Supabase URL and public anon key to supabase-config.js to ship them with the site."}</p>
      <button class="primary-btn" type="submit"><i data-lucide="save"></i>Save backend settings</button>
      <button id="supabase-load-now" class="small-btn" type="button"><i data-lucide="download-cloud"></i>Load from Supabase</button>
      <button id="supabase-save-now" class="small-btn" type="button"><i data-lucide="upload-cloud"></i>Save to Supabase</button>
      <p id="supabase-sync-status" class="form-hint full">${escapeHtml(config.status || "Not connected yet.")}</p>
    </form>`,
  );
}

function getSupabaseSyncConfig() {
  const fallback = {
    enabled: Boolean(
      SHIPPED_SUPABASE_CONFIG.enabled &&
        SHIPPED_SUPABASE_CONFIG.url &&
        SHIPPED_SUPABASE_CONFIG.anonKey,
    ),
    url: String(SHIPPED_SUPABASE_CONFIG.url || "").replace(/\/+$/, ""),
    anonKey: String(SHIPPED_SUPABASE_CONFIG.anonKey || ""),
    table: String(SHIPPED_SUPABASE_CONFIG.table || "app_state"),
    functionName: String(SHIPPED_SUPABASE_CONFIG.functionName || "app-state"),
    stateId: String(SHIPPED_SUPABASE_CONFIG.stateId || SUPABASE_STATE_ID),
    status: "",
  };
  try {
    const stored = JSON.parse(localStorage.getItem(SUPABASE_SYNC_KEY)) || {};
    const storedHasBackend =
      Boolean(stored.url || stored.anonKey) ||
      (stored.table && stored.table !== fallback.table) ||
      (stored.stateId && stored.stateId !== fallback.stateId);
    const storedEnabledApplies = storedHasBackend || !fallback.enabled;
    return {
      enabled: typeof stored.enabled === "boolean" && storedEnabledApplies ? stored.enabled : fallback.enabled,
      url: String(stored.url || fallback.url).replace(/\/+$/, ""),
      anonKey: String(stored.anonKey || fallback.anonKey),
      table: String(stored.table || fallback.table),
      functionName: String(stored.functionName || fallback.functionName),
      stateId: String(stored.stateId || fallback.stateId),
      status: String(stored.status || fallback.status),
    };
  } catch {
    return fallback;
  }
}

function setSupabaseSyncConfig(config) {
  localStorage.setItem(SUPABASE_SYNC_KEY, JSON.stringify(config));
}

function handleSaveSupabaseSync(event) {
  event.preventDefault();
  if (currentUser.role !== "Coach") return;
  const existing = getSupabaseSyncConfig();
  const form = new FormData(event.currentTarget);
  const anonKey = String(form.get("anonKey") || "").trim() || existing.anonKey;
  const config = {
    enabled: form.get("enabled") === "on",
    url: String(form.get("url") || "").trim().replace(/\/+$/, "") || existing.url,
    anonKey,
    table: String(form.get("table") || "").trim() || existing.table || "app_state",
    functionName: String(form.get("functionName") || "").trim() || existing.functionName || "app-state",
    stateId: String(form.get("stateId") || "").trim() || existing.stateId || SUPABASE_STATE_ID,
    status: anonKey ? "Supabase backend settings saved." : "Supabase settings saved, but no anon key is configured.",
  };
  setSupabaseSyncConfig(config);
  supabaseClient = null;
  renderSiteManager();
  if (config.enabled && config.url && anonKey) {
    initSupabaseAuth().then(() => loadDbFromSupabase(true));
  }
}

function getGitSyncConfig() {
  const fallback = {
    enabled: false,
    owner: "ftcJTeChmasters",
    repo: "FTC_32722_JTeChmasters_WEB",
    branch: "master",
    path: "data/db.json",
    token: "",
    status: "",
  };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(GIT_SYNC_KEY)) };
  } catch {
    return fallback;
  }
}

function setGitSyncConfig(config) {
  localStorage.setItem(GIT_SYNC_KEY, JSON.stringify(config));
}

function handleSaveGitSync(event) {
  event.preventDefault();
  if (currentUser.role !== "Coach") return;
  const existing = getGitSyncConfig();
  const form = new FormData(event.currentTarget);
  const token = form.get("token").trim() || existing.token;
  const config = {
    enabled: form.get("enabled") === "on",
    owner: form.get("owner").trim(),
    repo: form.get("repo").trim(),
    branch: form.get("branch").trim(),
    path: form.get("path").trim().replace(/^\/+/, ""),
    token,
    status: token ? "Sync settings saved." : "Sync settings saved, but no token is configured.",
  };
  setGitSyncConfig(config);
  renderSiteManager();
  if (config.enabled && token) syncDbToGitHub(true);
}

function handleSaveAbout(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const labels = form.getAll("socialLabel").map((value) => value.trim());
  const urls = form.getAll("socialUrl").map((value) => normalizeUrl(value));
  db.site = {
    ...db.site,
    aboutTitle: form.get("aboutTitle").trim(),
    aboutBody: form.get("aboutBody").trim(),
    socials: labels
      .map((label, index) => ({ label, url: urls[index] }))
      .filter((social) => social.label && social.url),
  };
  saveDb();
  renderPublicSite();
  renderSiteManager();
}

function handleSaveAnnouncement(event) {
  event.preventDefault();
  const rows = Array.from(document.querySelectorAll(".announcement-row"));
  const announcements = rows
    .map((row) => {
      const enabled = row.querySelector(".announcement-enabled")?.checked;
      const type = String(row.querySelector(".announcement-type")?.value || "Update");
      const title = String(row.querySelector(".announcement-title")?.value || "").trim();
      const body = String(row.querySelector(".announcement-body")?.value || "").trim();
      const id = String(row.dataset.rowId || crypto.randomUUID());
      const updatedAt = new Date().toISOString();
      return {
        id,
        enabled: Boolean(enabled),
        type,
        title,
        body,
        updatedAt,
      };
    })
    .filter((announcement) => announcement.enabled || announcement.title || announcement.body);

  db.site = {
    ...db.site,
    announcements,
  };
  saveDb();
  renderPublicSite();
  renderAppAnnouncement();
  renderSiteManager();
}

function addAnnouncementRow() {
  const list = document.querySelector("#announcement-list");
  if (!list) return;
  const rowCount = list.querySelectorAll(".announcement-row").length;
  const newRow = document.createElement("div");
  newRow.innerHTML = renderAnnouncementRow({
    id: `new-${rowCount}`,
    enabled: false,
    type: "Update",
    title: "",
    body: "",
    updatedAt: "",
  }, rowCount);
  const fieldset = newRow.firstElementChild;
  if (fieldset) {
    list.appendChild(fieldset);
    fieldset.querySelector(".remove-announcement")?.addEventListener("click", removeAnnouncementRow);
  }
}

function removeAnnouncementRow(event) {
  const row = event.currentTarget.closest(".announcement-row");
  row?.remove();
}

function handlePublishPost(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const url = normalizeUrl(form.get("url"));
  db.publicPosts.unshift({
    id: crypto.randomUUID(),
    type: form.get("type"),
    title: form.get("title").trim(),
    body: form.get("body").trim(),
    url,
    urlLabel: form.get("urlLabel").trim() || (url ? "Open link" : ""),
    authorId: currentUser.id,
    publishedAt: new Date().toISOString(),
  });
  saveDb();
  renderPublicSite();
  renderSiteManager();
}

function renderPostManagerList() {
  if (!db.publicPosts.length) return `<div class="empty-state">No public posts yet.</div>`;
  return `<ul class="list">${db.publicPosts
    .map((post) => {
      const author = db.users.find((user) => user.id === post.authorId);
      return `
        <li class="list-item">
          <header>
            <strong>${escapeHtml(post.title)}</strong>
            <span class="badge">${escapeHtml(post.type)}</span>
          </header>
          <p>${escapeHtml(post.body)}</p>
          <small class="muted">By ${escapeHtml(author?.name || "Former member")} - ${formatDate(post.publishedAt)}</small>
          ${
            post.url
              ? `<a href="${escapeHtml(post.url)}" target="_blank" rel="noreferrer">${escapeHtml(post.urlLabel || post.url)}</a>`
              : ""
          }
          ${
            canDeletePost(post)
              ? `<div class="toolbar"><button class="danger-btn delete-post" data-post="${post.id}"><i data-lucide="trash-2"></i>Delete</button></div>`
              : ""
          }
        </li>
      `;
    })
    .join("")}</ul>`;
}

function renderPublicSite() {
  const announcement = document.querySelector("#public-announcement");
  const aboutSummary = document.querySelector("#public-about-summary");
  const socialLinks = document.querySelector("#public-social-links");
  const about = document.querySelector("#public-about");
  const posts = document.querySelector("#public-posts");
  const aboutPageTitle = document.querySelector("#about-page-title");
  const blogArticle = document.querySelector("#blog-article");
  if (!announcement && !aboutSummary && !socialLinks && !about && !posts && !aboutPageTitle && !blogArticle) return;

  if (announcement) renderAnnouncementsBanner(announcement);
  if (aboutPageTitle) aboutPageTitle.textContent = db.site.aboutTitle;
  if (aboutSummary) aboutSummary.textContent = db.site.aboutBody;
  if (socialLinks) {
    socialLinks.innerHTML = db.site.socials
      .map(
        (social) =>
          `<a class="social-link" href="${escapeHtml(social.url)}" target="_blank" rel="noreferrer">${escapeHtml(social.label)}</a>`,
      )
      .join("");
  }
  if (about) {
    about.innerHTML = `
      <div>
        <p class="eyebrow">About Us</p>
        <h2>${escapeHtml(db.site.aboutTitle)}</h2>
      </div>
      <p>${escapeHtml(db.site.aboutBody)}</p>
    `;
  }
  if (posts) {
    posts.innerHTML = renderPublicPostsPage(posts.classList.contains("public-grid-page"));
  }
  if (blogArticle) {
    blogArticle.innerHTML = renderBlogArticle();
  }
}

function renderAnnouncementsBanner(container) {
  const announcements = Array.isArray(db.site.announcements) ? db.site.announcements : [];
  const visibleAnnouncements = announcements.filter(
    (announcement) =>
      announcement.enabled &&
      Boolean(String(announcement.title || announcement.body || "").trim()),
  );

  const isApp = container.id === "app-announcement";
  container.className = isApp ? "public-announcement app-announcement hidden" : "public-announcement hidden";
  container.innerHTML = "";
  if (!visibleAnnouncements.length) return;

  container.classList.remove("hidden");
  container.innerHTML = visibleAnnouncements
    .map((announcement, index) => {
      const type = String(announcement.type || "Update");
      const normalizedType = type.toLowerCase();
      const id = announcement.id || announcement.updatedAt || `${type}:${announcement.title}:${announcement.body}:${index}`;
      const dismissKey = `announcement-dismissed:${container.id}:${id}`;
      if (sessionStorage.getItem(dismissKey)) return "";

      return `
        <div class="announcement-instance public-announcement-${normalizedType}" data-announcement-id="${escapeHtml(
          id,
        )}">
          <div class="announcement-content">
            <div class="announcement-left">
              <span class="announcement-type">${escapeHtml(type)}</span>
            </div>
            <div class="announcement-main">
              ${announcement.title ? `<strong>${escapeHtml(announcement.title)}</strong>` : ""}
              ${announcement.body ? `<p>${escapeHtml(announcement.body)}</p>` : ""}
            </div>
            <button type="button" class="announcement-close" aria-label="Dismiss announcement">&times;</button>
          </div>
        </div>
      `;
    })
    .join("");

  container.querySelectorAll(".announcement-close").forEach((button) => {
    button.addEventListener("click", () => {
      const instance = button.closest(".announcement-instance");
      const announcementId = instance?.dataset.announcementId;
      if (announcementId) {
        sessionStorage.setItem(`announcement-dismissed:${container.id}:${announcementId}`, "1");
      }
      instance?.classList.add("hidden");
    });
  });
}

function renderAppAnnouncement() {
  const announcement = document.querySelector("#app-announcement");
  if (!announcement) return;
  renderAnnouncementsBanner(announcement);
}

function renderPublicPostsPage(grouped = false) {
  if (!db.publicPosts.length) return `<div class="empty-state">No public posts yet.</div>`;
  if (!grouped) {
    return db.publicPosts.map((post, index) => renderPublicPostCard(post, index === 0)).join("");
  }
  const blogs = db.publicPosts.filter((post) => post.type === "Blog");
  const updates = db.publicPosts.filter((post) => post.type !== "Blog");
  return `
    <div class="post-section post-section-featured">
      <div class="section-heading">
        <p class="eyebrow">Articles</p>
        <h2>Progress Blogs</h2>
      </div>
      <div class="blog-preview-grid">
        ${
          blogs.map((post, index) => renderPublicPostCard(post, index === 0)).join("") ||
          `<div class="empty-state">No long-form blog posts yet.</div>`
        }
      </div>
    </div>
    <div class="post-section">
      <div class="section-heading">
        <p class="eyebrow">Short Notes</p>
        <h2>Updates</h2>
      </div>
      <div class="update-list">
        ${
          updates.map((post) => renderUpdateCard(post)).join("") ||
          `<div class="empty-state">No quick updates yet.</div>`
        }
      </div>
    </div>
  `;
}

function renderPublicPostCard(post, featured = false) {
  const author = db.users.find((user) => user.id === post.authorId);
  const isBlog = post.type === "Blog";
  return `
    <article class="post-card ${featured ? "featured" : ""}">
      <span class="badge">${escapeHtml(post.type)}</span>
      <h${featured ? "2" : "3"}>${escapeHtml(post.title)}</h${featured ? "2" : "3"}>
      <p>${escapeHtml(isBlog ? blogPreview(post.body) : post.body)}</p>
      <small>${escapeHtml(author?.name || "JTeChmasters")} - ${formatDate(post.publishedAt)}</small>
      ${isBlog ? `<a href="${blogPostHref(post)}">Read article</a>` : ""}
      ${
        post.url && !isBlog
          ? `<a href="${escapeHtml(post.url)}" target="_blank" rel="noreferrer">${escapeHtml(post.urlLabel || post.url)}</a>`
          : ""
      }
    </article>
  `;
}

function renderUpdateCard(post) {
  const author = db.users.find((user) => user.id === post.authorId);
  return `
    <article class="update-card">
      <div>
        <span class="badge">${escapeHtml(post.type)}</span>
        <h3>${escapeHtml(post.title)}</h3>
      </div>
      <p>${escapeHtml(shortUpdate(post.body))}</p>
      <small>${escapeHtml(author?.name || "JTeChmasters")} - ${formatDate(post.publishedAt)}</small>
      ${
        post.url
          ? `<a href="${escapeHtml(post.url)}" target="_blank" rel="noreferrer">${escapeHtml(post.urlLabel || post.url)}</a>`
          : ""
      }
    </article>
  `;
}

function renderBlogArticle() {
  const postId = new URLSearchParams(window.location.search).get("id");
  const post = db.publicPosts.find((item) => item.id === postId && item.type === "Blog");
  if (!post) {
    return `
      <div class="empty-state">
        Blog post not found. <a href="../">Back to blogs</a>
      </div>
    `;
  }
  const author = db.users.find((user) => user.id === post.authorId);
  document.title = `${post.title} | JTeChmasters`;
  return `
    <a class="back-link" href="../"><i data-lucide="arrow-left"></i>Back to blogs</a>
    <header class="blog-article-header">
      <span class="badge">Blog</span>
      <h1>${escapeHtml(post.title)}</h1>
      <p class="muted">By ${escapeHtml(author?.name || "JTeChmasters")} - ${formatDate(post.publishedAt)}</p>
    </header>
    <div class="blog-article-body">
      ${escapeHtml(post.body)
        .split(/\n{2,}/)
        .map((paragraph) => `<p>${paragraph.replaceAll("\n", "<br>")}</p>`)
        .join("")}
    </div>
    ${
      post.url
        ? `<a class="primary-btn article-link" href="${escapeHtml(post.url)}" target="_blank" rel="noreferrer">${escapeHtml(post.urlLabel || "Open related link")}</a>`
        : ""
    }
  `;
}

function canDeletePost(post) {
  return currentUser.role === "Coach" || post.authorId === currentUser.id;
}

function changeScore(member, delta, note, options = {}) {
  const previousScore = Number(member.score);
  const nextScore = clampScore(previousScore + delta);
  member.score = nextScore;
  const entry = logEntry(
    options.type || "score-change",
    note,
    delta,
    previousScore,
    nextScore,
    options,
  );
  member.activityLog.push(entry);
  scheduleAuthProfileSave(member);
  return entry;
}

function clampScore(score) {
  return Math.min(MAX_SCORE, Number(score.toFixed(3)));
}

function logEntry(type, note, delta, previousScore, newScore, options = {}) {
  return {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    actorId: currentUser?.id || "system",
    type,
    note,
    delta,
    previousScore,
    newScore,
    meetingId: options.meetingId || null,
    eventDate: options.eventDate || null,
    reversible: Boolean(options.reversible),
    reversed: false,
  };
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function panel(title, body) {
  return `<section class="panel"><h3>${title}</h3>${body}</section>`;
}

function statCard(title, value, caption) {
  return `<section class="panel stat"><span class="section-label">${title}</span><strong>${value}</strong><p class="muted">${caption}</p></section>`;
}

function scorePill(score) {
  const className = score < WARNING_THRESHOLD ? "low" : score < 2 ? "warn" : "high";
  return `<span class="score ${className}">${Number(score).toFixed(3).replace(/\.?0+$/, "")}</span>`;
}

function renderMemberMiniList(members) {
  if (!members.length) return `<div class="empty-state">No score warnings.</div>`;
  return `<ul class="list">${members
    .map(
      (member) =>
        `<li class="list-item"><header><strong>${escapeHtml(member.name)}</strong>${scorePill(member.score)}</header><span class="muted">${member.section}</span></li>`,
    )
    .join("")}</ul>`;
}

function renderMeetingList(meetings) {
  if (!meetings.length) return `<div class="empty-state">No upcoming meetings.</div>`;
  return `<ul class="list">${meetings
    .map(
      (meeting) =>
        `<li class="list-item"><header><strong>${escapeHtml(meeting.title)}</strong><span class="badge">${meetingScopeLabel(meeting)}</span></header><span class="muted">${formatDate(meeting.startsAt)}</span></li>`,
    )
    .join("")}</ul>`;
}

function renderActivityFeed(members) {
  const entries = members
    .flatMap((member) =>
      member.activityLog.map((entry) => ({
        ...entry,
        memberName: member.name,
      })),
    )
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 10);
  if (!entries.length) return `<div class="empty-state">No activity yet.</div>`;
  return `<ul class="list">${entries
    .map(
      (entry) =>
        `<li class="list-item"><header><strong>${escapeHtml(entry.memberName)}</strong><span class="badge">${formatDelta(entry.delta)}</span></header><span>${escapeHtml(entry.note)}</span><small class="muted">${formatDate(entry.at)}${entry.reversed ? " - reversed" : ""}</small></li>`,
    )
    .join("")}</ul>`;
}

function renderActivityList(entries, compact = false) {
  if (!entries.length) return `<span class="muted">No activity.</span>`;
  const ordered = entries.slice().reverse();
  return `<ul class="list">${ordered
    .map(
      (entry) =>
        `<li class="${compact ? "" : "list-item"}"><span>${escapeHtml(entry.note)}</span><br><small class="muted">${formatDate(entry.at)} - ${formatDelta(entry.delta)}${entry.reversed ? " - reversed" : ""}</small></li>`,
    )
    .join("")}</ul>`;
}

function renderMessageList(messages) {
  if (!messages.length) return `<div class="empty-state">No messages yet.</div>`;
  return messages
    .map((message) => {
      const sender = db.users.find((user) => user.id === message.fromId);
      const audienceLabel = messageAudienceLabel(message);
      return `<div class="message ${message.fromId === currentUser.id ? "mine" : ""}">
        <strong>${escapeHtml(sender?.name || "Unknown")} to ${escapeHtml(audienceLabel)}</strong>
        <p>${escapeHtml(message.body)}</p>
        <small>${formatDate(message.at)}</small>
      </div>`;
    })
    .join("");
}

function messageAudienceLabel(message) {
  const audience = message.audience || { type: "user", userId: message.toId };
  if (audience.type === "team") return "Whole team";
  if (audience.type === "section") return `${audience.section} section`;
  if (audience.type === "subsection") return `${audience.section} / ${audience.subsection}`;
  const receiver = db.users.find((user) => user.id === audience.userId);
  return receiver?.name || "Unknown";
}

function firstSubsection(sectionName) {
  return sectionDefinitions.find((section) => section.name === sectionName)?.subsections[0] || "All";
}

function subsectionOptions(sectionName, includeAll = false) {
  const options = sectionDefinitions.find((section) => section.name === sectionName)?.subsections || [];
  return `${includeAll ? `<option>All</option>` : ""}${options
    .map((subsection) => `<option>${escapeHtml(subsection)}</option>`)
    .join("")}`;
}

function meetingScopeLabel(meeting) {
  if (meeting.scope === "Global") return "Full team";
  if (!meeting.subsection || meeting.subsection === "All") return escapeHtml(meeting.scope);
  return `${escapeHtml(meeting.scope)} - ${escapeHtml(meeting.subsection)}`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatDelta(delta) {
  const value = Number(delta);
  if (value === 0) return "0";
  return `${value > 0 ? "+" : ""}${value}`;
}

function scheduleSupabaseAutosave() {
  const config = getSupabaseSyncConfig();
  if (supabaseLocked || !supabaseInitialLoadDone || !config.enabled || !config.url || !config.anonKey) return;
  clearTimeout(supabaseAutosaveTimer);
  supabaseAutosaveTimer = setTimeout(() => saveDbToSupabase(false), 1000);
}

function scheduleSupabaseRefresh() {
  // Automatic periodic refresh is disabled in favor of server-driven ping updates.
  return;
}

async function loadDbFromSupabase(manual = false) {
  const config = getSupabaseSyncConfig();
  if (!config.enabled && !manual) return;
  if (!isSupabaseConfigured(config)) {
    updateSupabaseStatus("Supabase is missing a project URL or anon key.");
    scheduleSupabaseRefresh();
    return;
  }
  if (supabaseRemoteBusy) {
    scheduleSupabaseRefresh();
    return;
  }
  supabaseRemoteBusy = true;
  updateSupabaseStatus("Loading data from Supabase...");
  try {
    const response = await safeFetch(`${supabaseFunctionUrl(config)}?id=${encodeURIComponent(config.stateId)}`, {
      headers: supabaseHeaders(),
    });
    if (response.status === 404) {
      updateSupabaseStatus("No Supabase row found yet. Use Save to Supabase once.");
      supabaseInitialLoadDone = true;
      return;
    }
    if (!response.ok) showAlert(`Supabase load failed: ${response.status}`);
    const payload = await response.json();
    supabaseLastKnownUpdatedAt = payload.updatedAt || supabaseLastKnownUpdatedAt;
    if (!payload.data) {
      db.users = Array.isArray(payload.users) ? payload.users.map(normalizeAuthUserProfile) : [];
      authUsersLoaded = Boolean(db.users.length);
      supabaseInitialLoadDone = true;
      supabaseLocked = false;
      startSupabasePing();
      updateSupabaseStatus(
        payload.usersError
          ? `Loaded app data, but Supabase Auth users could not be loaded: ${payload.usersError}`
          : "No Supabase data found yet. Use Save to Supabase once.",
      );
      return;
    }
    const newDb = migrateDb(payload.data);
    newDb.users = Array.isArray(payload.users) ? payload.users.map(normalizeAuthUserProfile) : db.users;
    authUsersLoaded = Array.isArray(payload.users) && !payload.usersError;
    const dbChanged = JSON.stringify(db) !== JSON.stringify(newDb);
    db = newDb;
    currentUser = getSessionUser();
    // Only re-render if data actually changed or this is a manual load
    if (manual || dbChanged) {
      renderPublicSite();
      if (currentUser && viewRoot && viewTitle) render();
    }
    supabaseInitialLoadDone = true;
    supabaseLocked = false;
    startSupabasePing();
    updateSupabaseStatus(
      payload.usersError
        ? `Loaded app data, but Supabase Auth users could not be loaded: ${payload.usersError}`
        : `Loaded from Supabase ${formatDate(new Date().toISOString())}.`,
    );
  } catch (error) {
    supabaseInitialLoadDone = true;
    updateSupabaseStatus(error.message || "Supabase load failed.");
  } finally {
    supabaseRemoteBusy = false;
    scheduleSupabaseRefresh();
  }
}

async function saveDbToSupabase(manual = false) {
  const config = getSupabaseSyncConfig();
  if (!config.enabled && !manual) return;
  if (!isSupabaseConfigured(config)) {
    updateSupabaseStatus("Supabase is missing a project URL or anon key.");
    return;
  }
  if (supabaseLocked && !manual) return;
  if (supabaseRemoteBusy) {
    scheduleSupabaseAutosave();
    return;
  }
  supabaseRemoteBusy = true;
  updateSupabaseStatus("Saving data to Supabase...");
  try {
    const response = await safeFetch(supabaseFunctionUrl(config), {
      method: "POST",
      headers: {
        ...supabaseHeaders(),
        "x-state-id": config.stateId,
        ...(hasBackupAccess() ? { "x-backup-pin-hash": getBackupPinHash() } : {}),
      },
      body: JSON.stringify({
        data: appStateForSupabaseSave(),
        ...(hasBackupAccess() ? { backupPinHash: getBackupPinHash() } : {}),
      }),
    });
    if (!response.ok) showAlert(`Supabase save failed: ${response.status}`);
    supabaseInitialLoadDone = true;
    supabaseLocked = false;
    startSupabasePing();
    updateSupabaseStatus(`Saved to Supabase ${formatDate(new Date().toISOString())}.`);
  } catch (error) {
    updateSupabaseStatus(error.message || "Supabase save failed.");
  } finally {
    supabaseRemoteBusy = false;
    scheduleSupabaseRefresh();
  }
}

function saveDbLocalOnly() {
  // App state is remote-first; users come from Supabase Auth and are not cached locally.
}

function appStateForSupabaseSave() {
  const { users: _users, ...state } = db;
  return state;
}

function isSupabaseConfigured(config) {
  return Boolean(config.url && config.anonKey && config.functionName && config.stateId);
}

function supabaseFunctionUrl(config) {
  return `${config.url}/functions/v1/${encodeURIComponent(config.functionName)}`;
}

function supabaseHeaders(accessToken = null) {
  const config = getSupabaseSyncConfig();
  const token = accessToken || getAuthSession()?.access_token || config.anonKey;
  return {
    apikey: config.anonKey,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function updateSupabaseStatus(status) {
  const config = getSupabaseSyncConfig();
  setSupabaseSyncConfig({ ...config, status });
  const statusNode = document.querySelector("#supabase-sync-status");
  if (statusNode) statusNode.textContent = status;
}

function scheduleGitAutosave() {
  const config = getGitSyncConfig();
  if (!config.enabled || !config.token) return;
  clearTimeout(gitAutosaveTimer);
  gitAutosaveTimer = setTimeout(() => syncDbToGitHub(false), 1800);
}

async function syncDbToGitHub(manual = false) {
  const config = getGitSyncConfig();
  if (!config.enabled && !manual) return;
  if (!config.token || !config.owner || !config.repo || !config.branch || !config.path) {
    updateGitSyncStatus("Git autosave is missing a token or repository setting.");
    return;
  }
  if (gitAutosaveBusy) {
    scheduleGitAutosave();
    return;
  }
  gitAutosaveBusy = true;
  updateGitSyncStatus("Syncing app data to GitHub...");
  try {
    const apiUrl = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${config.path}`;
    const current = await safeFetch(`${apiUrl}?ref=${encodeURIComponent(config.branch)}`, {
      headers: githubHeaders(config.token),
    });
    let sha = null;
    if (current.ok) {
      const file = await current.json();
      sha = file.sha;
    } else if (current.status !== 404) {
      showAlert(`GitHub read failed: ${current.status}`);
    }

    const response = await safeFetch(apiUrl, {
      method: "PUT",
      headers: githubHeaders(config.token),
      body: JSON.stringify({
        message: `Autosave app data ${new Date().toISOString()}`,
        content: base64Encode(JSON.stringify(appStateForSupabaseSave(), null, 2)),
        branch: config.branch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!response.ok) showAlert(`GitHub write failed: ${response.status}`);
    updateGitSyncStatus(`Last synced ${formatDate(new Date().toISOString())}.`);
  } catch (error) {
    updateGitSyncStatus(error.message || "Git autosave failed.");
  } finally {
    gitAutosaveBusy = false;
  }
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function updateGitSyncStatus(status) {
  const config = getGitSyncConfig();
  setGitSyncConfig({ ...config, status });
  const statusNode = document.querySelector("#git-sync-status");
  if (statusNode) statusNode.textContent = status;
}

function base64Encode(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function normalizeUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function blogPostHref(post) {
  const inBlogsSection = window.location.pathname.includes("/blogs/");
  const base = inBlogsSection ? "post/" : "blogs/post/";
  return `${base}?id=${encodeURIComponent(post.id)}`;
}

function blogPreview(body) {
  const normalized = String(body || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= 190) return normalized;
  return `${normalized.slice(0, 187).trim()}...`;
}

function shortUpdate(body) {
  const lines = String(body || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 3) return lines.slice(0, 3).join(" ");
  const normalized = lines.join(" ") || String(body || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= 260) return normalized;
  return `${normalized.slice(0, 257).trim()}...`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function handlePasswordChange(member, isOwnPassword = false) {
  if (!member) return false;
  if (!isOwnPassword && currentUser.role !== "Coach") return false;

  const password = await showPrompt(
    `Set a new temporary password for ${member.email}. It must be at least 6 characters.`,
    "",
    "Set Password",
    "password",
  );
  if (!password) return false;
  if (password.length < 6) {
    await showAlert("Temporary password must be at least 6 characters.", "Password Too Short");
    return false;
  }

  try {
    if (isOwnPassword) {
      await updateOwnSupabasePassword(member, password);
      await signInWithSupabaseAuth(member.email, password);
      member.needsPasswordChange = false;
      member.activityLog.push(
        logEntry("password", "Password changed on first sign-in.", 0, member.score, member.score),
      );
      await loadDbFromSupabase(true);
      await loadAuthUsersFromSupabase(true);
      currentUser = getSessionUser();
      showAuthState();
      await showAlert("Your password has been updated.", "Password Updated");
      return true;
    }

    const profileForPasswordChange = {
      ...member,
      needsPasswordChange: !isOwnPassword,
    };
    const result = await callSupabaseAuthAction("set-auth-password", {
      profile: profileForPasswordChange,
      password,
    });
    if (result.authUserId && member.authUserId !== result.authUserId) {
      member.authUserId = result.authUserId;
      member.id = result.authUserId;
    }
    member.needsPasswordChange = !isOwnPassword;
    member.activityLog.push(
      logEntry(
        "password",
        isOwnPassword ? "Password changed on first sign-in." : "Temporary Supabase password was reset by a coach.",
        0,
        member.score,
        member.score,
      ),
    );
    saveDb();
    if (isOwnPassword) {
      await signInWithSupabaseAuth(member.email, password);
      await loadDbFromSupabase(true);
      await loadAuthUsersFromSupabase(true);
      currentUser = getSessionUser();
      showAuthState();
    } else {
      await loadAuthUsersFromSupabase(true);
      if (currentView === "members") renderMembers();
    }
    await showAlert(
      result.created
        ? `Supabase Auth user created and temporary password set for ${member.email}.`
        : isOwnPassword
        ? "Your password has been updated."
        : `Temporary password updated for ${member.email}.`,
      result.created ? "Auth User Created" : "Password Updated",
    );
    return true;
  } catch (error) {
    await showAlert(error.message || "Could not update the Supabase password.", "Supabase Auth");
    return false;
  }
}
