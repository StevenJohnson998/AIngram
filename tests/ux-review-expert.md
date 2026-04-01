# AIngram UX Expert Review

**Date:** 2026-04-01
**Reviewer:** Independent UI/UX evaluation (first-time user perspective)
**Method:** Static HTML/CSS analysis of all pages served at the test instance
**Pages reviewed:** Landing, Search, Topic, Register, Login, Settings, Suggestions, Hot Topics, Review Queue, Notifications, New Article, Profile, Legal, Terms

---

## Overall Score: 7.0 / 10

A remarkably solid developer-built GUI. The design system is well-structured, the CSS is clean and consistent, and the information architecture is logical. The platform is clearly built by someone who understands web fundamentals. The main weaknesses are in onboarding clarity, mobile navigation, and some inconsistencies between pages.

---

## Scores by Category

| Category | Score | Summary |
|----------|-------|---------|
| First Impression | 6/10 | Tagline is clear but hero section lacks punch |
| Navigation | 6/10 | Functional but navbar breaks on mobile, no hamburger |
| Visual Hierarchy | 7/10 | Good use of trust colors and card system |
| Consistency | 7/10 | Strong design tokens, a few cross-page drifts |
| Onboarding | 5/10 | Agent concept is confusing for newcomers |
| Accessibility | 7/10 | Good touch targets, some contrast issues |
| Information Architecture | 8/10 | Logical structure, good tab usage |
| Error Handling | 7/10 | Present and clear, a few gaps |
| Mobile Responsiveness | 5/10 | Breakpoints exist but navbar is the weak link |

---

## 1. First Impression (6/10)

**What works:**
- The tagline "The knowledge base for AI agents" is immediately clear
- The subtitle "Collaborative, multilingual, trust-scored. Built by agents, for agents." communicates the differentiation
- Search front-and-center is the right pattern for a knowledge base
- Trust-colored cards immediately signal the quality scoring system

**Issues:**

**[P1] No explanation of what "trust-scored" means for a first visitor.**
A new user sees colored borders (green/yellow/red) on topic cards but has zero context for what the numbers mean. The trust badge shows "0.75" -- what does that mean? Is 1.0 good? Is it a percentage?

- File: `index.html`, lines 82-95 (hot topics rendering)
- Recommendation: Add a small legend or tooltip near the first trust badge: "Trust: 0.75/1.0 -- Community confidence score". Could be a one-liner under the "Hot Articles" heading: "Scored by community votes (0 = unverified, 1 = high confidence)."

**[P2] Hero section has no visual weight.**
The h1 + subtitle + search bar is functional but visually flat. There is no illustration, icon, or visual anchor. For a platform called "AIngram" with an AI + knowledge concept, the hero feels generic.

- Recommendation: Not asking for a full redesign -- just add a subtle background gradient or a small SVG icon next to the h1. Even a single line of `background: linear-gradient(...)` on the hero section would add visual interest. Quick win.

**[P3] "Loading articles..." / "Loading activity..." shows on first paint.**
Both the Hot Articles and Recent Activity sections display "Loading..." text before JS hydrates. If the API is slow, the user sees a page full of "Loading..." with no indication of progress.

- File: `index.html`, lines 42 and 49
- Recommendation: Replace "Loading..." with skeleton loaders (CSS-only animated rectangles). The design system already has `--bg-muted` and `--shadow-sm` -- a `.skeleton` class with a shimmer animation would take ~15 lines of CSS.

---

## 2. Navigation (6/10)

**What works:**
- Sticky navbar with dark background is standard and functional
- Active state highlighting works correctly (via `api.js` `updateNavbar()`)
- Nav items are logically grouped: content nav (Search, Review, Suggestions, Hot Topics) left, auth actions right
- Logged-in state correctly shows user name, notifications bell, settings gear, logout

**Issues:**

**[P1-CRITICAL] No hamburger menu on mobile.**
The navbar has 4 nav links + 2 action buttons. At 640px, the CSS only reduces padding and gaps (`style.css` lines 1267-1303). There is no `display: none` on `.navbar-nav` and no hamburger toggle. On a 375px screen, the nav items will overflow horizontally or wrap awkwardly.

- File: `style.css`, lines 1267-1303 (mobile breakpoint)
- Recommendation: At `max-width: 640px`, hide `.navbar-nav`, add a hamburger button that toggles a slide-down menu. This is the single most impactful mobile fix. Priority: HIGH.

**[P2] "Review" and "Suggestions" in the main nav are confusing for visitors.**
These are contributor/moderator features. A first-time visitor clicking "Review" gets "You must be logged in with policing privileges" -- a dead end. "Suggestions" loads but shows an empty state with governance jargon.

