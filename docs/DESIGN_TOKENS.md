# PayPal PolicyTwin — design tokens and UI system

The interface is called **Financial Intelligence Control Room**. This file records the tokens, the contrast measurements behind them,
the component inventory, and what has (and has not) been verified for accessibility.

Tokens live in `tailwind.config.ts`; global rules in `src/app/globals.css`; reusable components in `src/components/ds/`, `src/components/shell/`, `src/components/run/panels.tsx`.

## Colour tokens

| Token | Fill / border / icon | Text variant (`*-ink`) | Tint (`*-bg`) |
|---|---|---|---|
| `canvas` (page) | `#F4F7FB` | | |
| `surface` / `surface-2` | `#FFFFFF` / `#EEF3F9` | | |
| `navy` (shell, dark panels) | `#071A33` (`navy-2` `#0C2547`, `navy-3` `#14325E`) | | |
| `ink` (text) / `ink-mute` | `#0B1F38` | `ink-mute` `#55677E` | |
| `brand` (actions, focus) | `#1769E0` (`electric` `#3987F5`) | `#1257B8` | `#EAF3FF` |
| `twin` (twin / AI-assisted accents) | `#18AFCF` | `#09708A` | `#E6F7FB` |
| `pass` | `#11875D` | `#0B6B4A` | `#E9F8F1` |
| `review` | `#C77A08` | `#8F5600` | `#FFF5DE` |
| `block` | `#C9363E` | `#A82A31` | `#FDECEE` |
| `line` / `line-strong` | `#DCE5EF` / `#C3D1E2` | | |

### Why there are `*-ink` text variants (a deliberate deviation from the brief)

The brief's palette is used **exactly** for fills, borders, icons and large shapes. For **text** several of those colours do not reach
WCAG AA (4.5:1) on the tinted backgrounds they are used on, so each has a darker `ink` variant used for text only.
Measured with the WCAG 2.x relative-luminance formula:

