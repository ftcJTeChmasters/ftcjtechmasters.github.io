import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-state-id, x-backup-pin-hash",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const tableName = Deno.env.get("APP_STATE_TABLE") ?? "app_state";
const defaultStateId = Deno.env.get("APP_STATE_ID") ?? "main";
const backupPinHash =
  Deno.env.get("BACKUP_PIN_SHA256") ??
  "8f084c6fff8fb61d1f7a43aa5470b849a2d770c42127e9621a25bd159dd69c85";

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

type AuthActionResult = {
  error?: string;
  user?: {
    id?: string;
    email?: string;
    user_metadata?: Record<string, unknown>;
  };
  created?: boolean;
};

type AuthProfile = {
  id: string;
  authUserId: string;
  name: string;
  email: string;
  role: string;
  section: string;
  subsection: string;
  assignments: unknown[];
  score: number;
  portfolio: unknown[];
  activityLog: unknown[];
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    if (typeof (error as { message?: unknown }).message === "string") {
      return String((error as { message?: unknown }).message);
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return "";
}

function bearerToken(request: Request) {
  const header = request.headers.get("authorization") || "";
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" ? token : "";
}

async function requireUser(request: Request) {
  const token = bearerToken(request);
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function validBackupPinHash(hash: unknown) {
  const candidate = String(hash || "").trim().toLowerCase();
  if (!candidate || !backupPinHash) return false;
  return await sha256(candidate) === await sha256(backupPinHash.toLowerCase());
}

function backupProfile() {
  return {
    id: "backup-access",
    authUserId: "backup-access",
    name: "Backup Access",
    email: "backup@local",
    role: "Coach",
    section: "All",
    subsection: "All",
    assignments: [{ section: "All", subsection: "All" }],
    score: 7,
    portfolio: [],
    activityLog: [],
  };
}

async function requestActor(request: Request, payload: Record<string, unknown> | null = null) {
  const headerHash = request.headers.get("x-backup-pin-hash");
  const bodyHash = payload?.backupPinHash;
  if (await validBackupPinHash(headerHash || bodyHash)) {
    return {
      user: null,
      profile: backupProfile(),
      backup: true,
    };
  }

  const user = await requireUser(request);
  if (user) {
    return {
      user,
      profile: profileFromAuthMetadata({
        id: user.id,
        email: user.email,
        user_metadata: user.user_metadata,
        app_metadata: user.app_metadata,
      }),
      backup: false,
    };
  }

  return null;
}

async function loadState(stateId: string) {
  return await admin
    .from(tableName)
    .select("data, updated_at")
    .eq("id", stateId)
    .maybeSingle();
}

function profileFromAuthMetadata(authUser: {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
}) {
  const metadata = {
    ...(authUser.user_metadata || {}),
    ...(authUser.app_metadata || {}),
  };
  const assignments = Array.isArray(metadata.assignments) && metadata.assignments.length
    ? metadata.assignments
    : [{
        section: String(metadata.section || "All"),
        subsection: String(metadata.subsection || "All"),
      }];

  return {
    id: authUser.id,
    authUserId: authUser.id,
    name: String(metadata.name || metadata.full_name || metadata.display_name || authUser.email || "Temporary Coach"),
    email: String(authUser.email || "").toLowerCase(),
    role: String(metadata.role || "Member"),
    section: String((assignments[0] as Record<string, unknown>)?.section || "All"),
    subsection: String((assignments[0] as Record<string, unknown>)?.subsection || "All"),
    assignments,
    score: Number(metadata.score ?? 7),
    portfolio: Array.isArray(metadata.portfolio) ? metadata.portfolio : [],
    activityLog: Array.isArray(metadata.activityLog) ? metadata.activityLog : [],
    needsPasswordChange: Boolean(metadata.needsPasswordChange),
    temporaryCoach: false,
  };
}

function profileForAuthUser(_stateData: unknown, authUser: {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
}) {
  return profileFromAuthMetadata(authUser);
}

function isCoach(profile: unknown) {
  return Boolean(profile && typeof profile === "object" && (profile as { role?: string }).role === "Coach");
}

function canManageProfiles(profile: unknown) {
  return Boolean(
    profile &&
      typeof profile === "object" &&
      ["Coach", "Section Head"].includes(String((profile as { role?: string }).role || "")),
  );
}

function metadataFromProfile(profile: Record<string, unknown>, existingMetadata: Record<string, unknown> = {}) {
  return {
    ...existingMetadata,
    name: String(profile.name || existingMetadata.name || ""),
    role: String(profile.role || existingMetadata.role || "Member"),
    section: String(profile.section || existingMetadata.section || "All"),
    subsection: String(profile.subsection || existingMetadata.subsection || "All"),
    assignments: Array.isArray(profile.assignments)
      ? profile.assignments
      : Array.isArray(existingMetadata.assignments)
      ? existingMetadata.assignments
      : [{ section: String(profile.section || existingMetadata.section || "All"), subsection: String(profile.subsection || existingMetadata.subsection || "All") }],
    score: Number(profile.score ?? existingMetadata.score ?? 0),
    portfolio: Array.isArray(profile.portfolio)
      ? profile.portfolio
      : Array.isArray(existingMetadata.portfolio)
      ? existingMetadata.portfolio
      : [],
    activityLog: Array.isArray(profile.activityLog)
      ? profile.activityLog
      : Array.isArray(existingMetadata.activityLog)
      ? existingMetadata.activityLog
      : [],
    needsPasswordChange: Boolean(profile.needsPasswordChange ?? existingMetadata.needsPasswordChange),
    invalidPasswordAttempts: Number(profile.invalidPasswordAttempts ?? existingMetadata.invalidPasswordAttempts ?? 0),
    lockoutCount: Number(profile.lockoutCount ?? existingMetadata.lockoutCount ?? 0),
    lockoutUntil: profile.lockoutUntil ?? existingMetadata.lockoutUntil ?? null,
    blocked: Boolean(profile.blocked ?? existingMetadata.blocked ?? false),
    maxInvalidAttempts: Number(profile.maxInvalidAttempts ?? existingMetadata.maxInvalidAttempts ?? 3),
    maxLockouts: Number(profile.maxLockouts ?? existingMetadata.maxLockouts ?? 3),
    lockoutDurationMinutes: Number(profile.lockoutDurationMinutes ?? existingMetadata.lockoutDurationMinutes ?? 10),
    coachLockoutDurationMinutes: Number(profile.coachLockoutDurationMinutes ?? existingMetadata.coachLockoutDurationMinutes ?? 5),
  };
}

async function getAuthUserMetadata(authUserId: string) {
  const { data, error } = await admin.auth.admin.getUserById(authUserId);
  if (error || !data.user) throw new Error(getErrorMessage(error) || "Auth user not found.");
  return (data.user.user_metadata || {}) as Record<string, unknown>;
}

async function findAuthUserByEmail(email: string) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;

  const listResult = await (admin.auth.admin as any).listUsers({ query: normalized, perPage: 100 });
  if (listResult.error) throw new Error(getErrorMessage(listResult.error));

  const users = Array.isArray(listResult.data)
    ? listResult.data
    : Array.isArray(listResult.data?.users)
    ? listResult.data.users
    : [];

  const authUser = users.find(
    (user: { email?: string }) => String(user.email || "").trim().toLowerCase() === normalized,
  );

  if (!authUser) return null;
  return {
    id: String(authUser.id || ""),
    email: String(authUser.email || ""),
    raw_user_meta_data:
      (authUser as { raw_user_meta_data?: Record<string, unknown> }).raw_user_meta_data ||
      (authUser as { user_metadata?: Record<string, unknown> }).user_metadata || {},
  };
}

function isLoginLocked(metadata: Record<string, unknown>) {
  const lockoutUntil = metadata.lockoutUntil;
  if (!lockoutUntil) return false;
  const lockoutDate = new Date(String(lockoutUntil));
  return lockoutDate > new Date();
}

function getLockoutStatus(metadata: Record<string, unknown>) {
  const invalidPasswordAttempts = Number(metadata.invalidPasswordAttempts ?? 0);
  const lockoutCount = Number(metadata.lockoutCount ?? 0);
  const maxInvalidAttempts = Number(metadata.maxInvalidAttempts ?? 3);
  const maxLockouts = Number(metadata.maxLockouts ?? 3);
  const lockoutDurationMinutes = Number(metadata.lockoutDurationMinutes ?? 10);
  const coachLockoutDurationMinutes = Number(metadata.coachLockoutDurationMinutes ?? 5);
  const lockoutUntil = metadata.lockoutUntil ? new Date(String(metadata.lockoutUntil)) : null;
  const blocked = Boolean(metadata.blocked ?? false);
  return {
    invalidPasswordAttempts,
    lockoutCount,
    maxInvalidAttempts,
    maxLockouts,
    lockoutDurationMinutes,
    coachLockoutDurationMinutes,
    lockoutUntil,
    blocked,
    locked: lockoutUntil instanceof Date && lockoutUntil > new Date(),
  };
}

function stripUsersFromState(stateData: unknown) {
  if (!stateData || typeof stateData !== "object") return stateData;
  const { users: _users, ...rest } = stateData as Record<string, unknown>;
  return rest;
}

async function listAuthProfiles(): Promise<AuthProfile[]> {
  const { data, error } = await admin.rpc("list_auth_profiles");
  if (error) throw new Error(getErrorMessage(error));
  return Array.isArray(data) ? data as AuthProfile[] : [];
}

async function authUsersPayload() {
  try {
    return {
      users: await listAuthProfiles(),
      usersError: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load Supabase Auth users.";
    return {
      users: [],
      usersError: message,
    };
  }
}

function friendlyAuthError(errorMessage: string) {
  const normalized = errorMessage.toLowerCase();
  if (normalized.includes("already") || normalized.includes("duplicate")) {
    return "A Supabase Auth user already exists with this email. Use Set password on the existing app member, or remove the duplicate Auth user in Supabase.";
  }
  return errorMessage;
}

function generateTemporaryPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@$%";
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (byte) => chars[byte % chars.length]).join("");
}