- File: All HTML files (navbar is duplicated in every file)
- Recommendation: Consider showing Review/Suggestions only in the logged-in navbar state, or at minimum add a tooltip/subtitle explaining what these are. Could also grey them out for logged-out users with a "Login to access" tooltip.

**[P3] No breadcrumb on topic pages.**
When viewing an article, there is no way to understand where you are in the hierarchy. The only navigation back is the logo or the browser back button.

- File: `topic.html`
- Recommendation: Add a simple breadcrumb: "Home > [Topic Title]". CSS is trivial: `font-size: var(--text-sm); color: var(--text-muted);` above the title.

**[P2] Notification bell uses raw Unicode character.**
The notification icon (`&#128276;` = bell emoji) renders differently across OS/browser combinations. On some systems it will be a colorful emoji, on others a monochrome glyph, on others a box.

- File: `api.js`, `updateNavbar()` function
- Recommendation: Use an SVG icon or a simple CSS-only bell shape. Same issue with the settings gear (`&#9881;`).

---

## 3. Visual Hierarchy (7/10)

**What works:**
- Trust color system (green/yellow/red) is intuitive and consistently applied
- Card-based layout with left border coloring is an effective pattern
- Section titles use appropriate weight (`--text-xl`, `font-weight: 700`)
- The chunk-flow continuous article layout is well-designed -- colored side bars create a visual rhythm that communicates quality at a glance
- Tabs on the topic page (Article / Discussion / History) are clean and functional

**Issues:**

**[P2] Topic cards on landing page lack visual differentiation.**
All cards in the "Hot Articles" grid look identical in structure. Nothing draws the eye to higher-quality or more-active articles. The trust badge is a small pill that blends in.

- File: `index.html`, topic card template in JS (lines 82-95)
- Recommendation: Make trust score more prominent. Options: (a) increase badge font size on cards, (b) add a subtle background tint to high-trust cards, (c) show a small bar chart of activity.

**[P2] Filter controls blend into the background.**
The `.filter-controls` bar (`style.css` line 970) uses `background: var(--bg-muted)` which is `#f1f5f9` -- almost identical to the page background `#f8fafc`. The filter section is easy to miss.

- File: `style.css`, line 976
- Recommendation: Add `border: 1px solid var(--border-color);` to `.filter-controls`. This alone would make the filter row pop. Current state: no border, making it visually merge with the page.

**[P3] The "btn-outline" class is referenced but never defined.**
The "Watch" button on topic pages uses `class="btn btn-sm btn-outline"` but `.btn-outline` has no CSS definition in `style.css`.

- File: `topic.html` line 40, also `notifications.html` (Mark all as read button)
- Impact: These buttons will render as default `.btn` without visible border or distinction
- Recommendation: Add a `.btn-outline` class:
  ```css
  .btn-outline {
    background: transparent;
    color: var(--brand-accent);
    border-color: var(--brand-accent);
  }
  .btn-outline:hover {
    background: #eff6ff;
  }
  ```

---

## 4. Consistency (7/10)

**What works:**
- CSS custom properties are used consistently throughout (`--space-*`, `--text-*`, `--radius-*`)
- Card patterns, badge styles, and button variants are reused correctly across pages
- Footer is consistent across most pages
- All pages share the same navbar HTML structure

**Issues:**

**[P1] Suggestions page uses a completely different API pattern.**
Every other page uses the shared `api.js` with `API.get()`, `API.post()`, `updateNavbar()`, `escapeHtml()`, `timeAgo()`. The suggestions page (`suggestions.html`) defines its own `API` constant, its own `headers()` function, its own `getToken()`, and does NOT include `api.js` at all.

- File: `suggestions.html`, script block starting at line ~132
- Impact: The suggestions page will NOT update the navbar (no `updateNavbar()` call), will NOT show the logged-in state correctly, and has a different auth mechanism (manual cookie parsing vs. credentials: same-origin). It also lacks `escapeHtml()` usage on user content -- potential XSS vector.
- Recommendation: Refactor to use the shared `api.js`. This is both a consistency and a security issue. Priority: HIGH.

**[P2] Hot Topics page calls `timeAgo()` before `api.js` defines it.**
The hot-topics page uses an IIFE that calls `timeAgo(topic.last_activity)` but defines its own local `timeAgo` function at the bottom of the IIFE. However, the page DOES include `api.js` via `<script src="api.js">`, so the global `timeAgo` from `api.js` is also available. The local version creates a `Date` object differently than the global one. Additionally, `esc()` is defined locally instead of using the global `escapeHtml()`.

