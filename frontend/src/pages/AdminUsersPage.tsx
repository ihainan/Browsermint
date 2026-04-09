import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { adminApi, AdminUser, AdminSession } from "../api/client.ts";
import {
  ShieldCheck, Trash2, Loader2, Users, Plus, KeyRound,
  ChevronUp, ChevronDown, ChevronsUpDown, X, Ban, CircleCheck,
} from "lucide-react";
import clsx from "clsx";
import { useAuth } from "../contexts/AuthContext.tsx";
import { useI18n } from "../i18n/I18nContext.tsx";

// ─── helpers ──────────────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  "bg-red-500", "bg-orange-500", "bg-amber-500", "bg-yellow-500",
  "bg-lime-600", "bg-green-500", "bg-teal-500", "bg-cyan-500",
  "bg-sky-500", "bg-blue-500", "bg-indigo-500", "bg-violet-500",
  "bg-purple-500", "bg-fuchsia-500", "bg-pink-500", "bg-rose-500",
];
function avatarColor(username: string) {
  const h = username.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

type SortKey = "username" | "sessionCount" | "maxSessions" | "createdAt";
type SortDir = "asc" | "desc";
type Filter = "all" | "active" | "suspended";

// ─── sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="bg-white border border-[#edebeb] rounded-lg px-4 py-3">
      <p className="text-[11px] text-[#969493] uppercase tracking-wide mb-1">{label}</p>
      <p className={clsx("text-2xl font-semibold tabular-nums", accent ? "text-[#1dc99a]" : "text-[#260f17]")}>
        {value}
      </p>
    </div>
  );
}

