# codex-lb — Design Language

A complete, reproducible specification of the visual design language used by the codex-lb dashboard frontend. All file paths are relative to `reference/codex-lb/frontend`.

---

## 1. Frontend Stack

The dashboard is a **client-side SPA** (no SSR/RSC — `"rsc": false` in `components.json:4`), served as static assets built into `../app/static` (`vite.config.ts:60`).

| Concern | Choice | Evidence |
|---|---|---|
| Framework | **React 19.2** (`react`, `react-dom`) | `package.json:37-39` |
| Router | **react-router-dom 7** (client routes, no data loaders) | `package.json:41`, `src/App.tsx:1` |
| Build tool | **Vite 8** with `@vitejs/plugin-react-swc` (SWC, not Babel) | `package.json`, `vite.config.ts:5` |
| Package manager | **Bun 1.3.14** (`bun.lock` present) | `package.json:5` |
| Styling | **Tailwind CSS v4** via `@tailwindcss/vite` plugin (no `tailwind.config.js` — config is CSS-first) | `package.json:33`, `vite.config.ts:6` |
| Component kit | **shadcn/ui**, "new-york" style, base color `neutral`, CSS variables mode | `components.json:3,9-11` |
| Primitives | **radix-ui** (unified `radix-ui` package, not per-component) | `package.json:40`, imports like `src/components/ui/dialog.tsx:5` |
| Variants | **class-variance-authority** (`cva`) + `clsx` + `tailwind-merge` (via `cn()`) | `src/lib/utils.ts` |
| Data fetching | **@tanstack/react-query 5** | `src/lib/query-client.ts` |
| Global state | **zustand 5** (theme, privacy, auth, preferences stores) | `src/hooks/use-theme.ts:1` |
| Forms | **react-hook-form 7** + `@hookform/resolvers` + **zod 4** | `package.json` |
| Charts | **recharts 3** (lazy-loaded) | `package.json:31`, `src/components/lazy-recharts.ts` |
| Icons | **lucide-react** | `components.json:16` |
| Toasts | **sonner 2** | `src/components/ui/sonner.tsx` |
| i18n | **i18next / react-i18next** (en + zh-CN) | `src/i18n/` |
| Animations | **tw-animate-css** (dev dep, imported in CSS) | `src/index.css:2` |
| Dates | **date-fns 4**, `react-day-picker 10` | `package.json` |

### Component structure

Feature-sliced architecture. Shared primitives live under `src/components`, feature code under `src/features/<feature>/`:

- `src/components/ui/` — shadcn primitives (button, badge, dialog, table, input, select, sheet, dropdown-menu, popover, tooltip, checkbox, switch, form, calendar, skeleton, spinner, sonner, alert-dialog, input-otp, label).
- `src/components/` — app-specific shared components (`status-badge.tsx`, `empty-state.tsx`, `donut-chart.tsx`, `sparkline-chart.tsx`, `mini-quota-bar.tsx`, `alert-message.tsx`, `copy-button.tsx`, `confirm-dialog.tsx`, `blur-email.tsx`).
- `src/components/layout/` — `app-header.tsx`, `status-bar.tsx`, `language-toggle.tsx`, `loading-overlay.tsx`.
- `src/components/brand/codex-logo.tsx` — the ring/glyph brand mark.
- `src/features/{dashboard,reports,accounts,apis,settings,auth,runtime,sticky-sessions}/` — each with `components/`, `api.ts`, `schemas.ts`, `hooks/`.

Path alias `@` → `src` (`vite.config.ts:41-43`). Vendor code is manually chunked into `vendor-react`, `vendor-query`, `vendor-charts`, `vendor-ui` (`vite.config.ts:14-19`).

---

## 2. Design Tokens

All tokens are defined in **`src/index.css`**. Tailwind v4 uses a CSS-first config: the `@theme inline` block (lines 15–56) maps Tailwind utility color names to CSS custom properties, and `:root` / `.dark` blocks hold the actual OKLCH values. Dark mode is class-based via `@custom-variant dark (&:is(.dark *))` (`src/index.css:13`) — the `.dark` class is toggled on `<html>` (`src/hooks/use-theme.ts:24`).

### 2.1 Color palette — Light theme (`:root`, `src/index.css:58-94`)