- File: `hot-topics.html`, script block
- Impact: Minor -- works but is confusing for maintainability
- Recommendation: Remove the local `esc()` and `timeAgo()` functions, use the globals from `api.js`.

**[P2] Suggestions page footer is different from all other pages.**
All other pages use `<footer class="site-footer">` with the full footer (GitHub, API Docs, Legal, Terms). The suggestions page uses a minimal inline footer: `<footer style="text-align: center; padding: var(--space-lg); ...">` with only Legal + Terms links.

- File: `suggestions.html`, bottom of file
- Recommendation: Use the standard `site-footer` class with all links.

**[P3] Inconsistent form input classes.**
The suggestions page uses `class="form-control"` for inputs (a Bootstrap convention). Every other page uses `class="form-input"` (the actual class defined in `style.css`). `.form-control` is never defined.

- File: `suggestions.html`, form fields (sug-title, sug-category, sug-topic, sug-content, sug-rationale)
- Impact: These inputs will have no styling -- no padding, no border-radius, no focus ring
- Recommendation: Change all `form-control` to `form-input`.

---

## 5. Onboarding (5/10)

**What works:**
- Registration form is simple: name, email, password, confirm, terms checkbox
- Post-registration success message is clear with two CTAs: "Start Exploring" and "Add an AI Agent"
- Login page has a collapsible "Connecting an AI agent" help section with step-by-step instructions
- The `?help=agent` URL parameter auto-opens the agent help section -- good deep linking

**Issues:**

**[P1] The concept of "agents" is introduced without context.**
The registration page says "Want to connect an AI agent? Register first, then configure it in Settings." A new user who just wants to browse knowledge articles has no idea what this means or why they would want it. The entire Settings page is dominated by agent configuration.

- Recommendation: Add a brief one-sentence explanation on the landing page or registration page: "AIngram is a knowledge base where humans and AI agents collaborate. You can browse freely, or connect your AI assistant to contribute."

**[P2] New Article wizard requires an "assisted agent" -- no guidance when none exist.**
Clicking "New Article" shows Step 1: "Select an agent" with message "You have no assisted agents. Create one in Settings first." This is a dead end for a user who just registered and wants to write an article.

- File: `new-article.html`, lines 56-60
- Recommendation: The "Write manually" option exists on Step 2 but is unreachable without an agent. Consider either: (a) allowing Step 1 to be skipped when writing manually, or (b) showing the "Write manually" button directly on Step 1 alongside the "no agents" message.

**[P2] No empty state guidance on the landing page.**
When the platform is new or has few articles, the landing page shows "No articles yet. Be the first to create one!" but doesn't link to the new-article page or explain the process.

- File: `index.html`, line 96
- Recommendation: Turn "Be the first to create one!" into a link to `./new-article.html`.

**[P3] "Policing privileges" jargon on the Review Queue page.**
The error message says "You must be logged in with policing privileges." A new user will not know what "policing privileges" are or how to get them.

- File: `review-queue.html`, JS error handler
- Recommendation: Change to: "Access requires the Reviewer badge. Contribute knowledge and earn reputation to unlock it."

---

## 6. Accessibility (7/10)

**What works:**
- `min-height: 44px` on buttons and interactive elements (`style.css` lines 487, 554, 374, 461) -- meets WCAG 2.5.5 target size requirements
- Form inputs have proper `<label>` elements with `for` attributes
- `font-size: 16px` base prevents iOS zoom on input focus
- All forms have `required` attributes and `minlength`/`maxlength` constraints
- Color is not the only indicator -- trust badges include numeric values alongside colors
- `line-height: 1.6` on body provides comfortable reading

**Issues:**

**[P1] Low contrast: `.text-muted` on light background.**
`--text-muted: #94a3b8` on `--bg-secondary: #f8fafc` gives a contrast ratio of approximately 3.1:1. WCAG AA requires 4.5:1 for normal text. This class is used extensively for timestamps, descriptions, helper text.

- File: `style.css`, line 23
- Recommendation: Change `--text-muted` to `#64748b` (slate-500), which gives ~5.3:1 contrast. This is a single-line change that improves readability site-wide.

**[P2] Trust badge color contrast.**
The `.badge-trust-medium` uses `color: #854d0e` on `background: #fef9c3`. Contrast ratio is approximately 4.8:1 -- barely passes AA. The `.badge-trust-high` (`#166534` on `#dcfce7`) is better at ~6.2:1.

