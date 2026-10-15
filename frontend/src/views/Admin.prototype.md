# Admin layout comparison — disposable

Question: Which desktop/mobile hierarchy makes all admin workflows easy to reach?

Open `Admin.prototype.html` directly in a browser. No installation or server is needed. Use `#/admin?variant=A` (or B/C); the bottom arrows switch variants. This self-contained fixture sits beside Admin.jsx but is deliberately not imported by the application: design-only review must not depend on real admin authentication, user records, or mutation endpoints. It does not enter the production bundle.

- A: overview and persistent desktop sidebar; balanced entry points to every workflow.
- B: horizontal navigation and directory/detail workspace.
- C: live activity first, with invitations and AI configuration alongside it.

The user confirmed that all daily workflows matter. No variant has been accepted yet.

Review Russian, Uzbek Latin, Uzbek Cyrillic and English labels; long names; search and status filters; the bottom state selector (empty/loading/error); Tab focus; mobile stacking. Translations are provisional layout samples, not an approved translation catalogue. Training names are user content. Demo controls and stub-action notices remain English.

Proposed shared visual rules: system font, 15px body / 18px section / 30px desktop heading, mostly regular and 600 weights; existing black/neutral surfaces and green accent; 8px spacing increments, 16–24px card padding; 44px minimum controls; cyan focus outline; text labels alongside status colors. Below 1000px content columns stack; below 650px sidebar navigation becomes a compact wrapping section grid, with full names wrapping. Workout navigation is replaced by an explicit Home return. Copy-link and account actions are visibly stubbed.

Checked in the browser: A/B/C switching, name search, Uzbek Cyrillic selection, error state, and the A layout at 390px and 1440px. This is not a full accessibility audit or backend verification. Known prototype limits: only five fixture accounts; fixed summary counts; partial settings screens; no production authentication, persistence, API calls or operational actions. Loading/error state selector applies to the user list.

Decision ticket: https://github.com/alikulovuzz/kuch/issues/77
Map: https://github.com/alikulovuzz/kuch/issues/75

Do not merge this branch. Implementation awaits an accepted design and a later explicitly requested session.
