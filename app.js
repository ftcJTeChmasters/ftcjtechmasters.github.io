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

const DEFAULT_PASSWORD_HASH = "d3ad9315b7be5dd53b31a273b3b3aba5defe700808305aa16a3062b76658a791";
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

const seedUsers = [
  {
    id: "u-coach",
    name: "Morgan Coach",
    email: "coach@team.local",
    passwordHash: DEFAULT_PASSWORD_HASH,
    role: "Coach",
    section: "All",
    subsection: "All",
    score: MAX_SCORE,
  },
  {
    id: "u-eng-head",
    name: "Sam Engineering",
    email: "engineering@team.local",
    passwordHash: DEFAULT_PASSWORD_HASH,
    role: "Section Head",
    section: "Engineering",
    subsection: "All",
    score: START_SCORE,
  },
  {
    id: "u-media-head",
    name: "Riley Media",
    email: "media@team.local",
    passwordHash: DEFAULT_PASSWORD_HASH,
    role: "Section Head",
    section: "Media",
    subsection: "All",
    score: START_SCORE,
  },
  {
    id: "u-alex",
    name: "Alex Vermeer",
    email: "alex@team.local",
    passwordHash: DEFAULT_PASSWORD_HASH,
    role: "Member",
    section: "Engineering",
    subsection: "Programming",
    score: START_SCORE,
  },
  {
    id: "u-nova",
    name: "Nova Jansen",
    email: "nova@team.local",
    passwordHash: DEFAULT_PASSWORD_HASH,
    role: "Member",
    section: "Media",
    subsection: "Photography",
    score: START_SCORE,
  },
  {
    id: "u-lee",
    name: "Lee Bakker",
    email: "lee@team.local",
    passwordHash: DEFAULT_PASSWORD_HASH,
    role: "Member",
    section: "Marketing and Communications",
    subsection: "Outreach",
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
        subsection: "Programming",
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
        subsection: "All",
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
        audience: { type: "user", userId: "u-alex" },
        at: now.toISOString(),
        body: "Bring the latest CAD notes to the next engineering review.",
        read: false,
      },
    ],
    publicPosts: [
      {
        id: crypto.randomUUID(),
        type: "Update",
        title: "Season planning is underway",
        body: "Engineering, media, and outreach are preparing their first sprint goals for the new FTC season.",
        url: "",
        urlLabel: "",
        authorId: "u-coach",
        publishedAt: now.toISOString(),
      },
      {
        id: crypto.randomUUID(),
        type: "Link",
        title: "Follow us on Instagram",
        body: "Match clips, pit photos, and workshop snapshots will be shared through our team socials.",
        url: "https://www.instagram.com/",
        urlLabel: "Open Instagram",
        authorId: "u-media-head",
        publishedAt: now.toISOString(),
      },
      {
        id: crypto.randomUUID(),
        type: "Blog",
        title: DEFAULT_LONG_BLOG_TITLE,
        body: DEFAULT_LONG_BLOG_BODY,
        url: "",
        urlLabel: "",
        authorId: "u-eng-head",
        publishedAt: now.toISOString(),
      },
    ],
    site: {
      aboutTitle: "About JTeChmasters",
      aboutBody:
        "JTeChmasters is an FTC robotics team building robots, software, media, outreach projects, and match-day confidence together.",
      socials: [
        { label: "Instagram", url: "https://www.instagram.com/" },
        { label: "FIRST FTC", url: "https://www.firstinspires.org/robotics/ftc" },
      ],
    },
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
  renderPublicSite();
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
    const parsed = JSON.parse(raw);
    return migrateDb(parsed);
  } catch {
    const fresh = defaultDb();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
    return fresh;
  }
}

