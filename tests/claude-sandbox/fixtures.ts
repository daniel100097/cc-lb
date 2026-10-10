import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installedClaudeVersion } from "../../src/anthropic/claude-version";

export const FAKE_ACCESS_TOKEN = "sk-ant-oat01-sandbox-access-token-not-a-real-credential";
export const FAKE_REFRESH_TOKEN = "sk-ant-ort01-sandbox-refresh-token-not-a-real-credential";
export const REFRESHED_ACCESS_TOKEN = "sk-ant-oat01-sandbox-refreshed-token-not-a-real-credential";
export const FAKE_ACCOUNT_UUID = "11111111-1111-4111-8111-111111111111";
export const FAKE_MACHINE_ID = "0123456789abcdef".repeat(4);
export const FAKE_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
  "user:plugins",
];

// Matches the OAuth profile response consumed by the pinned Claude Code CLI.
export const FAKE_PROFILE = {
  account: {
    uuid: FAKE_ACCOUNT_UUID,
    email: "sandbox@example.invalid",
    display_name: "Sandbox User",
    full_name: "Sandbox User",
    created_at: "2026-01-01T00:00:00.000Z",
  },
  organization: {
    uuid: "22222222-2222-4222-8222-222222222222",
    name: "Sandbox Organization",
    organization_type: "claude_max",
    rate_limit_tier: "default_claude_max_5x",
    billing_type: "stripe_subscription",
    subscription_created_at: "2026-01-01T00:00:00.000Z",
    has_extra_usage_enabled: false,
    cc_onboarding_flags: {},
    claude_code_trial_ends_at: null,
    claude_code_trial_duration_days: null,
    seat_tier: null,
    plan_display_name: "Max",
  },
};

export function seedClaudeSession(configDir: string, { expired = false }: { expired?: boolean } = {}): void {
  const version = installedClaudeVersion();
  if (!version) throw new Error("The bundled Claude Code dependency is required to seed the sandbox session");
  const now = Date.now();
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, ".credentials.json"), JSON.stringify({
    claudeAiOauth: {
      accessToken: FAKE_ACCESS_TOKEN,
      refreshToken: FAKE_REFRESH_TOKEN,
      expiresAt: now + (expired ? -60_000 : 3_600_000),
      refreshTokenExpiresAt: now + 30 * 24 * 3_600_000,
      scopes: FAKE_SCOPES,
      subscriptionType: "max",
      rateLimitTier: FAKE_PROFILE.organization.rate_limit_tier,
    },
  }, null, 2), { mode: 0o600 });
  writeFileSync(join(configDir, ".claude.json"), JSON.stringify({
    hasCompletedOnboarding: true,
    lastOnboardingVersion: version,
    machineID: FAKE_MACHINE_ID,
    oauthAccount: {
      accountUuid: FAKE_ACCOUNT_UUID,
      emailAddress: FAKE_PROFILE.account.email,
      organizationUuid: FAKE_PROFILE.organization.uuid,
      displayName: FAKE_PROFILE.account.display_name,
      fullName: FAKE_PROFILE.account.full_name,
      billingType: FAKE_PROFILE.organization.billing_type,
      accountCreatedAt: FAKE_PROFILE.account.created_at,
      subscriptionCreatedAt: FAKE_PROFILE.organization.subscription_created_at,
      hasExtraUsageEnabled: FAKE_PROFILE.organization.has_extra_usage_enabled,
      ccOnboardingFlags: FAKE_PROFILE.organization.cc_onboarding_flags,
      claudeCodeTrialEndsAt: FAKE_PROFILE.organization.claude_code_trial_ends_at,
      claudeCodeTrialDurationDays: FAKE_PROFILE.organization.claude_code_trial_duration_days,
      seatTier: FAKE_PROFILE.organization.seat_tier,
      planDisplayName: FAKE_PROFILE.organization.plan_display_name,
      profileFetchedAt: now,
    },
  }, null, 2), { mode: 0o600 });
}