```css
:root {
  --radius: 0.375rem;
  --shadow-xs: 0 1px 2px oklch(0 0 0 / 0.04);
  --shadow-sm: 0 1px 3px oklch(0 0 0 / 0.06), 0 1px 2px oklch(0 0 0 / 0.04);
  --shadow-md: 0 4px 8px -2px oklch(0 0 0 / 0.08), 0 2px 4px -2px oklch(0 0 0 / 0.04);
  --background: oklch(0.985 0.002 260);        /* near-white, faint cool tint */
  --foreground: oklch(0.13 0.028 260);         /* near-black navy ink */
  --card: oklch(1 0 0);                          /* pure white */
  --card-foreground: oklch(0.13 0.028 260);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.13 0.028 260);
  --primary: oklch(0.488 0.185 264);            /* saturated indigo/blue */
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.958 0.008 264);
  --secondary-foreground: oklch(0.25 0.03 264);
  --muted: oklch(0.955 0.006 264);
  --muted-foreground: oklch(0.50 0.015 264);
  --accent: oklch(0.955 0.012 264);
  --accent-foreground: oklch(0.25 0.03 264);
  --destructive: oklch(0.577 0.245 27.325);     /* red */
  --border: oklch(0.920 0.005 264);
  --input: oklch(0.920 0.005 264);
  --ring: oklch(0.488 0.185 264);               /* == primary */
  --chart-1: oklch(0.646 0.222 41.116);         /* orange */
  --chart-2: oklch(0.6 0.118 184.704);          /* teal */
  --chart-3: oklch(0.398 0.07 227.392);         /* deep blue */
  --chart-4: oklch(0.828 0.189 84.429);         /* yellow-green */
  --chart-5: oklch(0.769 0.188 70.08);          /* gold */
  --sidebar: oklch(0.975 0.004 264);
  --sidebar-foreground: oklch(0.13 0.028 260);
  --sidebar-primary: oklch(0.488 0.185 264);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.955 0.012 264);
  --sidebar-accent-foreground: oklch(0.25 0.03 264);
  --sidebar-border: oklch(0.915 0.008 264);
  --sidebar-ring: oklch(0.708 0 0);
}
```

The palette is **cool-neutral** (hue ~260–264 throughout) with a single vivid **indigo-blue primary**. Sidebar tokens exist in the theme but the app does **not** use a sidebar layout (see §3) — they are inherited shadcn defaults.

### 2.2 Color palette — Dark theme (`.dark`, `src/index.css:96-131`)

```css
.dark {
  --shadow-xs: 0 1px 2px oklch(0 0 0 / 0.15);
  --shadow-sm: 0 1px 3px oklch(0 0 0 / 0.20), 0 1px 2px oklch(0 0 0 / 0.15);
  --shadow-md: 0 4px 8px -2px oklch(0 0 0 / 0.30), 0 2px 4px -2px oklch(0 0 0 / 0.20);
  --background: oklch(0 0 0);                    /* pure black (OLED) */
  --foreground: oklch(0.95 0 0);
  --card: oklch(0.145 0 0);                      /* very dark grey */
  --card-foreground: oklch(0.95 0 0);
  --popover: oklch(0.145 0 0);
  --popover-foreground: oklch(0.95 0 0);
  --primary: oklch(0.68 0.10 245);              /* lighter, softer blue */
  --primary-foreground: oklch(0.12 0 0);
  --secondary: oklch(0.22 0 0);
  --secondary-foreground: oklch(0.90 0 0);
  --muted: oklch(0.22 0 0);
  --muted-foreground: oklch(0.65 0 0);
  --accent: oklch(0.22 0 0);
  --accent-foreground: oklch(0.90 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(0.26 0 0);
  --input: oklch(0.26 0 0);
  --ring: oklch(0.65 0.10 245);
  --chart-1: oklch(0.488 0.12 245);
  --chart-2: oklch(0.696 0.08 162.48);
  --chart-3: oklch(0.769 0.09 70.08);
  --chart-4: oklch(0.627 0.13 303.9);
  --chart-5: oklch(0.645 0.12 16.439);
  --sidebar: oklch(0.14 0 0);
  /* …sidebar tokens as above… */
}
```

Note the dark theme neutrals are **pure achromatic** (chroma 0) with a true-black `--background: oklch(0 0 0)` — an OLED-friendly choice — while the light theme keeps a subtle cool chroma.

### 2.3 Categorical / status colors (Tailwind palette, not theme vars)