- File: `style.css`, lines 293-306
- Recommendation: Darken medium badge text to `#713f12` for a safer margin.

**[P2] No focus-visible styles on nav links.**
The `.nav-link` has hover styles but no `:focus-visible` styles. Keyboard users navigating the dark navbar cannot see which link is focused.

- File: `style.css`, lines 132-151
- Recommendation: Add:
  ```css
  .nav-link:focus-visible {
    outline: 2px solid var(--brand-accent);
    outline-offset: 2px;
  }
  ```

**[P2] Chunk hover actions are invisible to keyboard users.**
`.chunk-hover-actions` has `opacity: 0` and only appears on `:hover` (`style.css` line 879-884). Keyboard-focused chunks never reveal the vote/flag buttons. The mobile fix (line 1301) always shows them, but desktop keyboard users are excluded.

- File: `style.css`, lines 879-884
- Recommendation: Add `.chunk-item:focus-within .chunk-hover-actions { opacity: 1; }`.

**[P3] `lang="en"` is hardcoded on all pages.**
The platform is described as "multilingual" but every page has `<html lang="en">` regardless of content language. Screen readers will announce everything in English prosody even for Chinese or French content.

- File: All HTML files, line 2
- Recommendation: For the topic page, dynamically set `document.documentElement.lang` based on the topic's language. For other pages, `en` is fine.

---

## 7. Information Architecture (8/10)

**What works:**
- Clear page hierarchy: Landing > Search/Browse > Topic > Chunks
- Topic page tabs (Article / Discussion / History) are the right separation
- Settings page tabs (Account / AI Agents / Subscriptions) are logical
- The chunk-flow layout (continuous reading with side trust bars) is an excellent design for a knowledge base -- it reads like an article while showing per-chunk quality
- Search page offers three search modes (Full-text, Semantic, Hybrid) which is appropriate for the audience
- The new-article stepper (Agent > Details > Preview > Publish) is a well-structured wizard

**Issues:**

**[P2] "Suggestions" vs "Review Queue" -- overlapping concepts.**
Both pages deal with community-reviewed content. Suggestions are improvement proposals; Review Queue has flags + proposed edits. The distinction is not immediately clear from the nav labels alone.

- Recommendation: Rename "Review" to "Moderation" or "Review Queue" (using the full label). Add subtitles under each nav link on first visit (a small `.nav-link-subtitle` that hides after the user has visited).

**[P2] No link from landing page to New Article.**
The primary creation action ("+ New Article") only appears in the navbar after login. There is no CTA on the landing page encouraging contribution.

- File: `index.html`
- Recommendation: Add a small CTA card in the Hot Articles section or below it: "Know something worth sharing? Write an article." with a link to `./new-article.html`.

**[P3] Profile page shows "Sanctions" to every user.**
The profile page always renders a "Sanctions" section even for clean accounts. Showing an empty "Sanctions" section with "Loading..." creates unnecessary anxiety.

- File: `profile.html`, lines 50-54
- Recommendation: Only show the Sanctions section if the user actually has sanctions. Load it silently and append to DOM only if non-empty.

---

## 8. Error Handling (7/10)

**What works:**
- `showAlert()` utility provides consistent error display across pages
- Login handles the `EMAIL_NOT_CONFIRMED` error code with an inline "Resend confirmation email" button -- excellent UX
- Registration validates password match client-side before hitting the API
- The new-article wizard provides specific error messages per chunk ("Chunk 1 must be at least 10 characters")
- Network errors are caught and displayed as user-friendly messages
- Button states change during loading ("Creating account..." / "Logging in..." / "Generating...")

**Issues:**

**[P2] `alert()` used for subscription actions.**
The search page uses `alert('Subscribed!')` and `alert('Failed to create subscription')`. Native alerts are jarring and not styled.

- File: `search.html`, `subscribeToSimilar()` function
- Recommendation: Use `showAlert()` into a container near the button, or show a toast notification. The infrastructure for alerts already exists.

**[P2] Silent failure on activity feed refresh.**
The landing page refreshes the activity feed every 60 seconds. If the refresh fails, the catch block is completely empty -- the user sees stale data with no indication.

- File: `index.html`, `loadActivityFeed()` catch block
- Impact: Low -- keeps previous content, which is reasonable. But a subtle "Last updated X ago" indicator would improve trust.

**[P3] No 404 page.**
Visiting a non-existent route returns the API's JSON error. There is no custom 404 page to guide users back.

- Recommendation: Create a simple `404.html` with the standard layout and a "Back to home" link.

---

## 9. Mobile Responsiveness (5/10)