function migrateDb(source) {
  const fresh = defaultDb();
  const next = {
    users: Array.isArray(source.users) ? source.users : fresh.users,
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
  next.users.forEach((user) => {
    if (!user.passwordHash && user.password) {
      user.passwordHash = DEFAULT_PASSWORD_HASH;
      delete user.password;
      changed = true;
    }
    if (!user.subsection) {
      user.subsection = user.role === "Coach" || user.role === "Section Head" ? "All" : firstSubsection(user.section);
      changed = true;
    }
  });
  next.meetings.forEach((meeting) => {
    if (!meeting.subsection) {
      meeting.subsection = "All";
      changed = true;
    }
  });
  if (changed) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
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
    const passwordHash = await hashPassword(password);
    const user = db.users.find(
      (candidate) => candidate.email.toLowerCase() === email && candidate.passwordHash === passwordHash,
    );
    if (!user) {
      document.querySelector("#login-error").textContent = "Email or password is incorrect.";
      return;
    }
    setSession(user);
    document.querySelector("#login-error").textContent = "";
    showAuthState();
  });
}

function wireChrome() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => {
      currentView = button.dataset.view;
      render();
    });
  });

  document.querySelector("#logout")?.addEventListener("click", () => {
    setSession(null);
    showAuthState();
  });

  document.querySelector("#reset-demo")?.addEventListener("click", () => {
    db = defaultDb();
    saveDb();
    setSession(null);
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
      currentUser.role === "Coach"
        ? "Coach access"
        : `${currentUser.role} - ${currentUser.section}${currentUser.subsection && currentUser.subsection !== "All" ? ` / ${currentUser.subsection}` : ""}`;
    render();
  } else {
    renderPublicSite();
  }
  refreshIcons();
}

