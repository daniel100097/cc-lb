# 04 — Frontend & Design

Design language copied from
[codex-lb design research](../docs/research/codex-lb-design-language.md).
Same stack, same tokens, same layout — different content (Claude accounts, not Codex).

## Stack (match codex-lb exactly)

- React 19 + react-router-dom 7 (client SPA)
- Bun browser bundler, built by root scripts
- Tailwind CSS v4 via `@tailwindcss/cli` (CSS-first config, **no** `tailwind.config.js`)
- shadcn/ui — style **new-york**, base color **neutral**, CSS-variables mode (`components.json`)
- radix-ui primitives, `cva` + `clsx` + `tailwind-merge` (`cn()`)
- @tanstack/react-query 5, zustand 5 (theme/privacy stores)
- react-hook-form 7 + zod 4
- lucide-react icons, sonner toasts
- recharts (lazy) — optional, only if we add usage charts
- Build into `public/` so the Bun server serves it (codex-lb builds into `app/static`)

## Design tokens — copy verbatim

Copy `reference/codex-lb/frontend/src/index.css` (all 257 lines) as our
`frontend/src/index.css`, and `components.json`. That single CSS file is the whole
theme: OKLCH light/dark palettes, `@theme inline` map, radii, shadows, fonts,
`fade-in-up`/`press-scale`/`card-hover` animations, thin scrollbars.

Rename the wordmark "Codex LB" → "CC-LB"; keep the indigo primary
(`--primary: oklch(0.488 0.185 264)`), true-black OLED dark theme, Geist Sans +
JetBrains Mono. Drop `GeistSans-Variable.woff2` into `frontend/public/fonts/`.

Reuse verbatim the signature components:
- `status-badge.tsx` — tinted pill + dot. Remap statuses to ours:
  `active→emerald, paused→amber, rate_limited→orange, needs_reauth→sky, expired→zinc`.
- `empty-state.tsx`, `alert-message.tsx`, `mini-quota-bar.tsx`, `sonner.tsx`,
  `copy-button.tsx`, `confirm-dialog.tsx`.

## Layout (copy the shell)

`AppLayout`: sticky glassmorphic **top bar** (segmented pill nav, no sidebar) →
centered `max-w-[1500px]` main → fixed glassmorphic **footer status bar**
(last-sync dot, active strategy, version, GitHub link). Exact classes in the
design doc §3. Cards are `rounded-xl border bg-card p-4` with `card-hover`.

## Pages / routes

| Route | Purpose |
|---|---|
| `/` **Dashboard** | Stat cards (total accounts, available, rate-limited, requests today) as codex-lb `stats-grid`; account health table |
| `/accounts` | Account list (table), row actions (pause/resume/rename/delete/reauth), **Add Account** dialog |
| `/settings` | Strategy select + balancing knobs form (react-hook-form + zod), sticky-session toggle |

Keep it to these three. Auth page only if `DASHBOARD_PASSWORD` set (simple login).

## Add Account dialog (the key custom UI)

A shadcn `Dialog` with two tabs (radix Tabs), matching plan 02's two paths:

**Tab 1 — Paste credentials JSON**
- `Textarea` for the JSON blob (or file drop of `.credentials.json`).
- Name field (optional; default derived).
- Submit → `accounts.import`. Toast success, invalidate `accounts` query.
- Inline `alert-message` on parse/validation error.

**Tab 2 — Sign in with Claude (OAuth)**
- Step 1 button "Generate login link" → `accounts.oauthBegin` → open
  `authUrl` in a new tab, show the URL with a `copy-button`.
- Step 2 `Input` "Paste the code" (format `code#state`) + Add →
  `accounts.oauthComplete`. Toast + refresh.
- Small helper text explaining the manual copy-paste (Anthropic returns the code
  in-browser, `code=true`).

## Accounts table

Columns: name, status (`StatusBadge`), priority, requests, window reset
(`rate_limit_reset` relative time), last used, actions (dropdown-menu:
Pause/Resume, Rename, Re-auth, Delete-with-confirm). `mini-quota-bar` if
`rate_limit_remaining` known. Email blurred by default via the privacy (eye)
toggle store — reuse codex-lb `blur-email.tsx`.

## Settings form

`routing_strategy` as a shadcn `Select` (the 5 strategies from plan 03, each with a
one-line description like codex-lb's README). Toggles/number inputs for
`stickySessions`, `stickyTtlMs`, backoff base/max, session duration, overload
retries. Save → tRPC `settings.update`, toast. Footer status bar reads the
active strategy from here.

## Data layer

`frontend/src/lib/trpc.ts` — tRPC React client over `/api/trpc`. react-query
hooks use sensible `staleTime` and polling on live dashboard pages. zustand
`use-theme` and `use-privacy`.
