"use strict";

const STORAGE_KEY = "robotics-attendance-hub-v1";
const SESSION_KEY = "robotics-attendance-session";
const MAX_SCORE = 7;
const START_SCORE = 2;
const WARNING_THRESHOLD = 0;

const attendanceActions = {
  present: { label: "Showed up", delta: 0.5 },
  excused: { label: "Excused absence", delta: -0.5 },
  absent: { label: "No show", delta: -1 },
};

const OUTSIDE_MEETING_DELTA = 0.025;

const sections = ["Engineering", "Media", "Marketing and Communications"];

const seedUsers = [
  {
    id: "u-coach",
    name: "Morgan Coach",
    email: "coach@team.local",
    password: "demo123",
    role: "Coach",
    section: "All",
    score: MAX_SCORE,
  },
  {
    id: "u-eng-head",
    name: "Sam Engineering",
    email: "engineering@team.local",
    password: "demo123",
    role: "Section Head",
    section: "Engineering",
    score: START_SCORE,
  },
  {
    id: "u-media-head",
    name: "Riley Media",
    email: "media@team.local",
    password: "demo123",
    role: "Section Head",
    section: "Media",
    score: START_SCORE,
  },
  {
    id: "u-alex",
    name: "Alex Vermeer",
    email: "alex@team.local",
    password: "demo123",
    role: "Member",
    section: "Engineering",
    score: START_SCORE,
  },
  {
    id: "u-nova",
    name: "Nova Jansen",
    email: "nova@team.local",
    password: "demo123",
    role: "Member",
    section: "Media",
    score: START_SCORE,
  },
  {
    id: "u-lee",
    name: "Lee Bakker",
    email: "lee@team.local",
    password: "demo123",
    role: "Member",
    section: "Marketing and Communications",
    score: START_SCORE,
  },
];

const defaultDb = () => {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(18, 30, 0, 0);
  const weekend = new Date(now);
  weekend.setDate(now.getDate() + 4);
  weekend.setHours(10, 0, 0, 0);

  return {
    users: seedUsers.map((user) => ({
      ...user,
      activityLog: [
        {
          id: crypto.randomUUID(),
          at: now.toISOString(),
          actorId: "system",
          type: "created",
          note: `Initial score set to ${user.score}.`,
          delta: 0,
          previousScore: user.score,
          newScore: user.score,
          reversible: false,
          reversed: false,
        },
      ],
      portfolio: [],
    })),
    meetings: [
      {
        id: crypto.randomUUID(),
        title: "Engineering Drivebase Review",
        startsAt: tomorrow.toISOString(),
        scope: "Engineering",
        createdBy: "u-eng-head",
        attendance: {},
        applied: false,
        reversed: false,
        scoreChanges: [],
      },
      {
        id: crypto.randomUUID(),
        title: "Full Team Scrimmage Prep",
        startsAt: weekend.toISOString(),
        scope: "Global",
        createdBy: "u-coach",
        attendance: {},
        applied: false,
        reversed: false,
        scoreChanges: [],
      },
    ],
    messages: [
      {
        id: crypto.randomUUID(),
        fromId: "u-coach",
        toId: "u-alex",
        at: now.toISOString(),
        body: "Bring the latest CAD notes to the next engineering review.",
        read: false,
      },
    ],
  };
};

let db = loadDb();
let currentUser = getSessionUser();
let currentView = "dashboard";

const viewRoot = document.querySelector("#view-root");
const viewTitle = document.querySelector("#view-title");

document.addEventListener("DOMContentLoaded", () => {
  wireLogin();
  wireChrome();
  showAuthState();
});

function loadDb() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const fresh = defaultDb();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
    return fresh;
  }
  try {
    return JSON.parse(raw);
  } catch {
    const fresh = defaultDb();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
    return fresh;
  }
}

function saveDb() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
}

function getSessionUser() {
  const id = sessionStorage.getItem(SESSION_KEY);
  return db.users.find((user) => user.id === id) || null;
}

function setSession(user) {
  currentUser = user;
  if (user) sessionStorage.setItem(SESSION_KEY, user.id);
  else sessionStorage.removeItem(SESSION_KEY);
}

function wireLogin() {
  document.querySelector("#login-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const email = document.querySelector("#login-email").value.trim().toLowerCase();
    const password = document.querySelector("#login-password").value;
    const user = db.users.find(
      (candidate) => candidate.email.toLowerCase() === email && candidate.password === password,
    );
    if (!user) {
      document.querySelector("#login-error").textContent = "Email or password is incorrect.";
      return;
    }
    setSession(user);
    document.querySelector("#login-error").textContent = "";
    showAuthState();
  });

  document.querySelectorAll("[data-login]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelector("#login-email").value = button.dataset.login;
      document.querySelector("#login-password").value = "demo123";
    });
  });
}

function wireChrome() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => {
      currentView = button.dataset.view;
      render();
    });
  });

  document.querySelector("#logout").addEventListener("click", () => {
    setSession(null);
    showAuthState();
  });

  document.querySelector("#reset-demo").addEventListener("click", () => {
    db = defaultDb();
    saveDb();
    setSession(null);
    showAuthState();
  });
}

