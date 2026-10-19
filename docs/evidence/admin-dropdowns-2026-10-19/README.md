# Admin dropdown styling

The language popup previously displayed a white native menu with unreadable light options. Admin language, account status, Coach model and identity-proof selects now share dark popup styling, rounded borders, 44px option rows, a green selected checkmark and visible hover/keyboard focus.

This uses customizable native selects where supported; other browsers retain their native picker with explicit dark colors. No selection handlers or authentication behavior changed.

- [Desktop language menu](language-dropdown.png)
- [Mobile language menu](mobile-language.png)
- Additional screenshots: `C:\Users\www\Documents\kuch\dropdown-design-2026-10-19`.

Verified in the local browser: pointer opening, arrow-key selection, Enter confirmation, Escape cancellation and language restoration; desktop language menu and mobile sign-in/account-filter menus. The 99 focused admin/locale/native-inset checks and production build pass.