async function createAuthUser(
  profile: Record<string, unknown>,
  password: unknown = null,
): Promise<AuthActionResult & { temporaryPassword?: string }> {
  const email = String(profile.email || "").trim().toLowerCase();
  if (!email) return { error: "Email is required." };

  const providedPassword = String(password ?? profile.password ?? "").trim();
  if (providedPassword && providedPassword.length < 6) {
    return { error: "Temporary password must be at least 6 characters." };
  }

  const temporaryPassword = providedPassword || generateTemporaryPassword();
  const userMetadata = metadataFromProfile(profile);
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: temporaryPassword,
    email_confirm: true,
    user_metadata: userMetadata,
  });
  if (error) return { error: friendlyAuthError(error.message) };
  return { user: data.user, created: true, temporaryPassword: providedPassword ? undefined : temporaryPassword };
}

async function setAuthUserPassword(profile: Record<string, unknown>, password: string): Promise<AuthActionResult> {
  const cleanPassword = String(password || "");
  if (cleanPassword.length < 6) return { error: "Temporary password must be at least 6 characters." };

  const authUserId = String(profile.authUserId || "");
  const email = String(profile.email || "").trim().toLowerCase();
  if (!authUserId) {
    const result = await createAuthUser(profile);
    if (result.error || !result.user?.id) return result;
    const updated = await setAuthUserPassword({ ...profile, authUserId: result.user.id }, cleanPassword);
    return { ...updated, created: true };
  }

  const existingMetadata = await getAuthUserMetadata(authUserId);
  const { data, error } = await admin.auth.admin.updateUserById(authUserId, {
    email,
    password: cleanPassword,
    email_confirm: true,
    user_metadata: metadataFromProfile(profile, existingMetadata),
  });
  if (error) return { error: friendlyAuthError(error.message) };
  return { user: data.user };
}