**What works:**
- `<meta name="viewport" content="width=device-width, initial-scale=1.0">` is present on all pages
- `grid-2` class switches from 2-column to 1-column at 640px (`style.css` line 1257)
- Review queue actions stack horizontally on mobile (`style.css` lines 1534-1546)
- Chunk hover actions are always visible on mobile (no hover on touch) (`style.css` line 1301)
- Stepper labels hide on mobile, showing only numbers (`style.css` line 1978)
- Diff view stacks vertically on mobile (`style.css` line 1594)
- `flex-wrap: wrap` is used on filter controls and meta rows

**Issues:**

**[P1-CRITICAL] No hamburger menu (repeated from Navigation).**
The navbar with 4 links + actions will overflow on any phone screen. This is the single most impactful responsive issue.

**[P2] Only one breakpoint (640px).**
The entire responsive strategy uses a single breakpoint. There is no tablet breakpoint (768px-1024px). On a 768px iPad, the page-content-wide (max-width: 1100px) will have very thin margins, and the navbar may still feel cramped.

- File: `style.css`, all `@media` rules
- Recommendation: Add a `@media (max-width: 768px)` breakpoint for tablet-specific adjustments (reduce nav gap further, adjust page padding).

**[P2] Settings page AI agent type toggle on mobile.**
The `.agent-type-toggle` uses `display: flex` with two `flex: 1` children. On a 320px screen, each card gets ~140px. The text inside ("You control it via GUI buttons. Uses your AI provider.") will be very cramped.

- File: `style.css`, lines 1870-1905
- Recommendation: Add `@media (max-width: 640px) { .agent-type-toggle { flex-direction: column; } }`.

**[P3] Diff panels on review queue have `max-height: 200px`.**
On mobile, the two diff panels stack vertically (good), but each is capped at 200px. With the panel header, that leaves about 170px of visible text. For longer chunks, this makes comparison difficult.

- File: `style.css`, line 1562
- Recommendation: Increase to `max-height: 300px` on mobile, or use `max-height: 40vh`.

---

## Quick Wins (< 1 hour each)

1. **Fix `.btn-outline` missing class** -- 6 lines of CSS. Immediate visual fix for Watch/Mark-read buttons.
2. **Fix `--text-muted` contrast** -- Change `#94a3b8` to `#64748b`. One line, site-wide improvement.
3. **Fix suggestions page `form-control` class** -- Change to `form-input`. 5 replacements, immediate styling fix.
4. **Add border to `.filter-controls`** -- One CSS property addition.
5. **Make "Be the first to create one!" a link** -- One HTML change on landing page.
6. **Add `:focus-visible` to nav links** -- 4 lines of CSS.
7. **Add `skeleton` loading animation** -- ~15 lines of CSS, replace "Loading..." text.

## Medium Effort (1-4 hours)

1. **Hamburger menu for mobile** -- JS toggle + CSS for nav collapse. Most impactful single fix.
2. **Refactor suggestions.html to use shared api.js** -- Consistency + XSS fix.
3. **New Article: allow "Write manually" without agent selection** -- Bypass Step 1.
4. **Add trust score legend/tooltip** -- Small component, big clarity gain.
5. **Add `.chunk-item:focus-within` for keyboard accessibility** -- CSS + tab-index on chunks.

## Major Rework (> 4 hours)

1. **Redesign onboarding flow** -- The agent concept needs a proper introduction. Consider a "How it works" section on the landing page or a guided tour on first login.
2. **Unify suggestions page architecture** -- The page is currently a standalone island. Needs full integration with the shared API client, navbar, and footer patterns.
3. **Add a second breakpoint (768px) and tablet layout** -- Requires reviewing all pages for intermediate sizes.

---

## Architecture Notes

**Strengths:**
- The `api.js` shared client with `_unwrap()` envelope handling is well-designed
- CSS custom properties create a maintainable design system
- The trust-color system (3 tiers with matching badges, borders, bars, and text classes) is thoughtfully comprehensive
- Tab system with `data-group` attributes allows multiple independent tab sets per page
- The chunk-flow layout is genuinely innovative for a knowledge base UI

**Concerns:**
- Every page duplicates the full navbar HTML. A template system (even basic JS includes) would prevent drift.
- Inline `style=""` attributes are used heavily alongside the CSS classes. This makes overrides unpredictable and complicates responsive adjustments. Examples: `style="max-width: 520px;"` on register, `style="max-width: 480px;"` on login, `style="max-width: 640px;"` on settings.
- No CSS minification or bundling, but this is acceptable for the current stage.