| Foreground → background | Ratio | AA text |
|---|---|---|
| brief muted `#62748A` → canvas | 4.46 : 1 | fails |
| brief muted `#62748A` → surface-2 | 4.29 : 1 | fails |
| **`ink-mute` `#55677E`** → canvas / surface / surface-2 | 5.39 / 5.79 / 5.19 : 1 | passes |
| brief pass `#11875D` → pass tint | 4.12 : 1 | fails |
| **`pass-ink`** → pass tint / white | 5.96 / 6.53 : 1 | passes |
| brief review `#C77A08` → review tint | 3.12 : 1 | fails |
| **`review-ink`** → review tint / white | 5.54 / 6.00 : 1 | passes |
| brief twin `#18AFCF` → twin tint | 2.36 : 1 | fails |
| **`twin-ink`** → twin tint / white / surface-2 | 5.16 / 5.68 / 5.09 : 1 | passes |
| brief block `#C9363E` → block tint | 4.51 : 1 | passes (barely) |
| **`block-ink`** → block tint / white | 6.05 / 6.91 : 1 | passes |
| brand `#1769E0` → brand tint | 4.54 : 1 | passes (barely) |
| **`brand-ink`** → brand tint / white | 6.09 / 6.82 : 1 | passes |
| white → brand / pass / block (solid buttons) | 5.08 / 4.52 / 5.15 : 1 | passes |
| white → `review-ink` (solid REVIEW badge) | 6.00 : 1 | passes (the brief's amber fails with white text) |
| white → navy / white at 70 % → navy | 17.43 / 8.94 : 1 | passes |

Rule of thumb: **use `*-ink` for any text on a tint or on white; use the base colour for borders, icons, bars and big shapes.**

## Typography

Self-hosted variable fonts (no third-party request at runtime): **Space Grotesk** (display / headings, `font-display`), **Inter** (UI text, `font-sans`),
**JetBrains Mono** (ids, field names, amounts, `font-mono`). Fallback stacks are system fonts. Base rules for headings and body are in `@layer base`,
so a utility such as `text-white` on a heading always wins (an unlayered rule would silently override it — this caused a real bug during the build).

## Shape, elevation, motion

* Radii `lg 10px`, `xl 14px`, `2xl 18px`. Shadows `card`, `lift`, `drawer`, `ring` (focus glow).
* Motion is CSS only and short (0.2–0.25 s entrances, a single 1.2 s verdict pulse, a looping dash on the pipeline flow lines).
  `@media (prefers-reduced-motion: reduce)` collapses all animation and transition durations to ~0 and runs iterations once.
  Count-up numbers also render their final value immediately under reduced motion.
* Motion is information (something changed / something is running), not decoration.

## Interaction rules

* **Focus:** every keyboard-reachable control has a 2 px brand outline (light on the navy shell). `scroll-padding-top` keeps focused fields clear of the sticky headers.
* **Touch:** on `pointer: coarse` devices `.btn`, `.field`, tabs and `.tap` are at least 44 px tall (the rule is `!important` so compact variants cannot shrink below it).
* **Colour is never the only signal:** every verdict / severity / provenance badge also carries an icon and a word (PASS, REVIEW, BLOCK, SIMULATED, SYNTHETIC …).
* **Overlays:** dialogs, sheets, popovers, menus and tooltips are Radix primitives (focus trap, Esc, return focus). The evidence drawer is the one exception by design:
  at ≥ 1024 px it is *docked and non-modal* so the matrix stays usable beside it; below that it becomes a full-screen sheet.
* **Scrollable regions** (wide tables) are keyboard-focusable and labelled.
* **Long tokens** (invariant codes, ids) wrap (`break-words` on `<main>`) instead of forcing horizontal page scroll.

## Provenance language (what the badges mean)

| Badge | Meaning |
|---|---|
| `SANDBOX` | The operation was sent to the real PayPal Sandbox (test money). Only possible when Sandbox credentials are configured. |
| `SIMULATED` | Handled by the in-process payment simulator. **Not PayPal.** Always shown on Lane 1, and on Lane 2 when no credentials exist. |
| `DETERMINISTIC` | Decided by code (rules engine, invariants, release gate). |
| `AI-GENERATED` | Proposed by a language model (or its deterministic offline stand-in) and then validated by code. Never a verdict. |
| `SYNTHETIC` | Fictional data / estimate. Never PayPal data. |
| `HUMAN DECISION` | Recorded by a signed-in person; the only thing that can approve a release. |

## Component inventory (the brief's 25)

| Component | File |
|---|---|
| AppShell | `shell/AppShell.tsx` |
| Sidebar | `shell/Sidebar.tsx` |
| TopBar | `shell/TopBar.tsx` |
| EnvironmentBadge, RuntimeBadge | `ds/badges.tsx` |
| PipelineStepper | `ds/PipelineStepper.tsx` |
| PolicyVersionPanel, PolicyDiff, RuleBlock, AmbiguityCard(s) | `ds/policy.tsx` |
| TransactionTwinCard, EvidenceTimeline, InvariantResult | `ds/twin.tsx` |
| DecisionTransition, SeverityBadge, VerdictBadge | `ds/badges.tsx` |
| ScenarioDrawer | `run/ScenarioDrawer.tsx` |
| ReleaseVerdict, ImpactPanel, HumanDecisionPanel | `run/panels.tsx` |
| LoadingSkeleton, EmptyState, ErrorRecovery | `ds/feedback.tsx` |
| ConfirmationDialog (and Sheet, Tip) | `ds/overlays.tsx` |
| Toast | `ds/Toast.tsx` |

Also: `CommandPalette`, `LoginGate`, `DisclosureStrip` / `Footer`, `DemoRunner` (shell), `TwinLab` / `PipelineStages` / `Overview` (home), `Wizard`, `PolicyWorkspace`, `RunConfigDrawer` (policy), `TwinMatrix`, `ScenarioEvidence`, `ReleaseGate`, `RunView` (run).

## Screens and states

Overview (hero + interactive twin lab + pipeline + real metrics) · Policy changes list · New policy change (3-step wizard with live deterministic preview) ·
Policy workspace (A/B panels, ambiguities, run history, run-configuration drawer, 7-stage progress) · Test run (sticky header, URL-synced tabs: Transaction twin matrix, Scenario inspector, Release gate) ·
Evidence · Reports · System status · Login gate · Command palette · Help.
Every data screen has a loading skeleton, an empty state and an error state that answers *what failed, did money move, is it safe to retry, what next*.

## Verification status

Automated and passing in this repository: unit tests for the view-models, 21 browser tests (journey, guided demo, palette, keyboard, responsive, reduced motion, states) and
**7 axe-core suites (WCAG 2.0/2.1/2.2 A + AA rules)** covering the login gate, overview, palette, help, all three wizard steps (including a validation error), policy workspace,
run drawer, matrix, matrix with the evidence drawer, inspector, release gate, confirmation dialog, every list page, the error state and a 390 px phone layout.

**Not verified (needs a person):** screen-reader announcements with real assistive technology, keyboard order judged by a human, forced-colors / high-contrast mode,
200 % / 400 % zoom and text-spacing overrides, right-to-left text, and real touch devices. Automated checks catch only a part of the accessibility problems; this is not a certification of WCAG conformance.