async function updateAuthUserProfile(profile: Record<string, unknown>): Promise<AuthActionResult> {
  const authUserId = String(profile.authUserId || profile.id || "");
  const email = String(profile.email || "").trim().toLowerCase();
  if (!authUserId) return { error: "Auth user id is required." };

  const existingMetadata = await getAuthUserMetadata(authUserId);
  const { data, error } = await admin.auth.admin.updateUserById(authUserId, {
    ...(email ? { email } : {}),
    user_metadata: metadataFromProfile(profile, existingMetadata),
  });
  if (error) return { error: friendlyAuthError(error.message) };
  return { user: data.user };
}

async function handleRequest(request: Request) {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." }, 500);
  }

  const url = new URL(request.url);
  const stateId = request.headers.get("x-state-id") || url.searchParams.get("id") || defaultStateId;
  const resource = url.searchParams.get("resource") || "";

  if (request.method === "GET") {
    if (resource === "users") {
      const actor = await requestActor(request);
      if (!actor) return json({ error: "Authentication required." }, 401);
      const authPayload = await authUsersPayload();
      return json(authPayload);
    }

    if (resource === "ping") {
      const lastUpdatedAt = url.searchParams.get("lastUpdatedAt") || null;
      const { data, error } = await loadState(stateId);
      if (error) return json({ error: error.message }, 500);
      const updatedAt = data?.updated_at || null;
      const ping = updatedAt === lastUpdatedAt ? 1 : 2;
      return json({ ping, updatedAt });
    }

    const { data, error } = await loadState(stateId);

    if (error) return json({ error: error.message }, 500);
    const actor = await requestActor(request);
    let users: AuthProfile[] = [];
    let usersError: string | null = null;
    if (actor) {
      const authPayload = await authUsersPayload();
      users = authPayload.users;
      usersError = authPayload.usersError;
    }
    if (!data) return json({ data: null, users, usersError, updatedAt: null });
    return json({ data: stripUsersFromState(data.data), users, usersError, updatedAt: data.updated_at });
  }

  if (request.method === "POST") {
    const payload = await request.json().catch(() => null);
    if (!payload || typeof payload !== "object") {
      return json({ error: "Request body must be an object." }, 400);
    }
    const action = (payload as { action?: unknown }).action;
    const anonymousActions = [
      "authenticate-user",
      "check-login-status",
      "notify-wrong-password",
      "reset-login-attempts",
    ];
    const actor = await requestActor(request, payload as Record<string, unknown>);
    if (!actor && !anonymousActions.includes(String(action || ""))) {
      return json({ error: "Authentication required." }, 401);
    }
    const profile = actor?.profile;

    if (!("data" in payload)) {
      if (!action) return json({ error: "Request body must include a data property." }, 400);

      if (action === "verify-backup-pin") {
        if (!actor?.backup) return json({ error: "Backup PIN is incorrect." }, 403);
        return json({ ok: true, profile: backupProfile() });
      }

      if (action === "authenticate-user") {
        const email = String((payload as { email?: unknown }).email || "").trim().toLowerCase();
        if (!email) return json({ error: "Email is required." }, 400);
        const authUser = await findAuthUserByEmail(email);
        if (!authUser) {
          return json({ error: "Email or password is incorrect." }, 400);
        }
        const metadata = authUser.raw_user_meta_data || {};
        const status = getLockoutStatus(metadata);
        if (status.blocked) {
          return json({ error: "This account is blocked. Contact a coach to unlock it.", blocked: true }, 403);
        }
        if (status.locked) {
          return json({ error: "This account is temporarily locked.", locked: true, lockoutUntil: status.lockoutUntil }, 403);
        }
        return json({ ok: true });
      }

      if (action === "check-login-status") {
        const email = String((payload as { email?: unknown }).email || "").trim().toLowerCase();
        if (!email) return json({ error: "Email is required." }, 400);
        const authUser = await findAuthUserByEmail(email);
        if (!authUser) return json({ ok: true, found: false });
        const metadata = authUser.raw_user_meta_data || {};
        const status = getLockoutStatus(metadata);
        return json({ ok: true, found: true, email, role: String(metadata.role || "Member"), ...status });
      }

      if (action === "notify-wrong-password") {
        const email = String((payload as { email?: unknown }).email || "").trim().toLowerCase();
        if (!email) return json({ error: "Email is required." }, 400);
        const authUser = await findAuthUserByEmail(email);
        if (!authUser) return json({ error: "Auth user not found." }, 404);
        const metadata = authUser.raw_user_meta_data || {};
        const status = getLockoutStatus(metadata);
        if (status.blocked) {
          return json({ error: "This account is blocked. Contact a coach to unlock it.", blocked: true }, 403);
        }
        if (status.locked) {
          return json({ error: "This account is temporarily locked.", locked: true, lockoutUntil: status.lockoutUntil }, 403);
        }
        const attempted = status.invalidPasswordAttempts + 1;
        const remaining = Math.max(0, status.maxInvalidAttempts - attempted);
        const isCoachAccount = String(metadata.role || "Member") === "Coach";
        const lockoutMinutes = isCoachAccount ? status.coachLockoutDurationMinutes : status.lockoutDurationMinutes;
        const updatedMetadata = { ...metadata, invalidPasswordAttempts: attempted } as Record<string, unknown>;
        let message = `Email or password is incorrect. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`;

        if (attempted >= status.maxInvalidAttempts) {
          updatedMetadata.invalidPasswordAttempts = 0;
          updatedMetadata.lockoutCount = status.lockoutCount + 1;
          updatedMetadata.lockoutUntil = new Date(Date.now() + lockoutMinutes * 60000).toISOString();
          if (updatedMetadata.lockoutCount >= status.maxLockouts) {
            updatedMetadata.blocked = true;
            message = `Too many failed login attempts. This account is blocked until a coach unlocks it.`;
          } else {
            message = `Too many failed login attempts. This account is locked for ${lockoutMinutes} minute${lockoutMinutes !== 1 ? "s" : ""}.`;
          }
        }

        const mergedMetadata = metadataFromProfile({}, updatedMetadata);
        const { error } = await admin.auth.admin.updateUserById(authUser.id, {
          user_metadata: mergedMetadata,
        });
        if (error) return json({ error: friendlyAuthError(error.message) }, 500);
        return json({ ok: true, message, blocked: Boolean(mergedMetadata.blocked), locked: isLoginLocked(mergedMetadata), lockoutUntil: mergedMetadata.lockoutUntil });
      }

      if (action === "reset-login-attempts") {
        const email = String((payload as { email?: unknown }).email || "").trim().toLowerCase();
        if (!email) return json({ error: "Email is required." }, 400);
        const authUser = await findAuthUserByEmail(email);
        if (!authUser) return json({ error: "Auth user not found." }, 404);
        const metadata = authUser.raw_user_meta_data || {};
        const updatedMetadata = {
          ...metadata,
          invalidPasswordAttempts: 0,
          lockoutUntil: null,
        } as Record<string, unknown>;
        const mergedMetadata = metadataFromProfile({}, updatedMetadata);
        const { error } = await admin.auth.admin.updateUserById(authUser.id, {
          user_metadata: mergedMetadata,
        });
        if (error) return json({ error: friendlyAuthError(error.message) }, 500);
        return json({ ok: true });
      }

      const actionProfile = (payload as { profile?: unknown }).profile;
      if (!actionProfile || typeof actionProfile !== "object") {
        return json({ error: "Request body must include a profile object." }, 400);
      }

      if (action === "create-auth-user") {
        if (!isCoach(profile)) return json({ error: "Coach access required." }, 403);
        const result = await createAuthUser(
          actionProfile as Record<string, unknown>,
          (payload as { password?: unknown }).password,
        );
        if (result.error) return json({ error: result.error }, 400);
        return json({
          ok: true,
          authUserId: result.user?.id,
          email: result.user?.email,
          created: result.created,
          temporaryPassword: result.temporaryPassword,
        });
      }

      if (action === "set-auth-password") {
        const targetProfile = actionProfile as Record<string, unknown>;
        const profileId = String(targetProfile.authUserId || targetProfile.id || "");
        if (!isCoach(profile) && profileId !== String((profile as { authUserId?: string }).authUserId || "")) {
          return json({ error: "Coach access required." }, 403);
        }
        const result = await setAuthUserPassword(actionProfile as Record<string, unknown>, String((payload as { password?: unknown }).password || ""));
        if (result.error) return json({ error: result.error }, 400);
        return json({
          ok: true,
          authUserId: result.user?.id,
          email: result.user?.email,
        });
      }

      if (action === "update-auth-profile") {
        const targetProfile = actionProfile as Record<string, unknown>;
        const profileId = String(targetProfile.authUserId || targetProfile.id || "");
        if (!canManageProfiles(profile) && profileId !== String((profile as { authUserId?: string }).authUserId || "")) {
          return json({ error: "You can only update your own Auth profile." }, 403);
        }
        const result = await updateAuthUserProfile(targetProfile);
        if (result.error) return json({ error: result.error }, 400);
        return json({
          ok: true,
          authUserId: result.user?.id,
          email: result.user?.email,
        });
      }

      if (action === "delete-auth-user") {
        if (!isCoach(profile)) return json({ error: "Coach access required." }, 403);
        const targetProfile = actionProfile as Record<string, unknown>;
        const authUserId = String(targetProfile.authUserId || targetProfile.id || "");
        if (!authUserId) return json({ error: "Auth user id is required." }, 400);
        const { error } = await admin.auth.admin.deleteUser(authUserId);
        if (error) return json({ error: friendlyAuthError(error.message) }, 400);
        return json({ ok: true, authUserId });
      }

      if (action === "reset-login-attempts") {
        const email = String((payload as { email?: unknown }).email || "").trim().toLowerCase();
        if (!email) return json({ error: "Email is required." }, 400);
        const authUser = await findAuthUserByEmail(email);
        if (!authUser) return json({ error: "Auth user not found." }, 404);
        const metadata = authUser.raw_user_meta_data || {};
        const updatedMetadata = {
          ...metadata,
          invalidPasswordAttempts: 0,
          lockoutUntil: null,
        } as Record<string, unknown>;
        const mergedMetadata = metadataFromProfile({}, updatedMetadata);
        const { error } = await admin.auth.admin.updateUserById(authUser.id, {
          user_metadata: mergedMetadata,
        });
        if (error) return json({ error: friendlyAuthError(error.message) }, 500);
        return json({ ok: true });
      }

      if (action === "unblock-auth-user") {
        if (!isCoach(profile)) return json({ error: "Coach access required." }, 403);
        const targetProfile = actionProfile as Record<string, unknown>;
        const authUserId = String(targetProfile.authUserId || targetProfile.id || "");
        if (!authUserId) return json({ error: "Auth user id is required." }, 400);
        const existingMetadata = await getAuthUserMetadata(authUserId);
        const mergedMetadata = metadataFromProfile({ ...existingMetadata, blocked: false, invalidPasswordAttempts: 0, lockoutUntil: null, lockoutCount: 0 }, existingMetadata);
        const { error } = await admin.auth.admin.updateUserById(authUserId, {
          user_metadata: mergedMetadata,
        });
        if (error) return json({ error: friendlyAuthError(error.message) }, 500);
        return json({ ok: true, authUserId });
      }

      return json({ error: "Unknown action." }, 400);
    }

    const { error } = await admin
      .from(tableName)
      .upsert(
        {
          id: stateId,
          data: stripUsersFromState(payload.data),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      );

    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: "Method not allowed." }, 405);
}

Deno.serve(async (request) => {
  try {
    return await handleRequest(request);
  } catch (error) {
    const message = getErrorMessage(error) || "Unexpected Supabase Edge Function error.";
    return json({ error: message }, 500);
  }
});