function showAuthState() {
  const isLoggedIn = Boolean(currentUser);
  document.querySelector("#login-screen").classList.toggle("hidden", isLoggedIn);
  document.querySelector("#app").classList.toggle("hidden", !isLoggedIn);
  if (isLoggedIn) {
    document.querySelector("#user-name").textContent = currentUser.name;
    document.querySelector("#role-label").textContent =
      currentUser.role === "Coach" ? "Coach access" : `${currentUser.role} - ${currentUser.section}`;
    render();
  }
  refreshIcons();
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function render() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === currentView);
  });
  const titles = {
    dashboard: "Dashboard",
    members: "Members",
    meetings: "Meetings",
    agenda: "Agenda",
    messages: "Messages",
    portfolio: "Portfolio",
  };
  viewTitle.textContent = titles[currentView];
  const renderers = {
    dashboard: renderDashboard,
    members: renderMembers,
    meetings: renderMeetings,
    agenda: renderAgenda,
    messages: renderMessages,
    portfolio: renderPortfolio,
  };
  renderers[currentView]();
  refreshIcons();
}

function visibleMembers() {
  if (currentUser.role === "Coach") return db.users;
  if (currentUser.role === "Section Head") {
    return db.users.filter((user) => user.section === currentUser.section);
  }
  return db.users.filter((user) => user.id === currentUser.id);
}

function editableMembers() {
  if (currentUser.role === "Coach") return db.users;
  if (currentUser.role === "Section Head") {
    return db.users.filter((user) => user.section === currentUser.section);
  }
  return [];
}

function canManageMember(member) {
  if (currentUser.role === "Coach") return true;
  return currentUser.role === "Section Head" && member.section === currentUser.section;
}

function canManageMeeting(meeting) {
  if (currentUser.role === "Coach") return true;
  return currentUser.role === "Section Head" && meeting.scope === currentUser.section;
}

function meetingMembers(meeting) {
  if (meeting.scope === "Global") return db.users.filter((user) => user.role !== "Coach");
  return db.users.filter((user) => user.section === meeting.scope);
}

function renderDashboard() {
  const members = visibleMembers();
  const myMessages = db.messages.filter((msg) => msg.toId === currentUser.id);
  const upcoming = getVisibleMeetings()
    .filter((meeting) => new Date(meeting.startsAt) >= new Date())
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))
    .slice(0, 4);
  const warnings = members.filter((member) => member.score < WARNING_THRESHOLD);

  if (currentUser.role === "Member") {
    const user = db.users.find((member) => member.id === currentUser.id);
    viewRoot.innerHTML = `
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
    ${panel("Recent Activity", renderActivityFeed(members))}
  `;
}

function renderMembers() {
  const members = visibleMembers();
  const editable = editableMembers();
  const filterOptions =
    currentUser.role === "Coach"
      ? `<label>Section<select id="member-section-filter"><option value="All">All sections</option>${sections
          .map((section) => `<option value="${section}">${section}</option>`)
          .join("")}</select></label>`
      : "";

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
              <label>Section<select name="section">${sections.map((s) => `<option>${s}</option>`).join("")}</select></label>
              <label>Password<input name="password" value="demo123" required></label>
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
      selected === "All" ? members : members.filter((member) => member.section === selected);
    document.querySelector("#member-table").innerHTML = renderMembersTable(filtered, editable);
    wireMemberTable();
    refreshIcons();
  };

  document.querySelector("#member-section-filter")?.addEventListener("change", renderTable);
  document.querySelector("#member-form")?.addEventListener("submit", handleCreateUser);
  renderTable();
}

