import type { FormEvent, ReactNode } from "react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import type { inferRouterOutputs } from "@trpc/server";
import {
  Activity,
  ArrowUpDown,
  Ban,
  BarChart3,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Coins,
  Code2,
  Eye,
  EyeOff,
  Gauge,
  KeyRound,
  LayoutGrid,
  List,
  Loader2,
  Moon,
  MoreHorizontal,
  Pause,
  Pencil,
  Pin,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldAlert,
  Sun,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { AlertMessage } from "@/components/alert-message";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/copy-button";
import { DonutChart } from "@/components/donut-chart";
import { EmptyState } from "@/components/empty-state";
import { MiniQuotaBar } from "@/components/mini-quota-bar";
import { SparklineChart } from "@/components/sparkline-chart";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Toaster } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
type SettingsFormState = SettingsValue & { apiKeyAuthEnabled?: boolean };
type NumberSettingsKey =
  | "stickyTtlMs"
  | "rateLimitBackoffBaseMs"
  | "rateLimitBackoffMaxMs"
  | "sessionDurationMs"
  | "overloadRetryMax"
  | "newSessionUsageCutoffPercent";

type DashboardTimeframe = "1d" | "7d" | "30d";
type AccountViewMode = "cards" | "list";
type StickySortBy = "updated_at" | "account" | "key";
type StickySortDir = "asc" | "desc";
type StickyBackendSortBy = "updated_at" | "account_name" | "key";

type ApiKeyUsageSummary = {
  requestCount?: number;
  totalTokens?: number;
  tokenTotal?: number;
  cachedInputTokens?: number;
  cachedTokenTotal?: number;
  totalCostUsd?: number;
  costUsd?: number;
};

type ApiKey = {
  id: string;
  name: string;
  keyPrefix?: string;
  prefix?: string;
  status?: string;
  computedStatus?: string;
  allowedModels?: string[] | null;
  accountScopeEnabled?: boolean;
  assignedAccountIds?: string[];
  expiresAt?: string | number | null;
  isActive?: boolean;
  active?: boolean;
  createdAt?: string | number | null;
  lastUsedAt?: string | number | null;
  usage?: ApiKeyUsageSummary | null;
  usageSummary?: ApiKeyUsageSummary | null;
};

type ApiKeyCreateInput = {
  name: string;
  allowedModels?: string[];
  expiresAt?: number | null;
};

type ApiKeyUpdateInput = {
  id: string;
  name?: string;
  allowedModels?: string[] | null;
  expiresAt?: number | null;
  isActive?: boolean;
};

type ApiKeySecretOutput = { apiKey?: ApiKey; plaintextKey?: string; key?: string; token?: string };
type ApiKeyTrendPoint = { t?: string | number; v?: number; value?: number; cost?: number; tokens?: number };
type ApiKeyTrends = { keyId?: string; cost?: ApiKeyTrendPoint[]; tokens?: ApiKeyTrendPoint[] };
type ApiKeyAccountCost = { accountId?: string | null; email?: string | null; name?: string | null; costUsd?: number; isDeleted?: boolean };
type ApiKeyUsage7d = {
  keyId?: string;
  totalTokens?: number;
  totalCostUsd?: number;
  totalRequests?: number;
  cachedInputTokens?: number;
  accountCosts?: ApiKeyAccountCost[];
};

type StickySessionEntry = {
  key: string;
  kind: string;
  displayName?: string;
  accountId?: string | null;
  accountName?: string | null;
  createdAt?: string | number | null;
  updatedAt: string | number;
  expiresAt?: string | number | null;
  isStale?: boolean;
  stale?: boolean;
  ageMs?: number;
};

type StickySessionTarget = { key: string; kind: string };
type StickySessionsResponse = {
  entries?: StickySessionEntry[];
  total?: number;
  hasMore?: boolean;
  stalePromptCacheCount?: number;
  staleCount?: number;
};

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
  { href: "/apis", label: "APIs" },
  { href: "/requests", label: "Requests" },
  { href: "/sticky", label: "Sticky" },
  { href: "/settings", label: "Settings" },
];

const REQUEST_PAGE_SIZE = 25;
type RequestTimeframe = "1h" | "24h" | "7d" | "all";
const REQUEST_TIMEFRAMES: RequestTimeframe[] = ["1h", "24h", "7d", "all"];
const DASHBOARD_TIMEFRAMES: Array<{ value: DashboardTimeframe; label: string }> = [
  { value: "1d", label: "1D" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
];
const STICKY_PAGE_SIZE = 10;

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
          <Route path="/apis" element={<ApisPage />} />
          <Route path="/requests" element={<RequestsPage />} />
          <Route path="/sticky" element={<StickySessionsPage />} />
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
  const [timeframe, setTimeframe] = useState<DashboardTimeframe>("7d");
  const [accountViewMode, setAccountViewMode] = useState<AccountViewMode>("cards");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const overview = trpc.analytics.overview.useQuery(
    { range: timeframe },
    { refetchInterval: 30_000, retry: false, refetchOnWindowFocus: true },
  );
  const stats = trpc.stats.useQuery(undefined, { refetchInterval: 10_000 });
  const accounts = trpc.accounts.list.useQuery(undefined, { refetchInterval: 10_000 });
  // since must be referentially stable per timeframe: a fresh Date.now()-based
  // value on every render would change the query key each render, so the query
  // never settles (perma-loading empty panel + a refetch storm).
  const recentRequestsInput = useMemo(
    () => ({
      limit: 8,
      offset: 0,
      accountId: null,
      outcome: null,
      model: null,
      since: sinceForDashboardTimeframe(timeframe),
      search: null,
    }),
    [timeframe],
  );
  const recentRequests = trpc.requests.list.useQuery(recentRequestsInput, {
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  const dashboardStats = buildDashboardStats(overview.data, stats.data, accounts.data ?? [], recentRequests.data?.entries ?? []);
  const primaryDonut = buildDashboardDonut(overview.data, accounts.data ?? [], "primary");
  const weeklyDonut = buildDashboardDonut(overview.data, accounts.data ?? [], "secondary");
  const weeklyPace = buildWeeklyPace(overview.data, weeklyDonut.total, weeklyDonut.centerValue);
  const isRefreshing = overview.isFetching || stats.isFetching || accounts.isFetching || recentRequests.isFetching;

  async function refresh() {
    await Promise.all([overview.refetch(), stats.refetch(), accounts.refetch(), recentRequests.refetch()]);
  }

  return (
    <div className="animate-fade-in-up flex flex-col gap-6">
      <PageHeading
        title="Dashboard"
        description="Live account pool health, credit pace, and recent request activity."
        action={
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="flex rounded-md border p-1">
              {DASHBOARD_TIMEFRAMES.map((item) => (
                <Button
                  key={item.value}
                  type="button"
                  size="sm"
                  variant={timeframe === item.value ? "secondary" : "ghost"}
                  onClick={() => setTimeframe(item.value)}
                  className="h-7 px-3"
                >
                  {item.label}
                </Button>
              ))}
            </div>
            <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={isRefreshing}>
              <RefreshCw className={cn("size-4", isRefreshing && "animate-spin")} />
              Refresh
            </Button>
            <AddAccountDialog />
          </div>
        }
      />
      <AlertMessage message={overview.error && !overview.data ? "Detailed dashboard data is unavailable; showing local account and request fallback data." : null} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {dashboardStats.map((stat, index) => (
          <DashboardMetricCard key={stat.label} stat={stat} index={index} />
        ))}
      </div>
      <ConnectClaudeCodeCard />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)]">
        <div className="grid gap-4 lg:grid-cols-2">
          <DonutChart
            title="5-Hour Credits"
            subtitle="Account pool headroom"
            items={primaryDonut.items}
            total={primaryDonut.total}
            centerValue={primaryDonut.centerValue}
            centerLayout="credits"
          />
          <DonutChart
            title="Weekly Credits"
            subtitle="Long window capacity"
            items={weeklyDonut.items}
            total={weeklyDonut.total}
            centerValue={weeklyDonut.centerValue}
            centerLayout="credits"
          />
        </div>
        <WeeklyPaceCard pace={weeklyPace} />
      </div>
      <section className="space-y-4">
        <SectionHeader
          title="Accounts"
          meta={`${compactNumber(accounts.data?.length ?? 0)} connected · ${compactNumber(stats.data?.availableAccounts ?? 0)} available`}
          action={
            <SegmentedIconToggle
              value={accountViewMode}
              options={[
                { value: "cards", label: "Cards", icon: <LayoutGrid className="size-4" /> },
                { value: "list", label: "List", icon: <List className="size-4" /> },
              ]}
              onChange={setAccountViewMode}
            />
          }
        />
        {accountViewMode === "cards" ? <AccountSummaryCards accounts={accounts.data ?? []} /> : <AccountsTable accounts={accounts.data ?? []} compact />}
      </section>
      <section className="rounded-xl border bg-card p-4">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Recent request logs</h2>
            <p className="text-muted-foreground mt-1 text-sm">Latest proxy attempts stay available from the dashboard.</p>
          </div>
          <Button asChild type="button" variant="outline" size="sm">
            <NavLink to="/requests">Open Requests</NavLink>
          </Button>
        </div>
        <RequestsTable
          entries={recentRequests.data?.entries ?? []}
          expandedId={expandedId}
          onToggle={(id) => setExpandedId((current) => (current === id ? null : id))}
        />
      </section>
    </div>
  );
}