Charts and status pills use **fixed hex/Tailwind colors**, not the `--chart-*` theme vars, so they render consistently in recharts SVG:

Donut chart palette (`src/utils/constants.ts:45-60`):
```
LIGHT: #3b82f6 #8b5cf6 #10b981 #f59e0b #ec4899 #06b6d4
DARK:  #2563eb #7c3aed #059669 #d97706 #db2777 #0891b2
```
The palette auto-extends beyond 6 items by lightening/darkening base colors (`buildDonutPalette`, `src/utils/colors.ts:25-40`). "Consumed/used" segments render grey: `#404040` (dark) / `#d3d3d3` (light) (`src/components/donut-chart.tsx:116`).

`useChartColors` resolves `--chart-1..5` to hex at runtime via a canvas trick, with fallbacks `#3b82f6 #8b5cf6 #10b981 #f59e0b #ec4899` (`src/hooks/use-chart-colors.ts:13,38-47`).

Status semantic colors are Tailwind tints at `/15` bg, `/20` border (`src/components/status-badge.tsx:7-14`):
- active → `emerald`, paused → `amber`, limited → `orange`, exceeded → `red`, reauth → `sky`, deactivated → `zinc`.

Quota-bar thresholds (`src/utils/account-status.ts:3-13`): ≥70% `emerald-500`, ≥30% `amber-500`, else `red-500`; track uses the same hue at `/15`.

### 2.4 Typography

Two custom fonts, loaded two different ways:

- **Geist Sans** — variable weight 100–900, self-hosted from `/fonts/GeistSans-Variable.woff2` via `@font-face` (`src/index.css:5-11`; file at `public/fonts/GeistSans-Variable.woff2`).
- **JetBrains Mono** — weights 400/500, loaded from Google Fonts in `index.html:9`.

Font stacks (`src/index.css:54-55`):
```css
--font-sans: "Geist Sans", ui-sans-serif, system-ui, -apple-system, sans-serif;
--font-mono: "JetBrains Mono", ui-monospace, monospace;
```

Body sets `antialiased` and OpenType ligatures `font-feature-settings: "rlig" 1, "calt" 1` (`src/index.css:137-140`). Numeric displays use `tabular-nums` liberally (e.g. `src/components/donut-chart.tsx:231`).

Type scale in practice (Tailwind utilities):
- Page `h1`: `text-2xl font-semibold tracking-tight` (`dashboard-page.tsx:184`).
- Section `h2`: `text-[13px] font-medium uppercase tracking-wider text-muted-foreground` (`dashboard-page.tsx:239`).
- Card title `h3`: `text-sm font-semibold` (`donut-chart.tsx:176`).
- Big stat number: `text-[1.625rem] font-semibold tracking-[-0.02em]` (`stats-grid.tsx:53`).
- Micro-labels/captions: `text-[11px]` / `text-[10px] uppercase tracking-wider` (`stats-grid.tsx:46`, `donut-chart.tsx:229`).
- Body default: `text-sm`; secondary `text-xs text-muted-foreground`.

Weights used: `font-medium` (500) and `font-semibold` (600) dominate; there is essentially no bold (700).

### 2.5 Spacing, radii, shadows

- **Border radius base**: `--radius: 0.375rem` (6px). Derived scale (`src/index.css:16-22`): `sm = radius−4px`, `md = radius−2px`, `lg = radius`, `xl = radius+4px`, up to `4xl = radius+16px`. Cards use `rounded-xl`; buttons/inputs `rounded-md`; pills/badges `rounded-full`; nav pills `rounded-lg`/`rounded-md`.
- **Shadows** are deliberately soft and defined as tokens (see §2.1/2.2). Only three levels: `--shadow-xs/-sm/-md`, all pure-black alpha, larger alpha in dark mode. Header/footer use bespoke shadows like `shadow-[0_1px_12px_rgba(0,0,0,0.06)]` (`app-header.tsx:65`).
- **Spacing**: standard Tailwind scale. Page vertical rhythm is `space-y-8` (`dashboard-page.tsx:181`); section internals `space-y-4`; card padding `p-4`/`p-5`; page shell padding `px-4 py-8 sm:px-6` (`App.tsx:35`).
- Main content is width-capped: `mx-auto w-full max-w-[1500px]` (`App.tsx:35`, `app-header.tsx:69`, `status-bar.tsx:132`).

---

## 3. Layout Patterns