function renderMembersTable(members, editable) {
  if (!members.length) return `<div class="empty-state">No members match this filter.</div>`;
  const rows = members
    .map((member) => {
      const canEdit = editable.some((item) => item.id === member.id);
      return `
        <tr>
          <td><strong>${escapeHtml(member.name)}</strong><br><span class="muted">${escapeHtml(member.email)}</span></td>
          <td>${member.role}</td>
          <td><span class="badge">${member.section}</span></td>
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
                          <button class="danger-btn remove-member" data-member="${member.id}"><i data-lucide="trash-2"></i>Remove</button>`
                        : ""
                    }
                  </div>`
                : `<span class="muted">View only</span>`
            }
          </td>
          <td>${renderActivityList(member.activityLog.slice(-3), true)}</td>
        </tr>
      `;
    })
    .join("");
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Role</th><th>Section</th><th>Score</th><th>Correction</th><th>Latest Activity</th></tr></thead>
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

  document.querySelectorAll(".remove-member").forEach((button) => {
    button.addEventListener("click", () => {
      if (currentUser.role !== "Coach") return;
      const member = db.users.find((user) => user.id === button.dataset.member);
      if (!member || member.id === currentUser.id) return;
      const confirmed = window.confirm(
        `Remove ${member.name}? Their meetings, messages, logs, and portfolio entries will be deleted from this local app.`,
      );
      if (!confirmed) return;
      removeMember(member.id);
      saveDb();
      renderMembers();
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
}

function handleCreateUser(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const role = form.get("role");
  const section = role === "Coach" ? "All" : form.get("section");
  const score = clampScore(Number(form.get("score")));
  const user = {
    id: crypto.randomUUID(),
    name: form.get("name").trim(),
    email: form.get("email").trim(),
    password: form.get("password"),
    role,
    section,
    score,
    portfolio: [],
    activityLog: [],
  };
  user.activityLog.push(logEntry("created", `User created with score ${score}.`, 0, score, score));
  db.users.push(user);
  saveDb();
  event.currentTarget.reset();
  renderMembers();
}

function removeMember(memberId) {
  db.users = db.users.filter((user) => user.id !== memberId);
  db.messages = db.messages.filter((message) => message.fromId !== memberId && message.toId !== memberId);
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
              <button class="primary-btn full" type="submit"><i data-lucide="calendar-plus"></i>Create meeting</button>
            </form>`,
          )
        : ""
    }
    <div class="grid">${meetings.map(renderMeetingCard).join("") || `<div class="empty-state">No meetings in your scope yet.</div>`}</div>
  `;

  document.querySelector("#meeting-form")?.addEventListener("submit", handleCreateMeeting);
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

function handleCreateMeeting(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const scope = currentUser.role === "Section Head" ? currentUser.section : form.get("scope");
  db.meetings.push({
    id: crypto.randomUUID(),
    title: form.get("title").trim(),
    startsAt: new Date(form.get("startsAt")).toISOString(),
    scope,
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
    if (currentUser.role === "Section Head") return member.section === currentUser.section;
    return true;
  });
  const controls = members
    .map((member) => {
      const value = meeting.attendance[member.id] || "";
      return `
        <div class="attendance-row">
          <div><strong>${escapeHtml(member.name)}</strong><br><span class="muted">${member.section} - ${scorePill(member.score)}</span></div>
          <select class="attendance-select" data-meeting="${meeting.id}" data-member="${member.id}" ${meeting.applied || !canManageMeeting(meeting) ? "disabled" : ""}>
            <option value="" ${value === "" ? "selected" : ""}>Not marked</option>
            ${Object.entries(attendanceActions)
              .filter(([, action]) => currentUser.role === "Coach" || !action.coachOnly)
              .map(
                ([key, action]) =>
                  `<option value="${key}" ${value === key ? "selected" : ""}>${action.label} (${formatDelta(action.delta)})</option>`,
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
          <p class="muted">${formatDate(meeting.startsAt)} - <span class="badge">${meeting.scope}</span> ${meeting.applied ? "- Applied" : ""} ${meeting.reversed ? "- Reversed" : ""}</p>
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
      (meeting) => meeting.scope === currentUser.section || meeting.scope === "Global",
    );
  }
  return db.meetings.filter(
    (meeting) => meeting.scope === currentUser.section || meeting.scope === "Global",
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
                <p class="muted">${formatDate(meeting.startsAt)} - ${meeting.scope}</p>
              </div>
            </div>`,
        )
        .join("") || `<div class="empty-state">No timeline items yet.</div>`
    }</div>`,
  );
}

function renderMessages() {
  const visibleUsers =
    currentUser.role === "Coach"
      ? db.users.filter((user) => user.id !== currentUser.id)
      : db.users.filter((user) => user.id !== currentUser.id && (user.role === "Coach" || user.section === currentUser.section));
  const messages = db.messages
    .filter((msg) => msg.toId === currentUser.id || msg.fromId === currentUser.id)
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  viewRoot.innerHTML = `
    <div class="grid two">
      ${panel(
        "Send Message",
        `<form id="message-form" class="form-grid">
          <label>To<select name="toId">${visibleUsers.map((user) => `<option value="${user.id}">${escapeHtml(user.name)} - ${user.role}</option>`).join("")}</select></label>
          <label class="full">Message<textarea name="body" required></textarea></label>
          <button class="primary-btn full" type="submit"><i data-lucide="send"></i>Send</button>
        </form>`,
      )}
      ${panel("Thread", `<div class="list message-thread">${renderMessageList(messages)}</div>`)}
    </div>
  `;
  document.querySelector("#message-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    db.messages.push({
      id: crypto.randomUUID(),
      fromId: currentUser.id,
      toId: form.get("toId"),
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
        `<li class="list-item"><header><strong>${escapeHtml(meeting.title)}</strong><span class="badge">${meeting.scope}</span></header><span class="muted">${formatDate(meeting.startsAt)}</span></li>`,
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
      const receiver = db.users.find((user) => user.id === message.toId);
      return `<div class="message ${message.fromId === currentUser.id ? "mine" : ""}">
        <strong>${escapeHtml(sender?.name || "Unknown")} to ${escapeHtml(receiver?.name || "Unknown")}</strong>
        <p>${escapeHtml(message.body)}</p>
        <small>${formatDate(message.at)}</small>
      </div>`;
    })
    .join("");
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