function ConnectClaudeCodeCard() {
  const settings = trpc.settings.get.useQuery();
  const apiKeyAuthEnabled = Boolean(settings.data?.apiKeyAuthEnabled);
  const origin = window.location.origin;
  const tokenValue = apiKeyAuthEnabled ? "<your cc-lb API key>" : "cc-lb";
  const snippet = `export ANTHROPIC_BASE_URL=${origin}\nexport ANTHROPIC_AUTH_TOKEN=${tokenValue}`;

  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-semibold">
            <Code2 className="size-4" />
            Connect Claude Code
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Set these environment variables to route Claude Code through this proxy.
          </p>
        </div>
        <CopyButton value={snippet} label="Copy env vars" />
      </div>
      <pre className="bg-muted/50 mt-3 overflow-x-auto rounded-md border p-3 font-mono text-xs leading-relaxed">
        <code>{snippet}</code>
      </pre>
      <p className="text-muted-foreground mt-2 text-xs">
        {apiKeyAuthEnabled
          ? "API key auth is enabled: create a key on the APIs page and use its secret as ANTHROPIC_AUTH_TOKEN."
          : "API key auth is disabled: any non-empty ANTHROPIC_AUTH_TOKEN works — the proxy replaces it with the routed account's OAuth token."}
      </p>
    </section>
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

function ApisPage() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null);
  const [deletingKey, setDeletingKey] = useState<ApiKey | null>(null);
  const apiKeysQuery = trpc.apiKeys.list.useQuery(undefined, {
    refetchInterval: 30_000,
    retry: false,
    refetchOnWindowFocus: true,
  });
  const apiKeys = useMemo(() => normalizeApiKeys(apiKeysQuery.data), [apiKeysQuery.data]);
  const selectedApiKey = useMemo(() => {
    if (apiKeys.length === 0) return null;
    if (selectedKeyId) {
      const match = apiKeys.find((apiKey) => apiKey.id === selectedKeyId);
      if (match) return match;
    }
    return apiKeys[0] ?? null;
  }, [apiKeys, selectedKeyId]);
  const trendsQuery = trpc.apiKeys.analytics.useQuery(
    { id: selectedApiKey?.id ?? "", range: "7d" },
    { enabled: Boolean(selectedApiKey), refetchInterval: 300_000, retry: false },
  );
  const usage7dQuery = trpc.apiKeys.analytics.useQuery(
    { id: selectedApiKey?.id ?? "", range: "7d" },
    { enabled: Boolean(selectedApiKey), refetchInterval: 120_000, retry: false },
  );
  const createKey = trpc.apiKeys.create.useMutation({
    onError: (error) => toast.error(error.message || "Failed to create API key"),
    onSuccess: async (result) => {
      setCreatedKey(extractApiKeySecret(result));
      setCreateOpen(false);
      await apiKeysQuery.refetch();
      toast.success("API key created");
    },
  });
  const updateKey = trpc.apiKeys.update.useMutation({
    onError: (error) => toast.error(error.message || "Failed to update API key"),
    onSuccess: async () => {
      setEditingKey(null);
      await apiKeysQuery.refetch();
      toast.success("API key updated");
    },
  });
  const deleteKey = trpc.apiKeys.delete.useMutation({
    onError: (error) => toast.error(error.message || "Failed to delete API key"),
    onSuccess: async () => {
      setDeletingKey(null);
      await apiKeysQuery.refetch();
      toast.success("API key deleted");
    },
  });
  const regenerateKey = trpc.apiKeys.regenerate.useMutation({
    onError: (error) => toast.error(error.message || "Failed to regenerate API key"),
    onSuccess: async (result) => {
      setCreatedKey(extractApiKeySecret(result));
      await Promise.all([apiKeysQuery.refetch(), trendsQuery.refetch(), usage7dQuery.refetch()]);
      toast.success("API key regenerated");
    },
  });
  const filteredKeys = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return apiKeys.filter((apiKey) => {
      if (statusFilter !== "all" && apiKeyStatus(apiKey) !== statusFilter) return false;
      if (!needle) return true;
      return apiKey.name.toLowerCase().includes(needle) || apiKeyPrefix(apiKey).toLowerCase().includes(needle);
    });
  }, [apiKeys, search, statusFilter]);
  const trends = normalizeApiKeyTrends(trendsQuery.data);
  const usage7d = normalizeApiKeyUsage7d(usage7dQuery.data);
  const busy = createKey.isPending || updateKey.isPending || deleteKey.isPending || regenerateKey.isPending;

  return (
    <div className="animate-fade-in-up flex flex-col gap-6">
      <PageHeading
        title="APIs"
        description="Manage API keys for client access and inspect key-level usage."
        action={<Button onClick={() => setCreateOpen(true)}><Plus className="size-4" />Create Key</Button>}
      />
      <AlertMessage message={apiKeysQuery.error && !apiKeysQuery.data ? "API key procedures are unavailable or still loading." : null} />
      <ApiKeyAuthSettingPanel />
      <ApiKeysOverview keys={apiKeys} />
      <div className="grid gap-4 xl:grid-cols-[22rem_minmax(0,1fr)]">
        <section className="rounded-xl border bg-card p-4">
          <div className="grid gap-3">
            <div className="relative">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9" placeholder="Search API keys" />
            </div>
            <FilterSelect
              id="api-key-status"
              label="Status"
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: "all", label: "All statuses" },
                { value: "active", label: "Active" },
                { value: "disabled", label: "Disabled" },
                { value: "expired", label: "Expired" },
              ]}
            />
            <div className="max-h-[36rem] space-y-2 overflow-y-auto pr-1">
              {filteredKeys.length === 0 ? (
                <EmptyState
                  icon={<KeyRound />}
                  title="No API keys"
                  description={apiKeys.length === 0 ? "Create an API key to allow client access." : "No API keys match the current filters."}
                  className="min-h-56"
                />
              ) : (
                filteredKeys.map((apiKey) => (
                  <ApiKeyListItem
                    key={apiKey.id}
                    apiKey={apiKey}
                    selected={selectedApiKey?.id === apiKey.id}
                    onSelect={() => setSelectedKeyId(apiKey.id)}
                  />
                ))
              )}
            </div>
          </div>
        </section>
        <ApiKeyDetail
          apiKey={selectedApiKey}
          trends={trends}
          usage7d={usage7d}
          usageLoading={usage7dQuery.isFetching}
          busy={busy}
          onEdit={setEditingKey}
          onDelete={setDeletingKey}
          onRegenerate={(apiKey) => regenerateKey.mutate({ id: apiKey.id })}
          onToggleActive={(apiKey) => updateKey.mutate({ id: apiKey.id, isActive: !apiKeyIsActive(apiKey) })}
        />
      </div>
      <ApiKeyCreateDialog open={createOpen} busy={createKey.isPending} onOpenChange={setCreateOpen} onSubmit={(input) => createKey.mutateAsync(input)} />
      <ApiKeyEditDialog apiKey={editingKey} busy={updateKey.isPending} onOpenChange={(open) => !open && setEditingKey(null)} onSubmit={(input) => updateKey.mutateAsync(input)} />
      <ApiKeyCreatedDialog apiKey={createdKey} onOpenChange={(open) => !open && setCreatedKey(null)} />
      <ConfirmDialog
        open={Boolean(deletingKey)}
        title="Delete API key"
        description={deletingKey ? `${deletingKey.name} will stop working immediately.` : undefined}
        confirmLabel="Delete"
        confirmDisabled={!deletingKey || deleteKey.isPending}
        onOpenChange={(open) => !open && setDeletingKey(null)}
        onConfirm={() => {
          if (deletingKey) deleteKey.mutate({ id: deletingKey.id });
        }}
      />
    </div>
  );
}