### Page shell — top bar + footer, NO sidebar

`AppLayout` (`src/App.tsx:16-41`) is a vertical flex column: sticky `AppHeader` → `<main>` (max-width 1500px, centered, `flex-1`) → fixed `StatusBar` footer. `pb-10` on the root reserves space for the fixed footer.

**Header** (`src/components/layout/app-header.tsx:62-68`): sticky, translucent glass:
```
sticky top-0 z-20 border-b border-white/[0.08] bg-background/50
shadow-[0_1px_12px_rgba(0,0,0,0.06)] backdrop-blur-xl backdrop-saturate-[1.8]
supports-[backdrop-filter]:bg-background/40 dark:shadow-[0_1px_12px_rgba(0,0,0,0.25)]
```
Left: brand mark in a `h-8 w-8 rounded-lg` gradient tile (`bg-gradient-to-br from-primary/15 to-primary/5`) + "Codex LB" wordmark. Center: **segmented "pill" nav** — a rounded container `border border-border/50 bg-muted/40 p-0.5` holding `NavLink`s; the active link gets `bg-background text-foreground shadow-[var(--shadow-xs)]`, inactive `text-muted-foreground hover:text-foreground` (`app-header.tsx:81-104`). Right: language toggle, privacy (eye) toggle, logout — all ghost icon buttons. A count badge (`bg-primary text-primary-foreground rounded-full text-[10px]`) floats over the Accounts tab. Mobile collapses into a right-side **Sheet** drawer (`app-header.tsx:146-222`).

**Footer status bar** (`src/components/layout/status-bar.tsx:130-176`): `fixed bottom-0 … z-50` with the same glass treatment (mirrored shadow `0_-1px_12px…`). Shows last-sync time (green `bg-emerald-500` live dot when <60s), routing strategy, version, and a GitHub link. `text-xs text-muted-foreground`.

### Cards

The canonical card is `rounded-xl border bg-card p-4` (or `p-5`), with an optional `card-hover` lift (`donut-chart.tsx:174`, `stats-grid.tsx:42`). There is **no shadcn `Card` component** in `src/components/ui/` — cards are composed inline from these utility classes. Stat cards add a header row (uppercase micro-label + a `h-8 w-8 rounded-lg` tinted icon tile) and a sparkline (`stats-grid.tsx:40-71`).

### Sections

Sections use a heading + hairline divider pattern: an uppercase `h2` next to a flex-growing `h-px … bg-border` rule (`dashboard-page.tsx:237-244`). Grids: stats use `grid gap-3 sm:grid-cols-2 xl:grid-cols-4|5` (`stats-grid.tsx:31-35`); asymmetric layouts use explicit fractions e.g. `xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]` (`dashboard-page.tsx:212`).

### Tables

shadcn table (`src/components/ui/table.tsx`) wrapped in `relative w-full overflow-x-auto`. Rows: `hover:bg-muted/50 border-b transition-colors`; header cells `h-10 px-2 text-left font-medium`; body cells `p-2 align-middle whitespace-nowrap`; footer `bg-muted/50 border-t`. Text size `text-sm`.

### Dialogs

shadcn dialog over radix (`src/components/ui/dialog.tsx`). Overlay `fixed inset-0 z-50 bg-black/50` with fade in/out. Content: centered, `w-full max-w-[calc(100%-2rem)] … rounded-lg border p-6 shadow-lg sm:max-w-lg`, with zoom-95 + fade enter/exit and `duration-200` (`dialog.tsx:70`). Close button is a `rounded-xs` `opacity-70 hover:opacity-100` X at top-right. Header `flex flex-col gap-2 text-center sm:text-left`; title `text-lg font-semibold`; description `text-muted-foreground text-sm`; footer `flex-col-reverse … sm:flex-row sm:justify-end`. A custom `useFloatingLayerDismissGuard` prevents accidental outside-dismiss.

### Forms & inputs

`react-hook-form` + zod via shadcn `form.tsx`. Input (`src/components/ui/input.tsx`): `h-9 w-full rounded-md border bg-transparent px-3 py-1 text-base md:text-sm shadow-xs`, dark `bg-input/30`, focus ring `focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]`, and `aria-invalid:` destructive ring. Selection color is `selection:bg-primary selection:text-primary-foreground`.

---

## 4. Component Styling Conventions

### Buttons (`src/components/ui/button-variants.ts`)

