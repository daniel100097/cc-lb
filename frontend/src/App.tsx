import type { FormEvent, ReactNode } from "react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import type { inferRouterOutputs } from "@trpc/server";
import {
  Activity,
  ArrowUpDown,
  CheckCircle2,
  Clock3,
  Code2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Moon,
  MoreHorizontal,
  Pause,
  Plus,
  RotateCcw,
  Save,
  Search,
  ShieldAlert,
  Sun,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { AlertMessage } from "@/components/alert-message";
import { CopyButton } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { MiniQuotaBar } from "@/components/mini-quota-bar";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Toaster } from "@/components/ui/sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { compactNumber, currency, durationMs, latencyMs, relativeTime } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { usePrivacyStore } from "@/hooks/use-privacy";
import { useThemeStore } from "@/hooks/use-theme";
import type { StrategyName } from "../../src/balancer/types";
import type { AppRouter } from "../../src/api/router";

type RouterOutput = inferRouterOutputs<AppRouter>;
type Account = RouterOutput["accounts"]["list"][number];
type SettingsValue = RouterOutput["settings"]["get"];
type RequestEntry = RouterOutput["requests"]["list"]["entries"][number];
type NumberSettingsKey =
  | "stickyTtlMs"
  | "rateLimitBackoffBaseMs"
  | "rateLimitBackoffMaxMs"
  | "sessionDurationMs"
  | "overloadRetryMax";

const strategyNameSet = new Set<string>([
  "priority",
  "round_robin",
  "least_used",
  "weighted_random",
  "session_reset_drain",
]);

const navItems = [
  { href: "/", label: "Dashboard" },
  { href: "/accounts", label: "Accounts" },
  { href: "/requests", label: "Requests" },
  { href: "/settings", label: "Settings" },
];

const REQUEST_PAGE_SIZE = 25;
type RequestTimeframe = "1h" | "24h" | "7d" | "all";
const REQUEST_TIMEFRAMES: RequestTimeframe[] = ["1h", "24h", "7d", "all"];