async function hashPassword(password) {
  const data = new TextEncoder().encode(password);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function render() {
  if (!viewRoot || !viewTitle) return;
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
    site: "Public Site",
  };
  viewTitle.textContent = titles[currentView];
  const renderers = {
    dashboard: renderDashboard,
    members: renderMembers,
    meetings: renderMeetings,
    agenda: renderAgenda,
    messages: renderMessages,
    portfolio: renderPortfolio,
    site: renderSiteManager,
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

function visibleMessagesFor(user) {
  return db.messages.filter((message) => message.fromId === user.id || messageMatchesAudience(message, user));
}

function messageMatchesAudience(message, user) {
  if (Array.isArray(message.recipientIds)) return message.recipientIds.includes(user.id);
  const audience = message.audience || { type: "user", userId: message.toId };
  if (audience.type === "team") return true;
  if (audience.type === "section") return user.section === audience.section || message.fromId === user.id;
  if (audience.type === "subsection") {
    return (
      (user.section === audience.section &&
        (user.subsection === audience.subsection || user.role === "Section Head")) ||
      message.fromId === user.id
    );
  }
  return audience.userId === user.id;
}

function messageRecipientsForAudience(audience) {
  if (audience.type === "team") return db.users;
  if (audience.type === "section") {
    return db.users.filter((user) => user.section === audience.section);
  }
  if (audience.type === "subsection") {
    return db.users.filter(
      (user) => user.section === audience.section && user.subsection === audience.subsection,
    );
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
    .filter((user) => user.section === section)
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
    directMessageUsers().some((user) => user.id === privateUserId && user.section === section)
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
  return db.users.filter(
    (user) =>
      user.section === meeting.scope &&
      (meeting.subsection === "All" || user.subsection === meeting.subsection),
  );
}

function renderDashboard() {
  const members = visibleMembers();
  const myMessages = visibleMessagesFor(currentUser);
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
              <label>Subsection<select name="subsection">${subsectionOptions("Engineering")}</select></label>
              <label>Temporary password<input name="password" type="password" required></label>
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
  const memberForm = document.querySelector("#member-form");
  memberForm?.addEventListener("submit", handleCreateUser);
  memberForm?.elements.section.addEventListener("change", () => {
    memberForm.elements.subsection.innerHTML = subsectionOptions(memberForm.elements.section.value);
  });
  memberForm?.elements.role.addEventListener("change", () => {
    memberForm.elements.subsection.disabled = memberForm.elements.role.value !== "Member";
  });
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
          <td><span class="badge">${member.section}</span><br><span class="muted">${member.subsection || "All"}</span></td>
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
        <thead><tr><th>Name</th><th>Role</th><th>Section / Subsection</th><th>Score</th><th>Correction</th><th>Latest Activity</th></tr></thead>
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

async function handleCreateUser(event) {
  event.preventDefault();
  if (currentUser.role !== "Coach") {
    renderMembers();
    return;
  }
  const form = new FormData(event.currentTarget);
  const email = form.get("email").trim().toLowerCase();
  if (db.users.some((user) => user.email.toLowerCase() === email)) {
    window.alert("A user with that email already exists.");
    return;
  }
  const role = form.get("role");
  const section = role === "Coach" ? "All" : form.get("section");
  const subsection = role === "Member" ? form.get("subsection") : "All";
  const score = clampScore(Number(form.get("score")));
  const user = {
    id: crypto.randomUUID(),
    name: form.get("name").trim(),
    email,
    passwordHash: await hashPassword(form.get("password")),
    role,
    section,
    subsection,
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

function handleCreateMeeting(event) {
  event.preventDefault();
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
    if (currentUser.role === "Section Head") return member.section === currentUser.section;
    return true;
  });
  const controls = members
    .map((member) => {
      const value = meeting.attendance[member.id] || "";
      return `
        <div class="attendance-row">
          <div><strong>${escapeHtml(member.name)}</strong><br><span class="muted">${escapeHtml(member.section)} / ${escapeHtml(member.subsection || "All")} - ${scorePill(member.score)}</span></div>
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
      (meeting) => meeting.scope === currentUser.section || meeting.scope === "Global",
    );
  }
  return db.meetings.filter(
    (meeting) =>
      meeting.scope === "Global" ||
      (meeting.scope === currentUser.section &&
        (meeting.subsection === "All" || meeting.subsection === currentUser.subsection)),
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
  document.querySelector("#message-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const audience = parseMessageAudience(
      form.get("audienceKind"),
      form.get("sectionTarget"),
      form.get("subsectionTarget"),
      form.get("privateTarget"),
    );
    if (!audience) {
      window.alert("Choose a valid message target.");
      return;
    }
    const recipients = messageRecipientsForAudience(audience).filter((user) => user.id !== currentUser.id);
    if (!recipients.length) {
      window.alert("No recipients match that audience.");
      return;
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
    ${panel("Published Posts", renderPostManagerList())}
  `;

  document.querySelector("#about-form").addEventListener("submit", handleSaveAbout);
  document.querySelector("#public-post-form").addEventListener("submit", handlePublishPost);
  document.querySelectorAll(".delete-post").forEach((button) => {
    button.addEventListener("click", () => {
      const post = db.publicPosts.find((item) => item.id === button.dataset.post);
      if (!post || !canDeletePost(post)) return;
      if (!window.confirm(`Delete "${post.title}" from the public page?`)) return;
      db.publicPosts = db.publicPosts.filter((item) => item.id !== post.id);
      saveDb();
      renderPublicSite();
      renderSiteManager();
    });
  });
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

function handleSaveAbout(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const labels = form.getAll("socialLabel").map((value) => value.trim());
  const urls = form.getAll("socialUrl").map((value) => normalizeUrl(value));
  db.site = {
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
  const aboutSummary = document.querySelector("#public-about-summary");
  const socialLinks = document.querySelector("#public-social-links");
  const about = document.querySelector("#public-about");
  const posts = document.querySelector("#public-posts");
  const aboutPageTitle = document.querySelector("#about-page-title");
  const blogArticle = document.querySelector("#blog-article");
  if (!aboutSummary && !socialLinks && !about && !posts && !aboutPageTitle && !blogArticle) return;

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