Base: `inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-all`, `disabled:opacity-50`, 3px focus ring, auto-sized icons (`[&_svg]:size-4`).

Variants (line 7-18):
- `default` — `bg-primary text-primary-foreground hover:bg-primary/90`
- `destructive` — `bg-destructive text-white hover:bg-destructive/90`
- `outline` — `border bg-background shadow-xs hover:bg-accent`, dark `bg-input/30`
- `secondary` — `bg-secondary text-secondary-foreground hover:bg-secondary/80`
- `ghost` — `hover:bg-accent hover:text-accent-foreground`
- `link` — `text-primary underline-offset-4 hover:underline`

Sizes (line 19-27): `default h-9`, `xs h-6 text-xs`, `sm h-8`, `lg h-10`, plus icon sizes `icon size-9`, `icon-xs size-6`, `icon-sm size-8`, `icon-lg size-10`. Note the header uses `h-8 w-8 rounded-lg` overrides and the `.press-scale` active-scale effect (`app-header.tsx:116`).

### Badges & status pills

`Badge` (`src/components/ui/badge-variants.ts`): `rounded-full border px-2 py-0.5 text-xs font-medium`, variants `default/secondary/destructive/outline/ghost/link`. `[a&]:hover:` selectors style anchor-badges only.

`StatusBadge` (`src/components/status-badge.tsx`) is the app's signature status pill: `variant="outline"` + a tinted class map (`bg-<hue>-500/15 text-<hue>-700 border-<hue>-500/20 dark:text-<hue>-400`) and a leading `h-1.5 w-1.5 rounded-full bg-current` dot. The header's reset-credit counter is a `bg-primary rounded-full text-[10px] text-primary-foreground` micro-badge.

### Charts (recharts, lazy-loaded)

recharts is code-split via `src/components/lazy-recharts.ts` and dynamic `lazy()` (`stats-grid.tsx:7-11`).

- **DonutChart** (`src/components/donut-chart.tsx`): 152px, `innerRadius 53 / outerRadius 68`, `startAngle 90 / endAngle -270` (clockwise). Active segment grows `+4px` with a `stroke=hsl(var(--background))` gap. Center shows an uppercase caption + tabular number. Custom interactive legend rows (`h-7 rounded-lg`) with colored dots, hover-linked highlighting, and per-row `animate-fade-in-up` with staggered `animationDelay: i*75ms`. Animations 600ms `ease-out`, disabled under reduced-motion. A "safe line" tick can be drawn as an SVG overlay in `#fff`/`#000`.
- **SparklineChart** (`src/components/sparkline-chart.tsx`): recharts `AreaChart`, `type="monotone"`, `strokeWidth 1.5`, gradient fill from `0.3`→`0.05` opacity, 40px tall, staggered `animationBegin: index*100`.
- **MiniQuotaBar** (`src/components/mini-quota-bar.tsx`): native `<progress>` (sr-only for a11y) plus a visual `h-1 rounded-full` track/fill using the threshold colors from §2.3.

### Empty states (`src/components/empty-state.tsx`)

`rounded-xl border border-dashed border-border/60 p-10 text-center` with a centered `h-12 w-12 rounded-xl border bg-muted/50` icon tile, `text-sm font-medium text-muted-foreground` title, and `text-xs text-muted-foreground/70` description.

### Inline alerts (`src/components/alert-message.tsx`)

`rounded-lg px-3 py-2 text-xs font-medium` with a leading `h-3.5 w-3.5` lucide icon. Variants: error `bg-destructive/10 text-destructive border-destructive/20`; success `emerald`; warning `amber` — all at `/10` bg, `/20` border.

### Toasts (`src/components/ui/sonner.tsx`)

Sonner, theme-synced to the zustand theme store, `richColors`, custom lucide icons (`CircleCheck`, `Info`, `TriangleAlert`, `OctagonX`, spinning `Loader2`), styled via CSS vars: `--normal-bg: var(--popover)`, `--normal-text: var(--popover-foreground)`, `--normal-border: var(--border)`, `--border-radius: 0.75rem`.

### Skeletons & spinners

Skeleton: `bg-accent animate-pulse rounded-md` (`src/components/ui/skeleton.tsx`). A custom `@keyframes shimmer` exists in CSS (`index.css:147-150`). Spinner: lucide `Loader2` `animate-spin text-primary`, sizes sm/md, plus a `SpinnerBlock` with label (`src/components/ui/spinner.tsx`).