export function App() {
  const initializeTheme = useThemeStore((state) => state.initializeTheme);

  useEffect(() => {
    initializeTheme();
  }, [initializeTheme]);

  return (
    <div className="bg-background min-h-screen pb-16 text-sm">
      <AppHeader />
      <main className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 px-4 py-6 sm:px-6">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/requests" element={<RequestsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
      <StatusBar />
      <Toaster />
    </div>
  );
}

function AppHeader() {
  const preference = useThemeStore((state) => state.preference);
  const setTheme = useThemeStore((state) => state.setTheme);
  const blurNames = usePrivacyStore((state) => state.blurNames);
  const toggleBlurNames = usePrivacyStore((state) => state.toggleBlurNames);

  return (
    <header className="bg-background/80 sticky top-0 z-40 border-b backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1500px] items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-3">
          <div className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg border">
            <ArrowUpDown className="size-5" />
          </div>
          <div>
            <div className="text-base font-semibold">CC-LB</div>
            <div className="text-muted-foreground hidden text-xs sm:block">Claude Code account balancer</div>
          </div>
        </div>
        <nav className="bg-muted hidden rounded-full p-1 sm:flex">
          {navItems.map((item) => (
            <NavLink
              key={item.href}
              to={item.href}
              end={item.href === "/"}
              className={({ isActive }) =>
                cn(
                  "rounded-full px-4 py-1.5 text-sm transition-colors",
                  isActive ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="icon" onClick={toggleBlurNames} title="Toggle privacy blur">
            {blurNames ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setTheme(preference === "dark" ? "light" : "dark")}
            title="Toggle theme"
          >
            {preference === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        </div>
      </div>
      <nav className="bg-background/80 flex gap-2 overflow-auto border-t px-4 py-2 sm:hidden">
        {navItems.map((item) => (
          <NavLink
            key={item.href}
            to={item.href}
            end={item.href === "/"}
            className={({ isActive }) =>
              cn(
                "rounded-full px-3 py-1.5 text-sm",
                isActive ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
              )
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}

function StatusBar() {
  const settings = trpc.settings.get.useQuery(undefined, { refetchInterval: 10_000 });
  const health = trpc.health.useQuery(undefined, { refetchInterval: 10_000 });

  return (
    <footer className="bg-background/85 fixed right-0 bottom-0 left-0 z-40 border-t backdrop-blur-xl">
      <div className="mx-auto flex h-11 max-w-[1500px] items-center justify-between gap-3 px-4 text-xs text-muted-foreground sm:px-6">
        <div className="flex items-center gap-2">
          <span className={cn("size-2 rounded-full", health.data?.ok ? "bg-emerald-500" : "bg-amber-500")} />
          <span>{health.data?.ok ? "Online" : "Checking"}</span>
          <span className="hidden sm:inline">Strategy: {settings.data?.strategy ?? "priority"}</span>
        </div>
        <a
          className="hover:text-foreground flex items-center gap-1 transition-colors"
          href="https://github.com/daniel100097/cc-lb"
          rel="noreferrer"
          target="_blank"
        >
          <Code2 className="size-3.5" />
          <span>cc-lb</span>
        </a>
      </div>
    </footer>
  );
}

function DashboardPage() {
  const stats = trpc.stats.useQuery(undefined, { refetchInterval: 10_000 });
  const accounts = trpc.accounts.list.useQuery(undefined, { refetchInterval: 10_000 });
  const data = stats.data;

  return (
    <div className="animate-fade-in-up flex flex-col gap-6">
      <PageHeading title="Dashboard" description="Live account pool health and request activity." action={<AddAccountDialog />} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={<KeyRound />} label="Accounts" value={compactNumber(data?.totalAccounts ?? 0)} />
        <StatCard icon={<CheckCircle2 />} label="Available" value={compactNumber(data?.availableAccounts ?? 0)} />
        <StatCard icon={<ShieldAlert />} label="Rate limited" value={compactNumber(data?.rateLimitedAccounts ?? 0)} />
        <StatCard icon={<Activity />} label="Requests today" value={compactNumber(data?.requestsToday ?? 0)} />
      </div>
      <section className="rounded-xl border bg-card p-4">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">Account health</h2>
          {stats.isFetching ? <Loader2 className="text-muted-foreground size-4 animate-spin" /> : null}
        </div>
        <AccountsTable accounts={accounts.data ?? []} compact />
      </section>
    </div>
  );
}

function AccountsPage() {
  const accounts = trpc.accounts.list.useQuery(undefined, { refetchInterval: 10_000 });

  return (
    <div className="animate-fade-in-up flex flex-col gap-6">
      <PageHeading title="Accounts" description="Manage Claude OAuth accounts, priorities, pause state, and reauth flags." action={<AddAccountDialog />} />
      <section className="rounded-xl border bg-card p-4">
        <AccountsTable accounts={accounts.data ?? []} />
      </section>
    </div>
  );
}

function RequestsPage() {
  const [accountId, setAccountId] = useState("all");
  const [outcome, setOutcome] = useState("all");
  const [model, setModel] = useState("all");
  const [timeframe, setTimeframe] = useState<RequestTimeframe>("24h");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const options = trpc.requests.options.useQuery();

  const input = useMemo(
    () => ({
      limit: REQUEST_PAGE_SIZE,
      offset,
      accountId: accountId === "all" ? null : accountId,
      outcome: outcome === "all" ? null : outcome,
      model: model === "all" ? null : model,
      since: sinceForTimeframe(timeframe),
      search: search.trim() || null,
    }),
    [accountId, model, offset, outcome, search, timeframe],
  );

  const requests = trpc.requests.list.useQuery(input, {
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  function resetPaging() {
    setOffset(0);
    setExpandedId(null);
  }

  return (
    <div className="animate-fade-in-up flex flex-col gap-6">
      <PageHeading title="Requests" description="Recent proxy attempts, failover context, token usage, and latency." />
      <section className="rounded-xl border bg-card p-4">
        <div className="grid gap-3 lg:grid-cols-[1fr_1fr_1fr_auto]">
          <FilterSelect
            id="request-account"
            label="Account"
            value={accountId}
            onChange={(value) => {
              setAccountId(value);
              resetPaging();
            }}
            options={[
              { value: "all", label: "All accounts" },
              ...(options.data?.accounts ?? []).map((account) => ({ value: account.id, label: account.name })),
            ]}
          />
          <FilterSelect
            id="request-outcome"
            label="Outcome"
            value={outcome}
            onChange={(value) => {
              setOutcome(value);
              resetPaging();
            }}
            options={[
              { value: "all", label: "All outcomes" },
              ...(options.data?.outcomes ?? []).map((item) => ({ value: item, label: labelFromKey(item) })),
            ]}
          />
          <FilterSelect
            id="request-model"
            label="Model"
            value={model}
            onChange={(value) => {
              setModel(value);
              resetPaging();
            }}
            options={[
              { value: "all", label: "All models" },
              ...(options.data?.models ?? []).map((item) => ({ value: item, label: item })),
            ]}
          />
          <div className="grid gap-2">
            <Label>Window</Label>
            <div className="flex rounded-md border p-1">
              {REQUEST_TIMEFRAMES.map((value) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant={timeframe === value ? "secondary" : "ghost"}
                  onClick={() => {
                    setTimeframe(value);
                    resetPaging();
                  }}
                  className="h-7 flex-1 px-2"
                >
                  {value}
                </Button>
              ))}
            </div>
          </div>
          <div className="grid gap-2 lg:col-span-4">
            <Label htmlFor="request-search">Search</Label>
            <div className="relative">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
              <Input
                id="request-search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  resetPaging();
                }}
                className="pl-9"
                placeholder="Path, model, or error"
              />
            </div>
          </div>
        </div>
      </section>
      <section className="rounded-xl border bg-card p-4">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Request log</h2>
            <p className="text-muted-foreground mt-1 text-sm">{requests.data?.total ?? 0} matching attempts</p>
          </div>
          {requests.isFetching ? <Loader2 className="text-muted-foreground size-4 animate-spin" /> : null}
        </div>
        <RequestsTable
          entries={requests.data?.entries ?? []}
          expandedId={expandedId}
          onToggle={(id) => setExpandedId((current) => (current === id ? null : id))}
        />
        <div className="mt-4 flex items-center justify-between gap-3">
          <Button type="button" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - REQUEST_PAGE_SIZE))}>
            Previous
          </Button>
          <span className="text-muted-foreground text-xs">
            {offset + 1}-{offset + (requests.data?.entries.length ?? 0)} of {requests.data?.total ?? 0}
          </span>
          <Button type="button" variant="outline" disabled={!requests.data?.hasMore} onClick={() => setOffset(offset + REQUEST_PAGE_SIZE)}>
            Next
          </Button>
        </div>
      </section>
    </div>
  );
}

function SettingsPage() {
  const settings = trpc.settings.get.useQuery();
  const strategies = trpc.strategies.useQuery();

  return (
    <div className="animate-fade-in-up flex flex-col gap-6">
      <PageHeading title="Settings" description="Tune routing strategy, sticky sessions, and cooldown behavior." />
      {settings.data ? (
        <SettingsForm settings={settings.data} strategies={strategies.data ?? []} />
      ) : (
        <div className="rounded-xl border bg-card p-6 text-muted-foreground">Loading settings...</div>
      )}
    </div>
  );
}

function PageHeading({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal">{title}</h1>
        <p className="text-muted-foreground mt-1">{description}</p>
      </div>
      {action}
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="card-hover rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-muted-foreground text-sm">{label}</p>
          <p className="mt-2 text-2xl font-semibold">{value}</p>
        </div>
        <div className="bg-primary/10 text-primary flex size-10 items-center justify-center rounded-lg [&_svg]:size-5">
          {icon}
        </div>
      </div>
    </div>
  );
}

function AccountsTable({ accounts, compact = false }: { accounts: Account[]; compact?: boolean }) {
  if (accounts.length === 0) {
    return (
      <EmptyState
        icon={<KeyRound />}
        title="No accounts yet"
        description="Add a Claude credentials JSON or complete the OAuth flow to start balancing requests."
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] text-left">
        <thead className="text-muted-foreground border-b text-xs uppercase">
          <tr>
            <th className="px-2 py-3 font-medium">Name</th>
            <th className="px-2 py-3 font-medium">Status</th>
            <th className="px-2 py-3 font-medium">Priority</th>
            <th className="px-2 py-3 font-medium">Requests</th>
            <th className="px-2 py-3 font-medium">Quota</th>
            <th className="px-2 py-3 font-medium">Window reset</th>
            {!compact ? <th className="px-2 py-3 font-medium">Last used</th> : null}
            <th className="px-2 py-3 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {accounts.map((account) => (
            <AccountRow key={account.id} account={account} compact={compact} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FilterSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function RequestsTable({
  entries,
  expandedId,
  onToggle,
}: {
  entries: RequestEntry[];
  expandedId: number | null;
  onToggle: (id: number) => void;
}) {
  const blurNames = usePrivacyStore((state) => state.blurNames);

  if (entries.length === 0) {
    return (
      <EmptyState
        icon={<Activity />}
        title="No requests found"
        description="Proxy attempts will appear here after Claude Code sends traffic through CC-LB."
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1100px] text-left">
        <thead className="text-muted-foreground border-b text-xs uppercase">
          <tr>
            <th className="px-2 py-3 font-medium">Time</th>
            <th className="px-2 py-3 font-medium">Account</th>
            <th className="px-2 py-3 font-medium">Model</th>
            <th className="px-2 py-3 font-medium">Outcome</th>
            <th className="px-2 py-3 font-medium">HTTP</th>
            <th className="px-2 py-3 font-medium">Tokens</th>
            <th className="px-2 py-3 font-medium">Cost est.</th>
            <th className="px-2 py-3 font-medium">Latency</th>
            <th className="px-2 py-3 text-right font-medium">Attempt</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {entries.map((entry) => (
            <Fragment key={entry.id}>
              <tr className="cursor-pointer align-middle hover:bg-muted/40" onClick={() => onToggle(entry.id)}>
                <td className="px-2 py-3">{relativeTime(entry.ts)}</td>
                <td className="px-2 py-3">
                  <span className={cn(blurNames && "privacy-blur")}>{entry.accountName ?? entry.accountId ?? "Local"}</span>
                </td>
                <td className="max-w-[260px] truncate px-2 py-3 text-xs">{entry.model ?? "-"}</td>
                <td className="px-2 py-3">
                  <StatusBadge status={entry.outcome} />
                </td>
                <td className="px-2 py-3">{entry.status ?? "-"}</td>
                <td className="px-2 py-3">{tokenSummary(entry)}</td>
                <td className="px-2 py-3">{currency(entry.costUsd)}</td>
                <td className="px-2 py-3">{latencyMs(entry.latencyMs ?? entry.totalMs)}</td>
                <td className="px-2 py-3 text-right">{entry.failoverAttempt > 0 ? entry.failoverAttempt : "-"}</td>
              </tr>
              {expandedId === entry.id ? (
                <tr>
                  <td className="bg-muted/30 px-2 py-3 text-xs" colSpan={9}>
                    <RequestDetails entry={entry} />
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RequestDetails({ entry }: { entry: RequestEntry }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      <DetailItem label="Path" value={`${entry.method ?? ""} ${entry.path ?? "-"}`.trim()} />
      <DetailItem label="Upstream request" value={entry.upstreamRequestId ?? "-"} />
      <DetailItem label="Total time" value={latencyMs(entry.totalMs)} />
      <DetailItem
        label="Cache tokens"
        value={`read ${compactOptional(entry.cacheReadTokens)} / create ${compactOptional(entry.cacheCreationTokens)}`}
      />
      {entry.error ? <DetailItem className="sm:col-span-2 xl:col-span-4" label="Error" value={entry.error} /> : null}
    </div>
  );
}

function DetailItem({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className={cn("rounded-md border bg-background px-3 py-2", className)}>
      <div className="text-muted-foreground text-[11px] uppercase">{label}</div>
      <div className="mt-1 break-all">{value}</div>
    </div>
  );
}

function AccountRow({ account, compact }: { account: Account; compact: boolean }) {
  const utils = trpc.useUtils();
  const updateAccount = trpc.accounts.update.useMutation({
    onSuccess: async () => {
      await utils.accounts.list.invalidate();
      await utils.stats.invalidate();
    },
  });
  const deleteAccount = trpc.accounts.delete.useMutation({
    onSuccess: async () => {
      await utils.accounts.list.invalidate();
      await utils.stats.invalidate();
      toast.success("Account deleted");
    },
  });
  const blurNames = usePrivacyStore((state) => state.blurNames);

  async function togglePause() {
    await updateAccount.mutateAsync({ id: account.id, paused: !account.paused });
    toast.success(account.paused ? "Account resumed" : "Account paused");
  }

  async function rename() {
    const nextName = window.prompt("Account name", account.name);
    if (!nextName) return;
    await updateAccount.mutateAsync({ id: account.id, name: nextName });
    toast.success("Account renamed");
  }

  async function remove() {
    if (!window.confirm(`Delete ${account.name}?`)) return;
    await deleteAccount.mutateAsync({ id: account.id });
  }

  return (
    <tr className="align-middle">
      <td className="px-2 py-3">
        <div className="flex items-center gap-2">
          <span className={cn("font-medium", blurNames && "privacy-blur")}>{account.name}</span>
        </div>
        <div className="text-muted-foreground text-xs">{account.id.slice(0, 8)}</div>
      </td>
      <td className="px-2 py-3">
        <StatusBadge status={account.status} />
        {account.tokenHealth.status !== "healthy" ? (
          <div className={cn("mt-1 text-xs", tokenHealthClass(account.tokenHealth.status))}>
            {account.tokenHealth.message}
          </div>
        ) : null}
      </td>
      <td className="px-2 py-3">{account.priority}</td>
      <td className="px-2 py-3">{compactNumber(account.requestCount)}</td>
      <td className="px-2 py-3">
        <MiniQuotaBar remaining={account.rateLimitRemaining} />
      </td>
      <td className="px-2 py-3">{relativeTime(account.rateLimitReset)}</td>
      {!compact ? <td className="px-2 py-3">{relativeTime(account.lastUsed)}</td> : null}
      <td className="px-2 py-3">
        <div className="flex justify-end gap-1">
          <Button type="button" variant="ghost" size="icon" onClick={togglePause} title={account.paused ? "Resume" : "Pause"}>
            {account.paused ? <RotateCcw className="size-4" /> : <Pause className="size-4" />}
          </Button>
          <Button type="button" variant="ghost" size="icon" onClick={rename} title="Rename">
            <MoreHorizontal className="size-4" />
          </Button>
          <ReauthAccountDialog account={account} />
          <Button type="button" variant="ghost" size="icon" onClick={remove} title="Delete">
            <Trash2 className="size-4" />
          </Button>
        </div>
      </td>
    </tr>
  );
}

function AddAccountDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [priority, setPriority] = useState(0);
  const [credentialsText, setCredentialsText] = useState("");
  const [oauthCode, setOauthCode] = useState("");
  const [oauthSession, setOauthSession] = useState<{ authUrl: string; sessionId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const importAccount = trpc.accounts.import.useMutation({
    onSuccess: async () => {
      await afterAccountAdded(utils);
      setOpen(false);
      setCredentialsText("");
      setName("");
      setPriority(0);
      toast.success("Account imported");
    },
    onError: (mutationError) => setError(mutationError.message),
  });
  const beginOAuth = trpc.accounts.oauthBegin.useMutation({
    onSuccess: (result) => {
      setOauthSession(result);
      window.open(result.authUrl, "_blank", "noopener,noreferrer");
    },
    onError: (mutationError) => setError(mutationError.message),
  });
  const completeOAuth = trpc.accounts.oauthComplete.useMutation({
    onSuccess: async () => {
      await afterAccountAdded(utils);
      setOpen(false);
      setOauthCode("");
      setOauthSession(null);
      setName("");
      setPriority(0);
      toast.success("OAuth account added");
    },
    onError: (mutationError) => setError(mutationError.message),
  });

  async function submitCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      const credentials: unknown = JSON.parse(credentialsText);
      await importAccount.mutateAsync({ name: name || undefined, priority, credentials });
    } catch (parseError) {
      const message = parseError instanceof Error ? parseError.message : "Invalid credentials JSON";
      setError(message);
    }
  }

  async function submitOAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!oauthSession) {
      setError("Generate a login link first.");
      return;
    }
    setError(null);
    await completeOAuth.mutateAsync({ sessionId: oauthSession.sessionId, code: oauthCode, name: name || undefined });
  }

  const busy = importAccount.isPending || beginOAuth.isPending || completeOAuth.isPending;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="press-scale">
          <Plus className="size-4" />
          Add Account
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Claude account</DialogTitle>
          <DialogDescription>Import Claude Code credentials or complete Claude OAuth with a copied code.</DialogDescription>
        </DialogHeader>
        <AlertMessage message={error} />
        <div className="grid gap-2">
          <Label htmlFor="account-name">Name</Label>
          <Input id="account-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Claude Max primary" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="account-priority">Priority</Label>
          <Input
            id="account-priority"
            type="number"
            min={0}
            max={10_000}
            value={priority}
            onChange={(event) => setPriority(numberFromInput(event.target.value))}
          />
        </div>
        <Tabs defaultValue="json">
          <TabsList>
            <TabsTrigger value="json">Credentials JSON</TabsTrigger>
            <TabsTrigger value="oauth">OAuth</TabsTrigger>
          </TabsList>
          <TabsContent value="json">
            <form className="grid gap-4" onSubmit={submitCredentials}>
              <div className="grid gap-2">
                <Label htmlFor="credentials">Credentials JSON</Label>
                <Textarea
                  id="credentials"
                  value={credentialsText}
                  onChange={(event) => setCredentialsText(event.target.value)}
                  placeholder='{"claudeAiOauth":{"accessToken":"...","refreshToken":"..."}}'
                />
              </div>
              <DialogFooter>
                <Button type="submit" disabled={busy || credentialsText.trim().length === 0}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                  Import
                </Button>
              </DialogFooter>
            </form>
          </TabsContent>
          <TabsContent value="oauth">
            <form className="grid gap-4" onSubmit={submitOAuth}>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => beginOAuth.mutate({ name: name || undefined, priority })}
                  disabled={busy}
                >
                  {beginOAuth.isPending ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
                  Generate login link
                </Button>
                {oauthSession ? <CopyButton value={oauthSession.authUrl} label="Copy URL" /> : null}
              </div>
              {oauthSession ? (
                <div className="bg-muted text-muted-foreground rounded-md px-3 py-2 text-xs break-all">{oauthSession.authUrl}</div>
              ) : null}
              <div className="grid gap-2">
                <Label htmlFor="oauth-code">Claude code</Label>
                <Input id="oauth-code" value={oauthCode} onChange={(event) => setOauthCode(event.target.value)} placeholder="code#state" />
              </div>
              <DialogFooter>
                <Button type="submit" disabled={busy || !oauthSession || oauthCode.trim().length === 0}>
                  {completeOAuth.isPending ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                  Add OAuth account
                </Button>
              </DialogFooter>
            </form>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function ReauthAccountDialog({ account }: { account: Account }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [session, setSession] = useState<{ authUrl: string; sessionId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const begin = trpc.accounts.oauthReauthBegin.useMutation({
    onSuccess: (result) => {
      setSession(result);
      window.open(result.authUrl, "_blank", "noopener,noreferrer");
    },
    onError: (mutationError) => setError(mutationError.message),
  });
  const complete = trpc.accounts.oauthReauthComplete.useMutation({
    onSuccess: async () => {
      await afterAccountAdded(utils);
      setOpen(false);
      setCode("");
      setSession(null);
      toast.success("Account re-authenticated");
    },
    onError: (mutationError) => setError(mutationError.message),
  });
  const busy = begin.isPending || complete.isPending;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) {
      setError("Generate a login link first.");
      return;
    }
    setError(null);
    await complete.mutateAsync({ sessionId: session.sessionId, code });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="icon" title="Re-authenticate">
          <KeyRound className={cn("size-4", account.tokenHealth.requiresReauth && "text-sky-500")} />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Re-authenticate account</DialogTitle>
          <DialogDescription>This updates tokens for {account.name} without resetting its stats or priority.</DialogDescription>
        </DialogHeader>
        <AlertMessage message={error} />
        <div className={cn("rounded-md border px-3 py-2 text-sm", tokenHealthClass(account.tokenHealth.status))}>
          {account.tokenHealth.message}
        </div>
        <form className="grid gap-4" onSubmit={submit}>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="button" variant="outline" onClick={() => begin.mutate({ id: account.id })} disabled={busy}>
              {begin.isPending ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
              Generate login link
            </Button>
            {session ? <CopyButton value={session.authUrl} label="Copy URL" /> : null}
          </div>
          {session ? (
            <div className="bg-muted text-muted-foreground rounded-md px-3 py-2 text-xs break-all">{session.authUrl}</div>
          ) : null}
          <div className="grid gap-2">
            <Label htmlFor={`reauth-code-${account.id}`}>Claude code</Label>
            <Input
              id={`reauth-code-${account.id}`}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="code#state"
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy || !session || code.trim().length === 0}>
              {complete.isPending ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
              Update tokens
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SettingsForm({
  settings,
  strategies,
}: {
  settings: SettingsValue;
  strategies: { name: string; description: string }[];
}) {
  const [form, setForm] = useState(settings);
  const utils = trpc.useUtils();
  const updateSettings = trpc.settings.update.useMutation({
    onSuccess: async (next) => {
      setForm(next);
      await utils.settings.get.invalidate();
      toast.success("Settings saved");
    },
  });

  useEffect(() => {
    setForm(settings);
  }, [settings]);

  function updateNumber(key: NumberSettingsKey, value: string) {
    const parsed = Number(value);
    setForm((current) => ({ ...current, [key]: Number.isFinite(parsed) ? parsed : 0 }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const strategy = isFrontendStrategyName(form.strategy) ? form.strategy : "priority";
    await updateSettings.mutateAsync({ ...form, strategy });
  }

  const currentStrategy = useMemo(
    () => strategies.find((strategy) => strategy.name === form.strategy),
    [form.strategy, strategies],
  );

  return (
    <form className="grid gap-4 rounded-xl border bg-card p-4 lg:grid-cols-2" onSubmit={submit}>
      <div className="grid gap-2 lg:col-span-2">
        <Label htmlFor="strategy">Routing strategy</Label>
        <select
          id="strategy"
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
          value={form.strategy}
          onChange={(event) => setForm((current) => ({ ...current, strategy: event.target.value }))}
        >
          {strategies.map((strategy) => (
            <option key={strategy.name} value={strategy.name}>
              {strategy.name}
            </option>
          ))}
        </select>
        <p className="text-muted-foreground text-sm">{currentStrategy?.description ?? "Select how accounts are ordered before failover."}</p>
      </div>
      <label className="flex items-center justify-between rounded-lg border p-3">
        <span>
          <span className="block font-medium">Sticky sessions</span>
          <span className="text-muted-foreground text-sm">Pin related Claude Code requests to the same account.</span>
        </span>
        <input
          type="checkbox"
          checked={form.stickySessions}
          onChange={(event) => setForm((current) => ({ ...current, stickySessions: event.target.checked }))}
          className="size-4"
        />
      </label>
      <SettingNumber label="Sticky TTL" value={form.stickyTtlMs} onChange={(value) => updateNumber("stickyTtlMs", value)} helper={durationMs(form.stickyTtlMs)} />
      <SettingNumber
        label="Cooldown base"
        value={form.rateLimitBackoffBaseMs}
        onChange={(value) => updateNumber("rateLimitBackoffBaseMs", value)}
        helper={durationMs(form.rateLimitBackoffBaseMs)}
      />
      <SettingNumber
        label="Cooldown max"
        value={form.rateLimitBackoffMaxMs}
        onChange={(value) => updateNumber("rateLimitBackoffMaxMs", value)}
        helper={durationMs(form.rateLimitBackoffMaxMs)}
      />
      <SettingNumber
        label="Session duration"
        value={form.sessionDurationMs}
        onChange={(value) => updateNumber("sessionDurationMs", value)}
        helper={durationMs(form.sessionDurationMs)}
      />
      <SettingNumber label="Overload retries" value={form.overloadRetryMax} onChange={(value) => updateNumber("overloadRetryMax", value)} helper="Attempts" />
      <div className="flex justify-end lg:col-span-2">
        <Button type="submit" disabled={updateSettings.isPending}>
          {updateSettings.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          Save settings
        </Button>
      </div>
    </form>
  );
}

function SettingNumber({
  label,
  value,
  helper,
  onChange,
}: {
  label: string;
  value: number;
  helper: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-2 rounded-lg border p-3">
      <Label>{label}</Label>
      <Input type="number" value={value} onChange={(event) => onChange(event.target.value)} />
      <span className="text-muted-foreground flex items-center gap-1 text-xs">
        <Clock3 className="size-3" />
        {helper}
      </span>
    </div>
  );
}

function sinceForTimeframe(timeframe: RequestTimeframe): number | null {
  const now = Date.now();
  if (timeframe === "1h") return now - 60 * 60 * 1000;
  if (timeframe === "24h") return now - 24 * 60 * 60 * 1000;
  if (timeframe === "7d") return now - 7 * 24 * 60 * 60 * 1000;
  return null;
}

function tokenSummary(entry: RequestEntry): string {
  if (entry.inputTokens === null && entry.outputTokens === null) return "-";
  return `${compactOptional(entry.inputTokens)} in / ${compactOptional(entry.outputTokens)} out`;
}

function compactOptional(value: number | null): string {
  return value === null ? "-" : compactNumber(value);
}

function labelFromKey(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function afterAccountAdded(utils: ReturnType<typeof trpc.useUtils>) {
  await utils.accounts.list.invalidate();
  await utils.stats.invalidate();
}

function isFrontendStrategyName(value: string): value is StrategyName {
  return strategyNameSet.has(value);
}

function numberFromInput(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function tokenHealthClass(status: Account["tokenHealth"]["status"]): string {
  if (status === "expired" || status === "no_refresh_token") {
    return "text-red-600 dark:text-red-400";
  }
  if (status === "critical") {
    return "text-orange-600 dark:text-orange-400";
  }
  if (status === "warning") {
    return "text-amber-600 dark:text-amber-400";
  }
  return "text-muted-foreground";
}