function SortIcon({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  if (col !== sortKey) return <ChevronsUpDown size={12} className="text-[#cac8c7] ml-0.5" />;
  return sortDir === "asc"
    ? <ChevronUp size={12} className="text-[#260f17] ml-0.5" />
    : <ChevronDown size={12} className="text-[#260f17] ml-0.5" />;
}

function MaxSessionsCell({ user, onSave, isPending }: {
  user: AdminUser; onSave: (v: number) => void; isPending: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(user.maxSessions));
  const pct = user.maxSessions > 0 ? Math.min(100, Math.round((user.sessionCount / user.maxSessions) * 100)) : 0;

  function commit() {
    const n = parseInt(value, 10);
    if (!isNaN(n) && n >= 0 && n !== user.maxSessions) onSave(n);
    setEditing(false);
  }

  return (
    <div className="flex flex-col gap-1 w-28">
      {editing ? (
        <input
          type="number" min={0} value={value} autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setValue(String(user.maxSessions)); setEditing(false); } }}
          onBlur={commit}
          className="w-20 px-1.5 py-0.5 text-[13px] border border-[#1dc99a] rounded focus:outline-none bg-white"
        />
      ) : (
        <button
          onClick={() => { setValue(String(user.maxSessions)); setEditing(true); }}
          disabled={isPending}
          className="text-left text-[13px] text-[#260f17] hover:text-[#1dc99a] transition-colors disabled:opacity-50 tabular-nums"
          title="Click to edit"
        >
          {isPending
            ? <Loader2 size={13} className="animate-spin inline" />
            : <span>{user.sessionCount} / {user.maxSessions}</span>
          }
        </button>
      )}
      <div className="h-1 w-full bg-[#edebeb] rounded-full overflow-hidden">
        <div
          className={clsx("h-full rounded-full transition-all", pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-[#1dc99a]")}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ─── detail panel ─────────────────────────────────────────────────────────────

function UserDetailPanel({ user, onClose, onResetPassword, onUpdate, onSuspendToggle, updatePending, adminCount }: {
  user: AdminUser;
  onClose: () => void;
  onResetPassword: () => void;
  onUpdate: (data: { isAdmin?: boolean; isActive?: boolean }) => void;
  onSuspendToggle: () => void;
  updatePending: boolean;
  adminCount: number;
}) {
  const { t, formatDateTime } = useI18n();
  const { user: currentUser } = useAuth();
  const isSelf = user.id === currentUser?.id;
  const isLastAdmin = user.isAdmin && adminCount <= 1;

  const { data, isPending } = useQuery({
    queryKey: ["admin", "users", user.id, "sessions"],
    queryFn: () => adminApi.getUserSessions(user.id).then((r) => r.data.sessions),
  });
  const sessions: AdminSession[] = data ?? [];

  return (
    <>
      {/* backdrop */}
      <div className="fixed inset-0 z-30" onClick={onClose} />
      {/* panel */}
      <div className="fixed right-0 top-0 h-full w-80 bg-white border-l border-[#edebeb] shadow-xl z-40 flex flex-col overflow-hidden">
        {/* header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#edebeb] shrink-0">
          <span className="text-[13px] font-semibold text-[#260f17]">{t("admin.userDetails")}</span>
          <button onClick={onClose} className="p-1 text-[#969493] hover:text-[#260f17] rounded transition-colors">
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* user info */}
          <div className="px-4 py-4 border-b border-[#edebeb]">
            <div className="flex items-center gap-3 mb-4">
              <div className={clsx("w-10 h-10 rounded-full flex items-center justify-center text-white font-bold shrink-0", avatarColor(user.username))}>
                {user.username[0].toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-[#260f17] truncate">{user.username}</p>
                <p className="text-xs text-[#969493] truncate">{user.email}</p>
              </div>
            </div>

            <div className="space-y-1.5 text-[12px]">
              <div className="flex justify-between">
                <span className="text-[#969493]">{t("admin.role")}</span>
                <span className={clsx("font-medium", user.isAdmin ? "text-[#0d7a5f]" : "text-[#514f4f]")}>
                  {user.isAdmin ? t("admin.admin") : t("admin.member")}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#969493]">{t("admin.status")}</span>
                <span className={clsx("font-medium", user.isActive ? "text-[#0d7a5f]" : "text-red-500")}>
                  {user.isActive ? t("admin.active") : t("admin.suspended")}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#969493]">{t("admin.joined")}</span>
                <span className="text-[#514f4f]">{formatDateTime(user.createdAt)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#969493]">{t("admin.sessions")}</span>
                <span className="text-[#514f4f] tabular-nums">{user.sessionCount} / {user.maxSessions}</span>
              </div>
            </div>
          </div>

          {/* actions */}
          <div className="px-4 py-3 border-b border-[#edebeb] space-y-1.5">
            <button
              onClick={() => onUpdate({ isAdmin: !user.isAdmin })}
              disabled={updatePending || isLastAdmin}
              className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-[#514f4f] hover:bg-[#f6f5f5] rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ShieldCheck size={13} />
              {user.isAdmin ? t("admin.removeAdmin") : t("admin.makeAdmin")}
            </button>
            <button
              onClick={onSuspendToggle}
              disabled={updatePending || (isSelf && user.isActive)}
              title={isSelf && user.isActive ? t("admin.cannotSuspendSelf") : undefined}
              className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-[#514f4f] hover:bg-[#f6f5f5] rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {user.isActive ? <Ban size={13} /> : <CircleCheck size={13} />}
              {user.isActive ? t("admin.suspend") : t("admin.activate")}
            </button>
            <button
              onClick={onResetPassword}
              className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-[#514f4f] hover:bg-[#f6f5f5] rounded transition-colors"
            >
              <KeyRound size={13} />
              {t("admin.resetPassword")}
            </button>
          </div>

          {/* sessions */}
          <div className="px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[#969493] mb-2">{t("admin.browserSessions")}</p>
            {isPending ? (
              <div className="flex justify-center py-4"><Loader2 size={16} className="animate-spin text-[#cac8c7]" /></div>
            ) : sessions.length === 0 ? (
              <p className="text-[12px] text-[#cac8c7] text-center py-4">{t("admin.noSessions")}</p>
            ) : (
              <div className="space-y-1">
                {sessions.map((s) => (
                  <div key={s.id} className="flex items-center justify-between py-1.5 border-b border-[#f6f5f5] last:border-0">
                    <div className="min-w-0">
                      <p className="text-[12px] text-[#260f17] truncate">{s.name ?? <span className="text-[#cac8c7]">—</span>}</p>
                      <p className="text-[10px] text-[#cac8c7] font-mono">{s.id.slice(0, 8)}…</p>
                    </div>
                    <span className={clsx(
                      "text-[10px] px-1.5 py-0.5 rounded shrink-0 ml-2",
                      s.status === "running" ? "bg-[#1dc99a18] text-[#0d7a5f]" :
                      s.status === "error" ? "bg-red-50 text-red-500" : "bg-[#f6f5f5] text-[#969493]"
                    )}>
                      {s.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ─── modals ───────────────────────────────────────────────────────────────────

function AddUserModal({ onClose, onCreate }: {
  onClose: () => void;
  onCreate: (data: { username: string; email: string; password: string; isAdmin: boolean }) => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState({ username: "", email: "", password: "", isAdmin: false });
  const [error, setError] = useState("");
  const [isPending, setIsPending] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (form.password.length < 12) { setError(t("register.passwordTooShort")); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      setError(t("common.invalidEmail"));
      return;
    }
    setError(""); setIsPending(true);
    try { await onCreate(form); }
    catch (err: unknown) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? t("register.registrationFailed"));
    } finally { setIsPending(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-2xl border border-[#edebeb] p-6 w-96 mx-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-[#260f17] mb-4">{t("admin.createUser")}</h3>
        {error && <div className="mb-3 px-3 py-2 bg-red-50 rounded text-xs text-red-600">{error}</div>}
        <form onSubmit={handleSubmit} className="space-y-3">
          {(["username", "email", "password"] as const).map((field) => (
            <div key={field}>
              <label className="block text-xs font-semibold text-[#969493] uppercase tracking-wide mb-1">
                {t(`common.${field}`)}
              </label>
              <input
                type={field === "password" ? "password" : field === "email" ? "email" : "text"}
                required value={form[field]}
                onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
                className="w-full px-3 py-2 bg-[#fafafa] border border-[#edebeb] rounded-md text-sm text-[#260f17] placeholder-[#cac8c7] focus:outline-none focus:ring-2 focus:ring-[#1dc99a]/20 focus:border-[#1dc99a] transition-colors"
                placeholder={field === "password" ? t("register.passwordHint") : ""}
              />
            </div>
          ))}
          <label className="flex items-center gap-2 text-[13px] text-[#514f4f] cursor-pointer">
            <input
              type="checkbox" checked={form.isAdmin}
              onChange={(e) => setForm((f) => ({ ...f, isAdmin: e.target.checked }))}
              className="rounded border-[#edebeb] text-[#1dc99a] focus:ring-[#1dc99a]/20"
            />
            {t("admin.makeAdmin")}
          </label>
          <div className="flex gap-2 justify-end pt-1">
            <button type="button" onClick={onClose} className="px-3.5 py-2 text-xs font-medium text-[#514f4f] bg-[#f6f5f5] hover:bg-[#edebeb] rounded-md transition-colors">
              {t("common.cancel")}
            </button>
            <button type="submit" disabled={isPending} className="px-3.5 py-2 text-xs font-medium text-white bg-[#1dc99a] hover:bg-[#17a87f] rounded-md transition-colors disabled:opacity-50 flex items-center gap-1.5">
              {isPending ? <><Loader2 size={11} className="animate-spin" />{t("admin.creatingUser")}</> : <><Plus size={11} />{t("admin.createUser")}</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ResetPasswordModal({ username, onClose, onReset }: {
  username: string; onClose: () => void; onReset: (password: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 12) { setError(t("register.passwordTooShort")); return; }
    setError(""); setIsPending(true);
    try { await onReset(password); setDone(true); }
    catch { setError("Failed to reset password."); }
    finally { setIsPending(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-2xl border border-[#edebeb] p-6 w-80 mx-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-[#260f17] mb-1">{t("admin.resetPassword")}</h3>
        <p className="text-xs text-[#969493] mb-4">{username}</p>
        {done ? (
          <>
            <p className="text-xs text-[#1dc99a] mb-4">Password reset successfully.</p>
            <div className="flex justify-end"><button onClick={onClose} className="px-3.5 py-2 text-xs font-medium text-white bg-[#1dc99a] hover:bg-[#17a87f] rounded-md transition-colors">{t("common.cancel")}</button></div>
          </>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            {error && <p className="text-xs text-red-500">{error}</p>}
            <div>
              <label className="block text-xs font-semibold text-[#969493] uppercase tracking-wide mb-1">{t("admin.newPassword")}</label>
              <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoFocus
                placeholder={t("register.passwordHint")}
                className="w-full px-3 py-2 bg-[#fafafa] border border-[#edebeb] rounded-md text-sm text-[#260f17] focus:outline-none focus:ring-2 focus:ring-[#1dc99a]/20 focus:border-[#1dc99a] transition-colors"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={onClose} className="px-3.5 py-2 text-xs font-medium text-[#514f4f] bg-[#f6f5f5] hover:bg-[#edebeb] rounded-md transition-colors">{t("common.cancel")}</button>
              <button type="submit" disabled={isPending} className="px-3.5 py-2 text-xs font-medium text-white bg-[#1dc99a] hover:bg-[#17a87f] rounded-md transition-colors disabled:opacity-50 flex items-center gap-1.5">
                {isPending ? <><Loader2 size={11} className="animate-spin" />{t("admin.resettingPassword")}</> : t("admin.resetPassword")}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// ─── main page ────────────────────────────────────────────────────────────────

export default function AdminUsersPage() {
  const { t, formatDateTime } = useI18n();
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null);
  const [suspendTarget, setSuspendTarget] = useState<AdminUser | null>(null);

  const { data, isPending } = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => adminApi.listUsers().then((r) => r.data.users),
  });
  const users = data ?? [];
  const adminCount = users.filter((u) => u.isAdmin).length;
  const totalSessions = users.reduce((s, u) => s + u.sessionCount, 0);
  const suspendedCount = users.filter((u) => !u.isActive).length;

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof adminApi.updateUser>[1] }) =>
      adminApi.updateUser(id, data),
    onSuccess: (res) => {
      queryClient.setQueryData<AdminUser[]>(["admin", "users"], (old) =>
        old?.map((u) => (u.id === res.data.user.id ? res.data.user : u))
      );
      if (selectedUser?.id === res.data.user.id) setSelectedUser(res.data.user);
      setSuspendTarget(null);
    },
  });

  const createMutation = useMutation({
    mutationFn: adminApi.createUser,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      setAddUserOpen(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => adminApi.deleteUser(id),
    onSuccess: (_, id) => {
      queryClient.setQueryData<AdminUser[]>(["admin", "users"], (old) => old?.filter((u) => u.id !== id));
      setDeleteTarget(null);
      if (selectedUser?.id === id) setSelectedUser(null);
    },
  });

  function handleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  const filtered = useMemo(() => {
    let list = users;
    if (filter === "active") list = list.filter((u) => u.isActive);
    if (filter === "suspended") list = list.filter((u) => !u.isActive);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((u) => u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
    }
    return [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "username") cmp = a.username.localeCompare(b.username);
      else if (sortKey === "sessionCount") cmp = a.sessionCount - b.sessionCount;
      else if (sortKey === "maxSessions") cmp = a.maxSessions - b.maxSessions;
      else if (sortKey === "createdAt") cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [users, filter, search, sortKey, sortDir]);

  return (
    <div className="mx-auto w-full max-w-screen-2xl px-4 pt-5 pb-12">

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        <StatCard label={t("admin.totalUsers")} value={users.length} />
        <StatCard label={t("admin.adminCount")} value={adminCount} />
        <StatCard label={t("admin.totalActiveSessions")} value={totalSessions} accent />
        <StatCard label={t("admin.suspendedCount")} value={suspendedCount} />
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4">
        <input
          type="text" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder={t("admin.searchPlaceholder")}
          className="flex-1 max-w-xs px-3 py-1.5 bg-white border border-[#edebeb] rounded-sm text-[13px] text-[#260f17] placeholder-[#cac8c7] focus:outline-none focus:ring-2 focus:ring-[#1dc99a]/20 focus:border-[#1dc99a] transition-colors"
        />
        <div className="flex rounded-sm border border-[#edebeb] overflow-hidden text-[12px]">
          {(["all", "active", "suspended"] as Filter[]).map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={clsx("px-3 py-1.5 transition-colors",
                filter === f ? "bg-[#260f17] text-white" : "bg-white text-[#514f4f] hover:bg-[#f6f5f5]"
              )}>
              {t(`admin.filter${f.charAt(0).toUpperCase() + f.slice(1)}` as `admin.filterAll`)}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button onClick={() => setAddUserOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1dc99a] text-white text-[13px] font-medium rounded-sm hover:bg-[#17a87f] transition-colors">
          <Plus size={13} />{t("admin.addUser")}
        </button>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-[#edebeb]">
        {isPending ? (
          <div className="flex justify-center py-16"><Loader2 size={20} className="animate-spin text-[#cac8c7]" /></div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center py-16 gap-2">
            <Users size={18} className="text-[#cac8c7]" />
            <p className="text-[13px] text-[#969493]">{search || filter !== "all" ? t("admin.noResults") : "No users"}</p>
          </div>
        ) : (
          <table className="text-[#260f17] text-[13px] w-full border-separate border-spacing-0 table-auto">
            <thead>
              <tr>
                <th className="px-2 py-3 text-left">
                  <button onClick={() => handleSort("username")} className="flex items-center text-xs text-[#969493] font-normal hover:text-[#260f17] transition-colors">
                    {t("admin.username")}<SortIcon col="username" sortKey={sortKey} sortDir={sortDir} />
                  </button>
                </th>
                <th className="px-2 py-3 text-left text-[#969493] text-xs font-normal">{t("admin.email")}</th>
                <th className="px-2 py-3 text-left text-[#969493] text-xs font-normal w-28">{t("admin.role")}</th>
                <th className="px-2 py-3 text-left">
                  <button onClick={() => handleSort("sessionCount")} className="flex items-center text-xs text-[#969493] font-normal hover:text-[#260f17] transition-colors">
                    {t("admin.sessions")}<SortIcon col="sessionCount" sortKey={sortKey} sortDir={sortDir} />
                  </button>
                </th>
                <th className="px-2 py-3 text-left">
                  <button onClick={() => handleSort("createdAt")} className="flex items-center text-xs text-[#969493] font-normal hover:text-[#260f17] transition-colors">
                    {t("admin.joined")}<SortIcon col="createdAt" sortKey={sortKey} sortDir={sortDir} />
                  </button>
                </th>
                <th className="w-24" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((user) => {
                const isSelf = user.id === currentUser?.id;
                const isLastAdmin = user.isAdmin && adminCount <= 1;
                const updatePending = updateMutation.isPending && updateMutation.variables?.id === user.id;
                const isSelected = selectedUser?.id === user.id;

                return (
                  <tr key={user.id}
                    onClick={() => setSelectedUser(isSelected ? null : user)}
                    className={clsx("border-t border-[#edebeb] cursor-pointer transition-colors", isSelected ? "bg-[#f0fdf9]" : "hover:bg-[#fafafa]")}
                  >
                    {/* User */}
                    <td className="p-0">
                      <div className="flex h-12 items-center gap-2.5 px-2">
                        <div className={clsx("w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-bold shrink-0", avatarColor(user.username))}>
                          {user.username[0].toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium text-[#260f17]">{user.username}</span>
                            {isSelf && <span className="text-[10px] text-[#969493] bg-[#f6f5f5] px-1 py-0.5 rounded">you</span>}
                            {!user.isActive && <span className="text-[10px] text-red-500 bg-red-50 px-1 py-0.5 rounded">{t("admin.suspended")}</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    {/* Email */}
                    <td className="p-0"><div className="flex h-12 items-center px-2 text-[#514f4f] text-[12px]">{user.email}</div></td>
                    {/* Role */}
                    <td className="p-0">
                      <div className="flex h-12 items-center px-2">
                        <button
                          onClick={(e) => { e.stopPropagation(); if (!updatePending && !isLastAdmin) updateMutation.mutate({ id: user.id, data: { isAdmin: !user.isAdmin } }); }}
                          disabled={updatePending || isLastAdmin}
                          title={isLastAdmin ? t("admin.cannotRemoveLastAdmin") : user.isAdmin ? t("admin.removeAdmin") : t("admin.makeAdmin")}
                          className={clsx("inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium transition-colors",
                            user.isAdmin
                              ? "bg-[#1dc99a18] text-[#0d7a5f] hover:bg-[#1dc99a30] disabled:cursor-default disabled:hover:bg-[#1dc99a18]"
                              : "bg-[#f6f5f5] text-[#969493] hover:bg-[#edebeb]",
                            "disabled:opacity-60"
                          )}>
                          {updatePending ? <Loader2 size={10} className="animate-spin" /> : user.isAdmin && <ShieldCheck size={10} />}
                          {user.isAdmin ? t("admin.admin") : t("admin.member")}
                        </button>
                      </div>
                    </td>
                    {/* Usage */}
                    <td className="p-0">
                      <div className="flex h-12 items-center px-2" onClick={(e) => e.stopPropagation()}>
                        <MaxSessionsCell
                          user={user}
                          onSave={(v) => updateMutation.mutate({ id: user.id, data: { maxSessions: v } })}
                          isPending={updatePending}
                        />
                      </div>
                    </td>
                    {/* Joined */}
                    <td className="p-0 whitespace-nowrap">
                      <div className="flex h-12 items-center px-2 text-[#514f4f] text-[12px]">{formatDateTime(user.createdAt)}</div>
                    </td>
                    {/* Actions */}
                    <td className="p-0">
                      <div className="flex h-12 items-center justify-end gap-0.5 px-2" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => setSuspendTarget(user)}
                          disabled={updatePending || (isSelf && user.isActive)}
                          title={isSelf && user.isActive ? t("admin.cannotSuspendSelf") : user.isActive ? t("admin.suspend") : t("admin.activate")}
                          className="p-1.5 text-[#cac8c7] hover:text-amber-500 hover:bg-amber-50 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-[#cac8c7] disabled:hover:bg-transparent"
                        >
                          {user.isActive ? <Ban size={13} /> : <CircleCheck size={13} />}
                        </button>
                        <button
                          onClick={() => setResetTarget(user)}
                          title={t("admin.resetPassword")}
                          className="p-1.5 text-[#cac8c7] hover:text-[#514f4f] hover:bg-[#f6f5f5] rounded transition-colors"
                        >
                          <KeyRound size={13} />
                        </button>
                        <button
                          onClick={() => setDeleteTarget(user)}
                          disabled={isSelf || isLastAdmin}
                          title={isSelf ? t("admin.cannotDeleteSelf") : isLastAdmin ? t("admin.cannotDeleteLastAdmin") : t("admin.deleteUser")}
                          className="p-1.5 text-[#cac8c7] hover:text-red-500 hover:bg-red-50 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-[#cac8c7] disabled:hover:bg-transparent"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Detail panel */}
      {selectedUser && (
        <UserDetailPanel
          user={selectedUser}
          onClose={() => setSelectedUser(null)}
          onResetPassword={() => setResetTarget(selectedUser)}
          onUpdate={(data) => updateMutation.mutate({ id: selectedUser.id, data })}
          onSuspendToggle={() => setSuspendTarget(selectedUser)}
          updatePending={updateMutation.isPending && updateMutation.variables?.id === selectedUser.id}
          adminCount={adminCount}
        />
      )}

      {/* Add user modal */}
      {addUserOpen && (
        <AddUserModal
          onClose={() => setAddUserOpen(false)}
          onCreate={(data) => createMutation.mutateAsync(data)}
        />
      )}

      {/* Reset password modal */}
      {resetTarget && (
        <ResetPasswordModal
          username={resetTarget.username}
          onClose={() => setResetTarget(null)}
          onReset={(password) => adminApi.resetPassword(resetTarget.id, { password }).then(() => {})}
        />
      )}

      {/* Suspend / Activate confirm modal */}
      {suspendTarget && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setSuspendTarget(null)}>
          <div className="bg-white rounded-lg shadow-2xl border border-[#edebeb] p-6 w-80 mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-[#260f17] mb-1">
              {suspendTarget.isActive ? t("admin.suspendUser") : t("admin.activateUser")}
            </h3>
            <p className="text-xs text-[#969493] mb-5">
              {suspendTarget.isActive ? t("admin.suspendUserHint") : t("admin.activateUserHint")}
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setSuspendTarget(null)} className="px-3.5 py-2 text-xs font-medium text-[#514f4f] bg-[#f6f5f5] hover:bg-[#edebeb] rounded-md transition-colors">{t("common.cancel")}</button>
              <button
                onClick={() => updateMutation.mutate({ id: suspendTarget.id, data: { isActive: !suspendTarget.isActive } })}
                disabled={updateMutation.isPending}
                className={clsx(
                  "px-3.5 py-2 text-xs font-medium text-white rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5",
                  suspendTarget.isActive ? "bg-amber-500 hover:bg-amber-600" : "bg-[#1dc99a] hover:bg-[#17a87f]"
                )}
              >
                {updateMutation.isPending && <Loader2 size={11} className="animate-spin" />}
                {t("admin.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm modal */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setDeleteTarget(null)}>
          <div className="bg-white rounded-lg shadow-2xl border border-[#edebeb] p-6 w-80 mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-[#260f17] mb-1">{t("admin.deleteUser")}</h3>
            <p className="text-xs text-[#969493] mb-5">{t("admin.deleteUserHint")}</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeleteTarget(null)} className="px-3.5 py-2 text-xs font-medium text-[#514f4f] bg-[#f6f5f5] hover:bg-[#edebeb] rounded-md transition-colors">{t("common.cancel")}</button>
              <button onClick={() => deleteMutation.mutate(deleteTarget.id)} disabled={deleteMutation.isPending}
                className="px-3.5 py-2 text-xs font-medium text-white bg-red-500 hover:bg-red-600 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5">
                {deleteMutation.isPending && <Loader2 size={11} className="animate-spin" />}
                {t("sessions.delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