function StickySessionsPage() {
  const [accountQuery, setAccountQuery] = useState("");
  const [keyQuery, setKeyQuery] = useState("");
  const [sortBy, setSortBy] = useState<StickySortBy>("updated_at");
  const [sortDir, setSortDir] = useState<StickySortDir>("desc");
  const [offset, setOffset] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<StickySessionTarget | null>(null);
  const [deleteSelectedOpen, setDeleteSelectedOpen] = useState(false);
  const [deleteFilteredOpen, setDeleteFilteredOpen] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const params = useMemo<Parameters<typeof trpc.stickySessions.list.useQuery>[0]>(
    () => ({
      accountQuery,
      search: keyQuery,
      sortBy: toStickyBackendSortBy(sortBy),
      sortDirection: sortDir,
      offset,
      limit: STICKY_PAGE_SIZE,
    }),
    [accountQuery, keyQuery, offset, sortBy, sortDir],
  );
  const sessionsQuery = trpc.stickySessions.list.useQuery(params, {
    refetchInterval: 30_000,
    retry: false,
    refetchOnWindowFocus: true,
  });
  const sessions = normalizeStickySessions(sessionsQuery.data);
  const visibleIds = useMemo(() => new Set(sessions.entries.map(stickySessionRowId)), [sessions.entries]);
  const selectedTargets = useMemo(
    () => sessions.entries.filter((entry) => selectedIds.includes(stickySessionRowId(entry))).map(stickySessionTarget),
    [selectedIds, sessions.entries],
  );
  const selectedCount = selectedTargets.length;
  const allVisibleSelected = sessions.entries.length > 0 && selectedCount === sessions.entries.length;
  const someVisibleSelected = selectedCount > 0 && !allVisibleSelected;
  const hasFilters = accountQuery.trim().length > 0 || keyQuery.trim().length > 0;
  const deleteSessions = trpc.stickySessions.deleteSelected.useMutation({
    onError: (error) => toast.error(error.message || "Failed to delete sticky sessions"),
    onSuccess: async (result) => {
      setSelectedIds([]);
      await sessionsQuery.refetch();
      toast.success(`Deleted ${compactNumber(result.deletedCount ?? Math.max(1, selectedTargets.length))} sticky sessions`);
    },
  });
  const deleteFiltered = trpc.stickySessions.deleteFiltered.useMutation({
    onError: (error) => toast.error(error.message || "Failed to delete filtered sticky sessions"),
    onSuccess: async (result) => {
      setSelectedIds([]);
      setOffset(0);
      await sessionsQuery.refetch();
      toast.success(`Deleted ${compactNumber(result.deletedCount ?? 0)} filtered sessions`);
    },
  });
  const purgeStale = trpc.stickySessions.purgeStale.useMutation({
    onError: (error) => toast.error(error.message || "Failed to purge stale sticky sessions"),
    onSuccess: async (result) => {
      setSelectedIds([]);
      await sessionsQuery.refetch();
      toast.success(`Purged ${compactNumber(result.deletedCount ?? 0)} stale sessions`);
    },
  });
  const busy = deleteSessions.isPending || deleteFiltered.isPending || purgeStale.isPending;

  function updateSort(nextSortBy: StickySortBy) {
    if (sortBy !== nextSortBy) {
      setSortBy(nextSortBy);
      setSortDir(nextSortBy === "updated_at" ? "desc" : "asc");
      setOffset(0);
      return;
    }
    setSortDir((current) => (current === "asc" ? "desc" : "asc"));
    setOffset(0);
  }

  function toggleSelected(entry: StickySessionEntry, checked: boolean) {
    const id = stickySessionRowId(entry);
    setSelectedIds((current) => (checked ? Array.from(new Set([...current, id])) : current.filter((item) => item !== id)));
  }

  function toggleAllVisible(checked: boolean) {
    setSelectedIds((current) => {
      const hidden = current.filter((id) => !visibleIds.has(id));
      return checked ? [...hidden, ...sessions.entries.map(stickySessionRowId)] : hidden;
    });
  }

  return (
    <div className="animate-fade-in-up flex flex-col gap-6">
      <PageHeading title="Sticky" description="Inspect and clear account affinity mappings created by sticky session routing." />
      <AlertMessage message={sessionsQuery.error && !sessionsQuery.data ? "Sticky session procedures are unavailable or still loading." : null} />
      <section className="space-y-4 rounded-xl border bg-card p-4">
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="sticky-account-filter">Account filter</Label>
            <Input
              id="sticky-account-filter"
              value={accountQuery}
              onChange={(event) => {
                setAccountQuery(event.target.value);
                setOffset(0);
              }}
              placeholder="Account name or id"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="sticky-key-filter">Key filter</Label>
            <Input
              id="sticky-key-filter"
              value={keyQuery}
              onChange={(event) => {
                setKeyQuery(event.target.value);
                setOffset(0);
              }}
              placeholder="Session, thread, or cache key"
            />
          </div>
        </div>
        <div className="flex flex-col gap-3 rounded-lg border px-3 py-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="grid gap-2 text-sm sm:grid-cols-3">
            <CountPill label="Visible" value={sessions.total} />
            <CountPill label="Stale" value={sessions.stalePromptCacheCount} />
            <CountPill label="Selected" value={selectedCount} />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button type="button" variant="outline" size="sm" disabled={busy || !hasFilters || sessions.total === 0} onClick={() => setDeleteFilteredOpen(true)}>
              <Trash2 className="size-4" />
              Delete Filtered
            </Button>
            <Button type="button" variant="destructive" size="sm" disabled={busy || selectedCount === 0} onClick={() => setDeleteSelectedOpen(true)}>
              <Trash2 className="size-4" />
              Delete Selected
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={busy || sessions.stalePromptCacheCount === 0} onClick={() => setPurgeOpen(true)}>
              <RefreshCw className="size-4" />
              Purge Stale
            </Button>
          </div>
        </div>
        {sessions.entries.length === 0 ? (
          <EmptyState
            icon={<Pin />}
            title="No sticky sessions"
            description={sessions.total > 0 ? "No rows are visible on this page." : "Sticky mappings appear here after routed requests create them."}
          />
        ) : (
          <div className="rounded-xl border">
            <Table className="min-w-[940px] table-fixed">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-12 pl-4">
                    <Checkbox
                      aria-label="Select all visible sticky sessions"
                      checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
                      disabled={busy}
                      onCheckedChange={(checked) => toggleAllVisible(checked === true)}
                    />
                  </TableHead>
                  <TableHead className="w-[28%] text-xs uppercase text-muted-foreground">
                    <SortableHeader active={sortBy === "key"} dir={sortDir} onClick={() => updateSort("key")}>Key</SortableHeader>
                  </TableHead>
                  <TableHead className="w-36 text-xs uppercase text-muted-foreground">Kind</TableHead>
                  <TableHead className="w-[22%] text-xs uppercase text-muted-foreground">
                    <SortableHeader active={sortBy === "account"} dir={sortDir} onClick={() => updateSort("account")}>Account</SortableHeader>
                  </TableHead>
                  <TableHead className="w-40 text-xs uppercase text-muted-foreground">
                    <SortableHeader active={sortBy === "updated_at"} dir={sortDir} onClick={() => updateSort("updated_at")}>Updated</SortableHeader>
                  </TableHead>
                  <TableHead className="w-36 text-xs uppercase text-muted-foreground">Expiry</TableHead>
                  <TableHead className="w-24 pr-4 text-right text-xs uppercase text-muted-foreground">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.entries.map((entry) => {
                  const selected = selectedIds.includes(stickySessionRowId(entry));
                  return (
                    <TableRow key={stickySessionRowId(entry)} data-state={selected ? "selected" : undefined}>
                      <TableCell className="pl-4">
                        <Checkbox
                          aria-label={`Select sticky session ${entry.key}`}
                          checked={selected}
                          disabled={busy}
                          onCheckedChange={(checked) => toggleSelected(entry, checked === true)}
                        />
                      </TableCell>
                      <TableCell className="truncate font-mono text-xs" title={entry.key}>{entry.key}</TableCell>
                      <TableCell><Badge variant="outline">{stickyKindLabel(entry.kind)}</Badge></TableCell>
                      <TableCell className="truncate text-xs">{entry.displayName}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatDateish(entry.updatedAt)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {entry.isStale ? <Badge variant="secondary">Stale</Badge> : entry.expiresAt ? formatDateish(entry.expiresAt) : "Durable"}
                      </TableCell>
                      <TableCell className="pr-4 text-right">
                        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setDeleteTarget(stickySessionTarget(entry))}>
                          Remove
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        <PaginationFooter
          offset={offset}
          limit={STICKY_PAGE_SIZE}
          total={sessions.total}
          hasMore={sessions.hasMore}
          onPrevious={() => setOffset(Math.max(0, offset - STICKY_PAGE_SIZE))}
          onNext={() => setOffset(offset + STICKY_PAGE_SIZE)}
        />
      </section>
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Remove sticky session"
        description={deleteTarget ? `${stickyKindLabel(deleteTarget.kind)} mapping ${deleteTarget.key} will stop pinning future requests.` : undefined}
        confirmLabel="Delete"
        confirmDisabled={!deleteTarget || busy}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) deleteSessions.mutate({ keys: [deleteTarget.key] });
        }}
      />
      <ConfirmDialog
        open={deleteSelectedOpen}
        title="Delete selected sticky sessions"
        description={`Delete ${compactNumber(selectedCount)} selected sticky sessions?`}
        confirmLabel="Delete Selected"
        confirmDisabled={selectedCount === 0 || busy}
        onOpenChange={setDeleteSelectedOpen}
        onConfirm={() => deleteSessions.mutate({ keys: selectedTargets.map((target) => target.key) })}
      />
      <ConfirmDialog
        open={deleteFilteredOpen}
        title="Delete filtered sticky sessions"
        description={`Delete ${compactNumber(sessions.total)} sticky sessions matching the current filters?`}
        confirmLabel="Delete Filtered"
        confirmDisabled={!hasFilters || sessions.total === 0 || busy}
        onOpenChange={setDeleteFilteredOpen}
        onConfirm={() => deleteFiltered.mutate({ accountQuery, search: keyQuery })}
      />
      <ConfirmDialog
        open={purgeOpen}
        title="Purge stale prompt-cache mappings"
        description="Only stale mappings will be removed. Durable sticky rows remain intact."
        confirmLabel="Purge"
        confirmDisabled={sessions.stalePromptCacheCount === 0 || busy}
        onOpenChange={setPurgeOpen}
        onConfirm={() => purgeStale.mutate()}
      />
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

function SectionHeader({ title, meta, action }: { title: string; meta?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 items-center gap-3">
        <h2 className="text-muted-foreground text-[13px] font-medium tracking-wider uppercase">{title}</h2>
        {meta ? <span className="text-muted-foreground truncate text-xs">{meta}</span> : null}
      </div>
      <div className="bg-border hidden h-px min-w-8 flex-1 sm:block" />
      {action}
    </div>
  );
}

function SegmentedIconToggle<TValue extends string>({
  value,
  options,
  onChange,
}: {
  value: TValue;
  options: { value: TValue; label: string; icon: ReactNode }[];
  onChange: (value: TValue) => void;
}) {
  return (
    <div className="flex rounded-md border p-1">
      {options.map((option) => (
        <Button
          key={option.value}
          type="button"
          size="sm"
          variant={value === option.value ? "secondary" : "ghost"}
          className="h-7 px-2"
          onClick={() => onChange(option.value)}
          title={option.label}
        >
          {option.icon}
          <span className="sr-only">{option.label}</span>
        </Button>
      ))}
    </div>
  );
}

type DashboardMetric = {
  label: string;
  value: string;
  meta?: string;
  icon: ReactNode;
  trend: { value: number }[];
  color: string;
};

function DashboardMetricCard({ stat, index }: { stat: DashboardMetric; index: number }) {
  return (
    <div className="card-hover rounded-xl border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-muted-foreground text-[11px] font-medium tracking-wider uppercase">{stat.label}</p>
          <p className="mt-1 truncate text-[1.65rem] leading-tight font-semibold tabular-nums">{stat.value}</p>
          {stat.meta ? <p className="text-muted-foreground mt-1 truncate text-xs">{stat.meta}</p> : null}
        </div>
        <div className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg [&_svg]:size-4">
          {stat.icon}
        </div>
      </div>
      <div className="mt-2 h-10">
        <SparklineChart data={stat.trend} color={stat.color} index={index} />
      </div>
    </div>
  );
}

function WeeklyPaceCard({ pace }: { pace: { usedPercent: number; scheduledPercent: number; remaining: number; status: string; gapLabel: string } }) {
  const usedWidth = Math.max(0, Math.min(100, pace.usedPercent));
  const scheduledLeft = Math.max(0, Math.min(100, pace.scheduledPercent));
  const tone =
    pace.status === "ahead"
      ? "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300"
      : pace.status === "danger"
        ? "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300"
        : "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";

  return (
    <section className="rounded-xl border bg-card p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Weekly pace</h3>
          <p className="text-muted-foreground mt-0.5 text-xs">Projected use against the current weekly window.</p>
        </div>
        <div className={cn("flex size-9 items-center justify-center rounded-lg border", tone)}>
          <Gauge className="size-4" />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
        <MiniMetric label="Used now" value={`${Math.round(pace.usedPercent)}%`} />
        <MiniMetric label="Scheduled" value={`${Math.round(pace.scheduledPercent)}%`} />
        <MiniMetric label="Remaining" value={compactNumber(pace.remaining)} />
      </div>
      <div className="mt-4 space-y-2">
        <div className="bg-muted relative h-2 rounded-full">
          <div className="bg-primary h-full rounded-full" style={{ width: `${usedWidth}%` }} />
          <div className="bg-foreground/70 absolute top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full" style={{ left: `${scheduledLeft}%` }} />
        </div>
        <div className="text-muted-foreground flex items-center justify-between gap-3 text-xs">
          <span>Actual</span>
          <span>{pace.gapLabel}</span>
        </div>
      </div>
    </section>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted/30 min-w-0 rounded-md px-3 py-2">
      <p className="text-muted-foreground truncate text-xs">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function AccountSummaryCards({ accounts }: { accounts: Account[] }) {
  const blurNames = usePrivacyStore((state) => state.blurNames);

  if (accounts.length === 0) {
    return (
      <EmptyState
        icon={<KeyRound />}
        title="No accounts yet"
        description="Sign in through the Claude Code CLI to start balancing requests."
      />
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {accounts.map((account) => (
        <div key={account.id} className="rounded-xl border bg-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className={cn("truncate font-medium", blurNames && "privacy-blur")}>{account.name}</p>
              <p className="text-muted-foreground mt-1 font-mono text-xs">{account.id.slice(0, 10)}</p>
            </div>
            <StatusBadge status={account.status} />
          </div>
          <div className="mt-4 grid gap-3">
            <MiniQuotaBar percentRemaining={quotaRemainingPercent(account)} />
            <div className="grid grid-cols-3 gap-2 text-xs">
              <MiniMetric label="Priority" value={String(account.priority)} />
              <MiniMetric label="Requests" value={compactNumber(account.requestCount)} />
              <MiniMetric label="Reset" value={relativeTime(account.rateLimitReset)} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function CountPill({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-medium tabular-nums">{compactNumber(value)}</span>
    </div>
  );
}

function ApiKeyAuthSettingPanel() {
  const settings = trpc.settings.get.useQuery();
  const utils = trpc.useUtils();
  const update = trpc.settings.update.useMutation({
    onSuccess: async () => {
      await utils.settings.get.invalidate();
      toast.success("API key auth updated");
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h2 className="font-semibold">API Key Auth</h2>
        <p className="text-muted-foreground mt-1 text-sm">Require API keys for protected proxy requests.</p>
      </div>
      <Switch
        checked={Boolean(settings.data?.apiKeyAuthEnabled)}
        disabled={!settings.data || update.isPending}
        onCheckedChange={(checked) => update.mutate({ apiKeyAuthEnabled: checked })}
      />
    </section>
  );
}

function ApiKeysOverview({ keys }: { keys: ApiKey[] }) {
  const active = keys.filter(apiKeyIsActive).length;
  const used = keys.filter((key) => key.lastUsedAt).length;
  const usage = keys.reduce(
    (sum, key) => {
      const keyUsage = apiKeyUsage(key);
      return {
        requests: sum.requests + (keyUsage.requestCount ?? 0),
        tokens: sum.tokens + (keyUsage.totalTokens ?? keyUsage.tokenTotal ?? 0),
        cached: sum.cached + (keyUsage.cachedInputTokens ?? keyUsage.cachedTokenTotal ?? 0),
        cost: sum.cost + (keyUsage.totalCostUsd ?? keyUsage.costUsd ?? 0),
      };
    },
    { requests: 0, tokens: 0, cached: 0, cost: 0 },
  );
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <StatCard icon={<KeyRound />} label="API Keys" value={compactNumber(keys.length)} />
      <StatCard icon={<CheckCircle2 />} label="Active Keys" value={compactNumber(active)} />
      <StatCard icon={<Activity />} label="Used Keys" value={compactNumber(used)} />
      <StatCard icon={<BarChart3 />} label="30d Requests" value={compactNumber(usage.requests)} />
      <StatCard icon={<CircleDollarSign />} label="30d Cost" value={currency(usage.cost)} />
    </div>
  );
}

function ApiKeyListItem({ apiKey, selected, onSelect }: { apiKey: ApiKey; selected: boolean; onSelect: () => void }) {
  const usage = apiKeyUsage(apiKey);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn("w-full rounded-lg border p-3 text-left transition-colors hover:bg-muted/40", selected && "border-primary bg-primary/10")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{apiKey.name}</p>
          <p className="text-muted-foreground mt-1 truncate font-mono text-xs">{apiKeyPrefix(apiKey)}</p>
        </div>
        <Badge variant={apiKeyIsActive(apiKey) ? "default" : "secondary"}>{labelFromKey(apiKeyStatus(apiKey))}</Badge>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <MiniQuotaBar percentRemaining={null} />
        <div className="text-right text-xs text-muted-foreground">{currency(usage.totalCostUsd ?? usage.costUsd ?? 0)}</div>
      </div>
    </button>
  );
}

function ApiKeyDetail({
  apiKey,
  trends,
  usage7d,
  usageLoading,
  busy,
  onEdit,
  onDelete,
  onRegenerate,
  onToggleActive,
}: {
  apiKey: ApiKey | null;
  trends: ApiKeyTrends;
  usage7d: ApiKeyUsage7d;
  usageLoading: boolean;
  busy: boolean;
  onEdit: (apiKey: ApiKey) => void;
  onDelete: (apiKey: ApiKey) => void;
  onRegenerate: (apiKey: ApiKey) => void;
  onToggleActive: (apiKey: ApiKey) => void;
}) {
  if (!apiKey) {
    return (
      <section className="rounded-xl border bg-card p-10">
        <EmptyState icon={<KeyRound />} title="Select an API key" description="Choose or create a key to inspect usage." />
      </section>
    );
  }
  const accountCosts = usage7d.accountCosts ?? [];
  return (
    <section className="space-y-4 rounded-xl border bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{apiKey.name}</h2>
          <p className="text-muted-foreground mt-1 truncate font-mono text-xs">{apiKeyPrefix(apiKey)}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" disabled={busy}>
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onEdit(apiKey)}><Pencil className="size-4" />Edit</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onRegenerate(apiKey)}><RefreshCw className="size-4" />Regenerate</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onToggleActive(apiKey)}>
              {apiKeyIsActive(apiKey) ? <Ban className="size-4" /> : <Play className="size-4" />}
              {apiKeyIsActive(apiKey) ? "Disable" : "Enable"}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => onDelete(apiKey)}><Trash2 className="size-4" />Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="grid gap-4 xl:grid-cols-[18rem_minmax(0,1fr)]">
        <DonutChart
          title="7-Day Cost by Account"
          subtitle={usageLoading ? "Loading..." : "Breakdown of usage cost"}
          items={accountCosts.map((item) => ({ id: item.accountId ?? item.name ?? "unknown", label: item.name ?? item.email ?? item.accountId ?? "Unknown", value: item.costUsd ?? 0 }))}
          total={Math.max(usage7d.totalCostUsd ?? 0, accountCosts.reduce((sum, item) => sum + (item.costUsd ?? 0), 0))}
          centerValue={usage7d.totalCostUsd ?? 0}
          centerLayout="currency"
        />
        <div className="rounded-xl border bg-card p-4">
          <h3 className="text-sm font-semibold">Usage Trend</h3>
          <p className="text-muted-foreground mt-1 text-xs">7-day token and cost activity</p>
          <div className="mt-4 grid gap-4">
            <SparklineChart data={(trends.tokens ?? []).map((point) => ({ value: numeric(point.v ?? point.value ?? point.tokens) }))} color="#0ea5e9" height={80} />
            <SparklineChart data={(trends.cost ?? []).map((point) => ({ value: numeric(point.v ?? point.value ?? point.cost) }))} color="#10b981" height={80} index={1} />
          </div>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <MiniMetric label="Requests" value={compactNumber(usage7d.totalRequests ?? 0)} />
        <MiniMetric label="Tokens" value={compactNumber(usage7d.totalTokens ?? 0)} />
        <MiniMetric label="Cached" value={compactNumber(usage7d.cachedInputTokens ?? 0)} />
        <MiniMetric label="Cost" value={currency(usage7d.totalCostUsd ?? 0)} />
      </div>
    </section>
  );
}

function ApiKeyCreateDialog({
  open,
  busy,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: ApiKeyCreateInput) => Promise<unknown>;
}) {
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit({ name, expiresAt: dateInputToMs(expiresAt) });
    setName("");
    setExpiresAt("");
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create API key</DialogTitle>
          <DialogDescription>Create a client key. The secret is shown once.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <div className="grid gap-2">
            <Label htmlFor="api-key-name">Name</Label>
            <Input id="api-key-name" value={name} onChange={(event) => setName(event.target.value)} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="api-key-expiry">Expiry</Label>
            <Input id="api-key-expiry" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy || name.trim().length === 0}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ApiKeyEditDialog({
  apiKey,
  busy,
  onOpenChange,
  onSubmit,
}: {
  apiKey: ApiKey | null;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: ApiKeyUpdateInput) => Promise<unknown>;
}) {
  const [name, setName] = useState("");
  useEffect(() => {
    setName(apiKey?.name ?? "");
  }, [apiKey]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!apiKey) return;
    await onSubmit({ id: apiKey.id, name });
  }
  return (
    <Dialog open={Boolean(apiKey)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit API key</DialogTitle>
          <DialogDescription>Update key metadata.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <div className="grid gap-2">
            <Label htmlFor="api-key-edit-name">Name</Label>
            <Input id="api-key-edit-name" value={name} onChange={(event) => setName(event.target.value)} required />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy || !apiKey}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ApiKeyCreatedDialog({ apiKey, onOpenChange }: { apiKey: string | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={Boolean(apiKey)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>API key created</DialogTitle>
          <DialogDescription>Store this secret now. It will not be shown again.</DialogDescription>
        </DialogHeader>
        {apiKey ? (
          <div className="grid gap-3">
            <div className="bg-muted rounded-md p-3 font-mono text-xs break-all">{apiKey}</div>
            <CopyButton value={apiKey} label="Copy key" />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function dateInputToMs(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function SortableHeader({ active, dir, onClick, children }: { active: boolean; dir: StickySortDir; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={cn("inline-flex items-center gap-1 hover:text-foreground", active && "text-foreground")} onClick={onClick}>
      {children}
      {active ? <span aria-hidden>{dir === "asc" ? "↑" : "↓"}</span> : null}
    </button>
  );
}

function PaginationFooter({
  offset,
  limit,
  total,
  hasMore,
  onPrevious,
  onNext,
}: {
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const visible = total === 0 ? "0-0" : `${offset + 1}-${Math.min(total, offset + limit)}`;
  return (
    <div className="flex items-center justify-between gap-3 pt-1">
      <Button type="button" variant="outline" size="sm" disabled={offset === 0} onClick={onPrevious}>
        Previous
      </Button>
      <span className="text-muted-foreground text-xs">{visible} of {compactNumber(total)}</span>
      <Button type="button" variant="outline" size="sm" disabled={!hasMore} onClick={onNext}>
        Next
      </Button>
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
        description="Sign in through the Claude Code CLI to start balancing requests."
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
            <th className="px-2 py-3 font-medium">Usage</th>
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
  const hasRawHttp = Boolean(
    entry.rawRequestHeaders ||
      entry.rawRequestBody ||
      entry.rawUpstreamRequestHeaders ||
      entry.rawUpstreamRequestBody ||
      entry.rawResponseHeaders ||
      entry.rawResponseBody,
  );
  return (
    <div className="grid gap-3">
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
      {hasRawHttp ? (
        <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          <RawHttpPanel title="Request to gateway" headers={entry.rawRequestHeaders} body={entry.rawRequestBody} />
          <RawHttpPanel
            title="Request to Anthropic"
            headers={entry.rawUpstreamRequestHeaders}
            body={entry.rawUpstreamRequestBody}
          />
          <RawHttpPanel title="Response from Anthropic" headers={entry.rawResponseHeaders} body={entry.rawResponseBody} />
        </div>
      ) : null}
    </div>
  );
}

function RawHttpPanel({
  title,
  headers,
  body,
}: {
  title: string;
  headers: string | null;
  body: string | null;
}) {
  const value = [`# ${title} headers`, headers ?? "-", "", `# ${title} body`, body ?? "-"].join("\n");
  return (
    <div className="grid min-w-0 gap-2 rounded-md border bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">{title}</h3>
        <CopyButton value={value} label="Copy raw" />
      </div>
      <RawHttpBlock label="Headers" value={headers} />
      <RawHttpBlock label="Body" value={body} />
    </div>
  );
}

function RawHttpBlock({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="grid min-w-0 gap-1">
      <div className="text-muted-foreground text-[11px] uppercase">{label}</div>
      <pre className="max-h-72 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap">{value ?? "-"}</pre>
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
  const usageWindows = account.usage ?? [];
  const weekUsage = usageWindows.find((entry) => entry.kind === "week_all_models");
  const sessionUsage = usageWindows.find((entry) => entry.kind === "session");
  const usageResetTitle = usageWindows
    .map((entry) => entry.resetsRaw)
    .filter((raw): raw is string => Boolean(raw))
    .join(" · ");

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

  async function editDeviceId() {
    const nextDeviceId = window.prompt("Device ID override", account.deviceIdOverride ?? "");
    if (nextDeviceId === null) return;
    await updateAccount.mutateAsync({ id: account.id, deviceIdOverride: nextDeviceId.trim() || null });
    toast.success(nextDeviceId.trim() ? "Device ID override saved" : "Device ID override cleared");
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
        {account.deviceIdOverride ? <div className="text-muted-foreground max-w-[220px] truncate text-xs">device {account.deviceIdOverride}</div> : null}
      </td>
      <td className="px-2 py-3">
        <StatusBadge status={account.status} />
      </td>
      <td className="px-2 py-3">{account.priority}</td>
      <td className="px-2 py-3">{compactNumber(account.requestCount)}</td>
      <td className="px-2 py-3">
        <MiniQuotaBar percentRemaining={quotaRemainingPercent(account)} />
      </td>
      <td className="px-2 py-3">{relativeTime(account.rateLimitReset)}</td>
      <td className="px-2 py-3">
        {usageWindows.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <div className="flex flex-col leading-tight" title={usageResetTitle || undefined}>
            <span className="font-semibold">{formatUsagePercent(weekUsage?.usedPercent)}</span>
            <span className="text-muted-foreground text-xs">{formatUsagePercent(sessionUsage?.usedPercent)} session</span>
          </div>
        )}
      </td>
      {!compact ? <td className="px-2 py-3">{relativeTime(account.lastUsed)}</td> : null}
      <td className="px-2 py-3">
        <div className="flex justify-end gap-1">
          <Button type="button" variant="ghost" size="icon" onClick={togglePause} title={account.paused ? "Resume" : "Pause"}>
            {account.paused ? <RotateCcw className="size-4" /> : <Pause className="size-4" />}
          </Button>
          <Button type="button" variant="ghost" size="icon" onClick={rename} title="Rename">
            <MoreHorizontal className="size-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon" onClick={editDeviceId} title="Device ID override">
            <Code2 className="size-4" />
          </Button>
          <UsageProbeButton account={account} />
          <Button type="button" variant="ghost" size="icon" onClick={remove} title="Delete">
            <Trash2 className="size-4" />
          </Button>
        </div>
      </td>
    </tr>
  );
}

function UsageProbeButton({ account }: { account: Account }) {
  const utils = trpc.useUtils();
  const probe = trpc.accounts.usageProbe.useMutation({
    onSuccess: async (res) => {
      await utils.accounts.list.invalidate();
      await utils.stats.invalidate();
      toast.success(
        res.outcome === "refreshed" ? "Token refreshed" : res.outcome === "valid_noop" ? "Token still valid" : "Usage checked",
      );
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      title="Refresh token & usage"
      onClick={() => probe.mutate({ id: account.id })}
      disabled={probe.isPending}
    >
      {probe.isPending ? <Loader2 className="size-4 animate-spin" /> : <Gauge className="size-4" />}
    </Button>
  );
}

function AddAccountDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [priority, setPriority] = useState(0);
  const [deviceIdOverride, setDeviceIdOverride] = useState("");
  const [claudeCode, setClaudeCode] = useState("");
  const [claudeCodeSession, setClaudeCodeSession] = useState<{
    authUrl: string;
    sessionId: string;
    tmuxAttachCommand: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const beginClaudeCodeLogin = trpc.accounts.claudeCodeLoginBegin.useMutation({
    onSuccess: (result) => {
      setClaudeCodeSession(result);
      toast.success("Claude Code login link generated");
    },
    onError: (mutationError) => setError(mutationError.message),
  });
  const completeClaudeCodeLogin = trpc.accounts.claudeCodeLoginComplete.useMutation({
    onSuccess: async () => {
      await afterAccountAdded(utils);
      setOpen(false);
      setClaudeCode("");
      setClaudeCodeSession(null);
      setName("");
      setPriority(0);
      setDeviceIdOverride("");
      toast.success("Claude Code account added");
    },
    onError: (mutationError) => setError(mutationError.message),
  });
  const claudeCodeLoginStatus = trpc.accounts.claudeCodeLoginStatus.useQuery(
    { sessionId: claudeCodeSession?.sessionId ?? "" },
    {
      enabled: Boolean(claudeCodeSession),
      refetchInterval: 1_000,
      retry: false,
    },
  );

  async function beginClaudeCode() {
    setError(null);
    setClaudeCode("");
    setClaudeCodeSession(null);
    await beginClaudeCodeLogin.mutateAsync();
  }

  async function submitClaudeCodeLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!claudeCodeSession) {
      setError("Generate a Claude Code login link first.");
      return;
    }
    await completeClaudeCodeLogin.mutateAsync({
      sessionId: claudeCodeSession.sessionId,
      name: name || undefined,
      priority,
      deviceIdOverride: deviceIdOverride || null,
      code: claudeCode,
    });
  }

  const busy = beginClaudeCodeLogin.isPending || completeClaudeCodeLogin.isPending;

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
          <DialogDescription>Sign in through the Claude Code CLI to add an account.</DialogDescription>
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
        <div className="grid gap-2">
          <Label htmlFor="account-device-id">Device ID override</Label>
          <Input
            id="account-device-id"
            value={deviceIdOverride}
            onChange={(event) => setDeviceIdOverride(event.target.value)}
            placeholder="Optional x-device-id"
          />
        </div>
        <form className="grid gap-4" onSubmit={submitClaudeCodeLogin}>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="button" variant="outline" onClick={beginClaudeCode} disabled={busy}>
              {beginClaudeCodeLogin.isPending ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
              Generate login link
            </Button>
            {claudeCodeSession ? <CopyButton value={claudeCodeSession.authUrl} label="Copy URL" /> : null}
          </div>
          {claudeCodeSession ? (
            <div className="bg-muted text-muted-foreground rounded-md px-3 py-2 text-xs break-all">{claudeCodeSession.authUrl}</div>
          ) : null}
          {claudeCodeSession ? (
            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="claude-code-tmux">Tmux attach</Label>
                <CopyButton
                  value={claudeCodeLoginStatus.data?.tmuxAttachCommand ?? claudeCodeSession.tmuxAttachCommand}
                  label="Copy command"
                />
              </div>
              <pre
                id="claude-code-tmux"
                aria-label="Tmux attach command"
                className="bg-muted text-muted-foreground overflow-auto rounded-md px-3 py-2 text-xs whitespace-pre-wrap"
              >
                {claudeCodeLoginStatus.data?.tmuxAttachCommand ?? claudeCodeSession.tmuxAttachCommand}
              </pre>
            </div>
          ) : null}
          {claudeCodeSession ? (
            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="claude-code-output">Claude Code output</Label>
                <span className="text-muted-foreground text-xs">{claudeCodeLoginStatus.data?.status ?? "starting"}</span>
              </div>
              <pre
                id="claude-code-output"
                aria-label="Claude Code output"
                className="bg-muted text-muted-foreground max-h-48 overflow-auto rounded-md px-3 py-2 text-xs whitespace-pre-wrap"
              >
                {claudeCodeLoginStatus.error?.message ||
                  claudeCodeLoginStatus.data?.output ||
                  "Waiting for Claude Code output..."}
              </pre>
            </div>
          ) : null}
          <div className="grid gap-2">
            <Label htmlFor="claude-code-login-code">Claude code</Label>
            <Input
              id="claude-code-login-code"
              value={claudeCode}
              onChange={(event) => setClaudeCode(event.target.value)}
              placeholder="Paste code from Claude"
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy || !claudeCodeSession || claudeCode.trim().length === 0}>
              {completeClaudeCodeLogin.isPending ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
              Add account
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
  const [form, setForm] = useState<SettingsFormState>(() => settingsToFormState(settings));
  const utils = trpc.useUtils();
  const updateSettings = trpc.settings.update.useMutation({
    onSuccess: async (next) => {
      setForm(settingsToFormState(next));
      await utils.settings.get.invalidate();
      toast.success("Settings saved");
    },
  });

  useEffect(() => {
    setForm(settingsToFormState(settings));
  }, [settings]);

  function updateNumber(key: NumberSettingsKey, value: string) {
    const parsed = Number(value);
    setForm((current) => ({ ...current, [key]: Number.isFinite(parsed) ? parsed : 0 }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const strategy = isFrontendStrategyName(form.strategy) ? form.strategy : "priority";
    const payload: Parameters<typeof updateSettings.mutateAsync>[0] = { ...form, strategy };
    if (!settingsSupportsApiKeyAuth(settings)) {
      delete payload.apiKeyAuthEnabled;
    }
    await updateSettings.mutateAsync(payload);
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
        <Switch checked={form.stickySessions} onCheckedChange={(checked) => setForm((current) => ({ ...current, stickySessions: checked }))} />
      </label>
      <label className={cn("flex items-center justify-between rounded-lg border p-3", !settingsSupportsApiKeyAuth(settings) && "opacity-60")}>
        <span>
          <span className="block font-medium">API key authentication</span>
          <span className="text-muted-foreground text-sm">
            Require configured API keys for proxy clients.
            {!settingsSupportsApiKeyAuth(settings) ? " Waiting for backend support." : ""}
          </span>
        </span>
        <Switch
          checked={Boolean(form.apiKeyAuthEnabled)}
          disabled={!settingsSupportsApiKeyAuth(settings)}
          onCheckedChange={(checked) => setForm((current) => ({ ...current, apiKeyAuthEnabled: checked }))}
        />
      </label>
      <label className="flex items-center justify-between rounded-lg border p-3">
        <span>
          <span className="block font-medium">Raw HTTP logging</span>
          <span className="text-muted-foreground text-sm">Store headers and bodies for new proxy attempts. May include API keys, prompts, and tokens.</span>
        </span>
        <Switch
          checked={Boolean(form.rawHttpLoggingEnabled)}
          onCheckedChange={(checked) => setForm((current) => ({ ...current, rawHttpLoggingEnabled: checked }))}
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
      <SettingNumber
        label="New-session usage cutoff"
        value={form.newSessionUsageCutoffPercent}
        onChange={(value) => updateNumber("newSessionUsageCutoffPercent", value)}
        helper="% used of the 5h or weekly window — accounts at or above receive no new sticky sessions"
      />
      <div className="grid gap-2 rounded-lg border p-3 lg:col-span-2">
        <Label htmlFor="user-agent-override">User-Agent override</Label>
        <Input
          id="user-agent-override"
          value={form.userAgentOverride ?? ""}
          onChange={(event) => setForm((current) => ({ ...current, userAgentOverride: event.target.value }))}
          placeholder="claude-cli/2.0.14 (external, cli)"
        />
        <span className="text-muted-foreground text-xs">
          Sent upstream instead of the client&apos;s User-Agent — set to the installed Claude Code version so Anthropic
          sees a consistent client. Leave empty to pass the client value through.
        </span>
      </div>
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

function sinceForDashboardTimeframe(timeframe: DashboardTimeframe): number {
  const days = timeframe === "1d" ? 1 : timeframe === "7d" ? 7 : 30;
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function buildDashboardStats(
  overview: RouterOutput["analytics"]["overview"] | undefined,
  stats: RouterOutput["stats"] | undefined,
  accounts: Account[],
  requests: RequestEntry[],
): DashboardMetric[] {
  const usage = overview?.overview;
  const trend = overview?.trend ?? [];
  const tokenTotal = usage?.tokenTotal ?? requests.reduce((sum, entry) => sum + (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0), 0);
  const cachedTotal = usage?.cachedTokenTotal ?? requests.reduce((sum, entry) => sum + (entry.cacheReadTokens ?? 0) + (entry.cacheCreationTokens ?? 0), 0);
  const costTotal = usage?.costUsd ?? requests.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0);
  const errorRate = usage?.errorRate ?? 0;
  return [
    {
      label: `Requests (${overview?.range ?? "live"})`,
      value: compactNumber(usage?.requestCount ?? stats?.requestsToday ?? 0),
      meta: `Total ${compactNumber(stats?.totalRequests ?? 0)}`,
      icon: <Activity />,
      trend: trendValues(trend, "requestCount", stats?.requestsToday ?? 0),
      color: "#3b82f6",
    },
    {
      label: "Tokens",
      value: compactNumber(tokenTotal),
      meta: `Cached ${compactNumber(cachedTotal)}`,
      icon: <Coins />,
      trend: trendValues(trend, "tokenTotal", tokenTotal),
      color: "#8b5cf6",
    },
    {
      label: "Est. API Cost",
      value: currency(costTotal),
      meta: "From logged usage",
      icon: <CircleDollarSign />,
      trend: trendValues(trend, "costUsd", costTotal),
      color: "#10b981",
    },
    {
      label: "Accounts",
      value: `${compactNumber(stats?.availableAccounts ?? accounts.filter((account) => account.status === "active").length)} / ${compactNumber(accounts.length)}`,
      meta: `${compactNumber(stats?.rateLimitedAccounts ?? 0)} rate limited`,
      icon: <Gauge />,
      trend: accounts.map((account) => ({ value: account.rateLimitRemaining ?? 0 })).slice(0, 12),
      color: "#ef4444",
    },
    {
      label: "Error Rate",
      value: `${(errorRate * 100).toFixed(errorRate > 0.1 ? 0 : 1)}%`,
      meta: usage?.topError ? `Top: ${usage.topError.label}` : "No top error",
      icon: <ShieldAlert />,
      trend: trendValues(trend, "errorRate", errorRate),
      color: "#f59e0b",
    },
  ];
}

function trendValues<T extends Record<string, unknown>>(rows: T[], key: keyof T, fallback: number): { value: number }[] {
  const values = rows.map((row) => numeric(row[key]));
  return values.length > 0 ? values.map((value) => ({ value })) : [{ value: Math.max(0, fallback) }, { value: Math.max(0, fallback) }];
}

/**
 * Percent of the representative (5h) window still available. Prefers the
 * live rate-limit headers, falls back to the /usage probe session window,
 * then the legacy remaining count; null renders as "Unknown".
 */
function quotaRemainingPercent(account: Account): number | null {
  const headerUtilization = account.rateLimit5hUtilization;
  const headerFresh =
    headerUtilization !== null &&
    headerUtilization !== undefined &&
    (account.rateLimit5hReset === null || account.rateLimit5hReset === undefined || account.rateLimit5hReset > Date.now());
  if (headerFresh) return (1 - headerUtilization) * 100;
  const sessionUsage = account.usage?.find((entry) => entry.kind === "session");
  if (sessionUsage?.usedPercent !== null && sessionUsage?.usedPercent !== undefined) {
    return 100 - sessionUsage.usedPercent;
  }
  if (account.rateLimitRemaining !== null && account.rateLimitRemaining !== undefined) {
    return Math.min(100, account.rateLimitRemaining);
  }
  return null;
}

function buildDashboardDonut(
  overview: RouterOutput["analytics"]["overview"] | undefined,
  accounts: Account[],
  window: "primary" | "secondary",
): { items: Array<{ id: string; label: string; value: number; isEmail?: boolean }>; total: number; centerValue: number } {
  const approximations = overview?.creditApproximations.accounts ?? [];
  const byAccount = new Map(approximations.map((account) => [account.accountId, account]));
  const items = accounts.map((account) => {
    const approx = byAccount.get(account.id);
    const remaining = window === "primary" ? approx?.fiveHourRemaining : approx?.sevenDayRemaining;
    return {
      id: account.id,
      label: account.name,
      isEmail: account.name.includes("@"),
      value: Math.max(0, remaining ?? account.rateLimitRemaining ?? 0),
    };
  });
  const centerValue = items.reduce((sum, item) => sum + item.value, 0);
  return { items, centerValue, total: Math.max(centerValue, window === "primary" ? accounts.length * 3_000 : accounts.length * 100_800) };
}

function buildWeeklyPace(
  overview: RouterOutput["analytics"]["overview"] | undefined,
  total: number,
  remaining: number,
): { usedPercent: number; scheduledPercent: number; remaining: number; status: string; gapLabel: string } {
  const usedPercent = total > 0 ? ((total - remaining) / total) * 100 : 0;
  const weeklyWindowMs = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const resetBasedPercents = (overview?.creditApproximations.accounts ?? []).flatMap((account) => {
    if (account.rateLimitReset === null || account.rateLimitReset === undefined) return [];
    const remainingMs = Math.max(0, Math.min(weeklyWindowMs, account.rateLimitReset - now));
    return [((weeklyWindowMs - remainingMs) / weeklyWindowMs) * 100];
  });
  const scheduledPercent =
    resetBasedPercents.length > 0
      ? resetBasedPercents.reduce((sum, value) => sum + value, 0) / resetBasedPercents.length
      : ((now % weeklyWindowMs) / weeklyWindowMs) * 100;
  const delta = usedPercent - scheduledPercent;
  return {
    usedPercent,
    scheduledPercent,
    remaining,
    status: remaining <= 0 ? "danger" : delta > 10 ? "ahead" : "on_track",
    gapLabel: `${Math.abs(delta).toFixed(1)} pts ${delta >= 0 ? "ahead" : "behind"}`,
  };
}

function normalizeApiKeys(data: RouterOutput["apiKeys"]["list"] | undefined): ApiKey[] {
  return data ?? [];
}

function apiKeyUsage(apiKey: ApiKey): ApiKeyUsageSummary {
  return apiKey.usage ?? apiKey.usageSummary ?? {};
}

function apiKeyPrefix(apiKey: ApiKey): string {
  return apiKey.prefix ?? apiKey.keyPrefix ?? "";
}

function apiKeyStatus(apiKey: ApiKey): string {
  if (apiKey.computedStatus === "expired") return "expired";
  return apiKeyIsActive(apiKey) ? "active" : "disabled";
}

function apiKeyIsActive(apiKey: ApiKey): boolean {
  if (apiKey.isActive !== undefined) return apiKey.isActive;
  if (apiKey.active !== undefined) return apiKey.active;
  return apiKey.status !== "inactive" && apiKey.computedStatus !== "expired";
}

function normalizeApiKeyTrends(data: RouterOutput["apiKeys"]["analytics"] | undefined): ApiKeyTrends {
  const trend = data?.trend ?? [];
  return {
    keyId: data?.apiKeyId,
    cost: trend.map((point) => ({ t: point.startTs, v: point.costUsd })),
    tokens: trend.map((point) => ({ t: point.startTs, v: point.tokenTotal })),
  };
}

function normalizeApiKeyUsage7d(data: RouterOutput["apiKeys"]["analytics"] | undefined): ApiKeyUsage7d {
  return {
    keyId: data?.apiKeyId,
    totalTokens: data?.overview.tokenTotal ?? 0,
    totalCostUsd: data?.overview.costUsd ?? 0,
    totalRequests: data?.overview.requestCount ?? 0,
    cachedInputTokens: data?.overview.cachedTokenTotal ?? 0,
    accountCosts: (data?.usageByAccount7d ?? []).map((summary) => ({
      accountId: summary.accountId,
      name: summary.accountName,
      costUsd: summary.costUsd,
    })),
  };
}

function extractApiKeySecret(result: ApiKeySecretOutput): string {
  return result.plaintextKey ?? result.key ?? result.token ?? "";
}

function normalizeStickySessions(data: RouterOutput["stickySessions"]["list"] | undefined): Required<StickySessionsResponse> {
  const entries = (data?.entries ?? []).map((entry) => ({
    ...entry,
    displayName: entry.accountName ?? entry.accountId ?? "Unknown account",
    isStale: entry.stale,
    expiresAt: entry.expiresAt,
  }));
  return {
    entries,
    total: data?.total ?? 0,
    hasMore: data?.hasMore ?? false,
    stalePromptCacheCount: data?.stalePromptCacheCount ?? 0,
    staleCount: data?.stalePromptCacheCount ?? 0,
  };
}

function stickySessionRowId(entry: StickySessionEntry): string {
  return `${entry.kind}:${entry.key}`;
}

function stickySessionTarget(entry: StickySessionEntry): StickySessionTarget {
  return { key: entry.key, kind: entry.kind };
}

function stickyKindLabel(kind: string): string {
  return labelFromKey(kind);
}

function toStickyBackendSortBy(value: StickySortBy): StickyBackendSortBy {
  return value === "account" ? "account_name" : value;
}

function formatDateish(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return date.toLocaleString();
}

function settingsToFormState(settings: SettingsValue): SettingsFormState {
  return { ...settings, apiKeyAuthEnabled: settingsSupportsApiKeyAuth(settings) ? settings.apiKeyAuthEnabled : false };
}

function settingsSupportsApiKeyAuth(settings: SettingsValue): settings is SettingsValue & { apiKeyAuthEnabled: boolean } {
  return "apiKeyAuthEnabled" in settings;
}

function numeric(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
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

function formatUsagePercent(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${Math.round(value)}%`;
}
