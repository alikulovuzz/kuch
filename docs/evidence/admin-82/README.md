# Administrator workspace review evidence

Implementation branch: `codex/admin-workspace-implementation`. This evidence belongs to the final implementation for [issue #75](https://github.com/alikulovuzz/kuch/issues/75) and its [approved specification #82](https://github.com/alikulovuzz/kuch/issues/82). The final reviewed commit and CI run are recorded in the delivery report, because embedding a commit's own hash and CI result in that same commit would change its hash.

## Interface review

The local preview used the Codex in-app Chromium browser on Windows with a disposable Node API fixture. Viewport sizes are emulated CSS pixels, not physical phones. The fixture contained 1,000 users, 1,000 invites and 5,000 audit events; it had no live Google or SMTP credentials. All four admin languages (`en`, `ru`, `uz-Latn`, `uz-Cyrl`) were checked across Overview, Users, Invites, AI Coach and Activity at 1440×900, 1024×768, 768×1024, 390×844 and 320×720: 100 section/language/size combinations, with no horizontal overflow. Security and verification entry were each checked in 20 language/size combinations. The revised sign-in, reset, verification and recovery forms were then rechecked in all four languages at 320 and 390 CSS-pixel widths. Every tested auth button measured at least 44 CSS pixels tall, and none of those pages overflowed horizontally. Narrow simulated viewports of 720×450 and 512×384 were also checked without overflow; browser-level 200% zoom remains a separate manual check.

Representative final stills:

| Surface | Desktop | Phone |
| --- | --- | --- |
| Overview | [English 1440×900](en-1440x900-overview-final.png), [Russian](ru-1440x900-overview-final.png), [Uzbek Latin](uz-Latn-1440x900-overview-final.png), [Uzbek Cyrillic](uz-Cyrl-1440x900-overview-final.png) | [English 390×844](en-390x844-overview-final.png), [Russian 320×720](ru-320x720-overview-final.png) |
| Workflows | [Invites](en-1440x900-invites-final.png), [Coach](en-1440x900-coach-final.png), [Activity](en-1440x900-activity-final.png) | [Security](en-390x844-security-final.png), [confirmation](en-390x844-security-confirm-final.png) |
| Authentication | [Verification](en-1440x900-verification-final.png) | [Sign-in 320×720](en-320x720-login-final.png), [reset 320×720](ru-320x720-reset-final.png), [verification 390×844](uz-Cyrl-390x844-verification-final.png) |
| Native browser handoff | — | [English pairing entry](en-390x844-native-pairing-final.png), [Russian pairing entry](ru-390x844-native-pairing-final.png), [Russian pairing sheet](ru-390x844-native-code-sheet-final.png) |

The directory also contains final mobile stills for all four languages for Overview, sign-in, Security and verification. A separate `VITE_MOBILE=1` browser simulation showed the native entry and Russian pairing sheet at 390 CSS pixels, with no horizontal overflow and 50-pixel pairing buttons. Native auth now sends the administrator to the connected server in a browser, preserving a deployment prefix and Security destination, then offers code pairing instead of WebView passkeys. Account-security removal opened a modal alert dialog with focus on Cancel; cancelling restored focus to the initiating button. The Coach credential sheet retained its unsaved draft and blocked section navigation until it was discarded. A configuration draft likewise prompted Stay/Discard on navigation. The administrator sign-in form kept the identifier when the language changed; navigating between email link actions in the same tab displayed the new action. The Activity log rendered 50 records initially and 100 after Show more.

## Volume observations

These are browser interaction times on the local disposable fixture, including automation overhead; they are observations, not a capacity guarantee or a latency target.

| Action | Observed | Result |
| --- | ---: | --- |
| Open Users with 1,000 profiles | 953 ms | 1,000 rows rendered |
| Search `Fixture user 999` | 56 ms | 1 matching row |
| Open Invites with 1,000 codes | 746 ms | 500 unused code buttons and 500 used records |
| Open Activity with 5,000 events | 319 ms | 50 event rows |
| Show more Activity | 360 ms | 100 event rows, no horizontal overflow |

## Automated checks and remaining gates

The targeted frontend admin suites passed, including mobile browser handoff, security leave confirmation, locale readiness and Coach draft behavior. The frontend production build passed, the workout locale check found 18 locales with 2,259 synchronized keys, and the targeted API authentication suites passed (including verified-email Google link conflicts). The whole Windows frontend/API/MCP suites were attempted; unrelated platform-dependent failures were observed in Windows shell/file-watcher/media fixtures. The required Linux GitHub Actions workflow is the authoritative full-suite gate.

The delivery report records the final review commit, Tests workflow run and required job results (`test`, `mcp`, `api`, `api-image`, `compose`).

The live-environment gate remains pending: real Google sign-in/link/cancel/failure, root/subpath proxy callbacks, SMTP delivery of verification and reset links, browser-to-native-mobile pairing/revocation, and native translations need configured services and devices. Operator recovery was rehearsed against disposable data. Human wording/script review for Russian and both Uzbek scripts, and a browser-level 200% zoom review, are pending. No deployment or image publishing is part of this evidence.