---

## 5. Iconography & Animation

**Icons**: **lucide-react** exclusively (`components.json:16`). Used at `h-3 w-3` → `h-4 w-4` in chrome, `h-5 w-5` in empty states. SVGs auto-sized to `size-4` inside buttons/badges via cva base classes. The GitHub mark in the footer is an inline `<svg>` (`status-bar.tsx:171`). Brand logo is a custom ring glyph, `stroke="currentColor" strokeWidth="2.484"` (`src/components/brand/codex-logo.tsx`), tinted `text-primary`.

**Animations** (all in `src/index.css:146-241`, plus `tw-animate-css` for shadcn enter/exit):
- `@keyframes fade-in-up` (opacity + 6px translateY, `0.35s ease-out both`) → `.animate-fade-in-up`, applied to pages and staggered list items.
- Stagger helpers `.animate-delay-75/150/225/300`.
- `.press-scale` — `transform scale(0.97)` on `:active`, `0.12s ease` (tactile button feedback).
- `.card-hover` — `translateY(-1px)` + `shadow-md` on hover, `0.2s ease`.
- `.text-gradient` — indigo→purple `linear-gradient(135deg, var(--primary), oklch(0.60 0.22 290))` clipped to text.
- `.noise-overlay` — inline SVG fractal-noise texture at `opacity 0.015` for subtle depth.
- Custom thin scrollbars: `6px` wide, `oklch(0.7 0 0 / 0.3)` thumb, `rounded-full` (`index.css:243-257`).
- **Reduced-motion**: a `@media (prefers-reduced-motion: reduce)` block (`index.css:222-241`) neutralizes fade/hover/press animations; recharts animations are also gated on a `useReducedMotion` hook.

Transitions are consistently short — `duration-200` for color/state changes, `0.12s`–`0.35s` for motion — favoring subtlety over flourish.

---

## 6. Key Files to Reproduce the Palette Exactly

To clone the look, copy these verbatim:

1. **`src/index.css`** (257 lines) — the single source of truth for all tokens: `@theme inline` mapping (15-56), `:root` light palette (58-94), `.dark` palette (96-131), base layer (133-144), and every custom animation/utility (146-257). Quoted in full in §2.1–2.5 above.
2. **`components.json`** — shadcn config (new-york, neutral base, CSS variables, lucide, `@`-aliases). Reproduce this before running `shadcn add`.
3. **`src/utils/constants.ts:45-60`** — the fixed donut hex palettes (light & dark).
4. **`src/lib/utils.ts`** — the `cn()` helper (`twMerge(clsx(...))`).
5. **`index.html:9`** + `@font-face` in `index.css:5-11` — font loading (JetBrains Mono from Google, Geist Sans self-hosted; drop `GeistSans-Variable.woff2` into `public/fonts/`).
6. **`src/components/ui/button-variants.ts`** and **`badge-variants.ts`** — the cva variant definitions.
7. **`src/components/status-badge.tsx`** and **`src/utils/account-status.ts`** — the semantic status-color and quota-threshold color maps that define the app's "health" visual vocabulary.

There is **no `tailwind.config.js`** — Tailwind v4 reads everything from `src/index.css`, so the CSS file plus `@tailwindcss/vite` in `vite.config.ts` is the entire style config.

---

### Design language summary in one paragraph

A cool-neutral, indigo-accented, information-dense operator dashboard. Everything is built on **shadcn/ui + Tailwind v4 + radix** with OKLCH tokens; the light theme is a faintly cool off-white, the dark theme is true-black OLED. The layout is a **capped-width single column** with a **glassmorphic sticky top bar** (segmented pill nav) and a **fixed glassmorphic footer status bar** — no sidebar. Surfaces are `rounded-xl border bg-card` panels with soft three-level shadows and a gentle hover lift. Type is **Geist Sans** for UI and **JetBrains Mono** for code/numbers, leaning on `font-medium`/`font-semibold`, uppercase micro-labels with `tracking-wider`, and `tabular-nums`. Status is communicated through a consistent tinted-pill vocabulary (emerald/amber/orange/red/sky/zinc at `/15` bg), recharts donuts and sparklines with fixed categorical hex palettes, and threshold-colored quota bars. Motion is subtle and reduced-motion-aware: staggered fade-in-up, `press-scale` button feedback, 200ms color transitions.
