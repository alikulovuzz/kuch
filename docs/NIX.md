# Kuch on NixOS — Flake & NixOS Module

Kuch can run natively on NixOS through its **Nix flake** and **NixOS module** — no Docker, no
`docker compose`. The flake builds every Kuch component (frontend with the exercise media, API,
MCP server) as reproducible Nix packages; the module declares the whole stack as systemd services
managed by your NixOS configuration. This document covers both.

## 1. Technical introduction

### What the flake provides

`contrib/nix/flake.nix` (inputs: `nixpkgs` pinned to the `nixos-26.05` release branch,
`flake-utils`) exposes, per supported system:

| Output | What it is |
| --- | --- |
| `packages.kuch-frontend` | The React/Vite PWA, built with `buildNpmPackage`. Static files land in `$out/share/kuch`, with the exercise stills and animations from `catalogue/media` in `exercise-media/` next to them. |
| `packages.kuch-api` | The Node.js API (`node server.js`, wrapped as `bin/kuch-api`). |
| `packages.kuch-mcp` | The read-only MCP server for LLM clients (`bin/kuch-mcp`). |
| `packages.default` | Alias for `kuch-frontend`. |
| `apps.kuch` | Runs the **full local stack** — API + frontend (exercise media included) behind a throwaway Caddy (`nix run .#kuch`, default `http://localhost:8080`). |
| `apps.default` | Alias for `kuch`. |
| `devShells.default` | Development shell: Node.js 22, coreutils, git. |
| `checks.nixos-module-eval` | Evaluates the module against a smoke-test config and asserts the resulting services/users/nginx state and extra environment. |
| `checks.kuch-nixos-test` *(Linux)* | Boots a NixOS VM and exercises the HTTP contract end to end (API health, nginx vhost proxy, SPA, exercise media). |
| `nixosTests.kuch` | The same VM test under the conventional `nixosTests` output. |
| `nixosModules.kuch` | The NixOS module (`nixosModules.default` aliases it). |

### What the NixOS module does

`services.kuch.enable = true` manages, purely declaratively:

- a system `kuch` user/group and the data directory (`/var/lib/kuch` by default),
- `systemd.services.kuch-api` — a **hardened** API unit (see [Systemd hardening](#systemd-hardening)),
- `systemd.services.kuch-mcp` — the MCP server, **only if `mcp.enable` is set**,
- read-only options exposing the built frontend and media directories so *your* web server can
  serve them (or `nginx.enable = true` for the module to manage one — see §4),
- `environment` / `environmentFile` — escape hatches to pass extra environment variables to the
  API (for variables Kuch doesn't know about yet). See [Module options reference](#6-module-options-reference).

The module **does not own a web server by default**: it hands you the `web.root` store path (the
exercise media are inside it) to wire into your own reverse proxy (Caddy, nginx, Traefik, …).
Kuch needs everything on **one origin** (passkeys require it), and NixOS deployments already run
a proxy — so the module integrates Kuch into *yours* instead of re-implementing a web server
itself. See §4. If you'd rather have Kuch's web server managed for you, set
`services.kuch.nginx.enable = true` and the module configures an nginx virtualHost for Kuch
(only then is `services.nginx` enabled; on the Caddy-native default it is force-disabled).

### Configuration flow

```text
browser ── HTTPS ──▶ your web server (Caddy / nginx / …)         everything on ONE origin
                     ├─ /         → web.root            (built SPA, SPA fallback to /index.html;
                     │                                   exercise media under /exercise-media/)
                     └─ /api/*    → kuch-api          (systemd, hardened, :3000 internally)
                                                    │
                              kuch-api ──reads/writes──▶ dataDir (/var/lib/kuch)
```

## 2. Repository layout

```text
contrib/nix/
  flake.nix          Flake entry point — packages, apps, devShell, module alias
  flake.lock         Locked inputs
  kuch.nix        The NixOS module (options + systemd/nginx wiring)
  frontend.nix       buildNpmPackage → $out/share/kuch (+ exercise-media/ from catalogue/media)
  api.nix            buildNpmPackage → bin/kuch-api
  mcp.nix            buildNpmPackage → bin/kuch-mcp
  default.nix        package-set aggregator (used by both the flake and the module); reads the
                     release version from api/package.json
```

Everything Nix lives under `contrib/nix/` so the flake stays out of the way of the project's own
build (Docker, CI, the Node packages). The flake reads its sources — `api/`, `frontend/`, `mcp/`,
`catalogue/` — from the repository root two levels up, so it must be evaluated *from a checkout of
the whole repo*, never from a sparse copy of `contrib/nix` alone.

## 3. Building and using the packages

Requirements: Nix with flakes enabled (`nix.conf`: `experimental-features = nix-command flakes`).

```bash
# the flake lives in contrib/nix — start there (from the repo root: nix build ./contrib/nix#… )
cd contrib/nix

nix build .#kuch-frontend         # static site + exercise media → result/share/kuch
nix build .#kuch-api              # API → result/bin/kuch-api
nix build .#kuch-mcp
nix run .#kuch                    # full local stack on http://localhost:8080 (see below)
nix develop                          # dev shell: nodejs_22, git, coreutils
nix flake check                      # eval check + (on Linux) the VM integration test
nix build .#nixosTests.kuch       # run just the VM integration test
```

`nix run .#kuch` starts the API and the built frontend (exercise media included) behind a
throwaway Caddy — open `http://localhost:8080` and use it (passkeys work on `localhost`). Overrides via env
vars: `KUCH_DATA_DIR` (default `/tmp/kuch-data`), `KUCH_API_PORT` (3000),
`KUCH_WEB_PORT` (8080), `KUCH_RP_ID`/`KUCH_ORIGIN` (local defaults). Bear in mind the API
and frontend ports are just defaults — like any local dev server, don't point it at the internet.

For development, `nix develop` drops you into a shell with everything except `node_modules`;
inside it, the standard flow applies:

```bash
cd frontend && npm install && npm run dev     # Vite dev server on :5173, proxies /api to :3000
cd api && npm install && node server.js       # API on :3000
cd mcp && npm test                            # MCP server tests
```

## 4. Serving the app

The module creates the services but never serves HTTP itself. Point your existing reverse proxy —
always on a **single origin** — at the store paths the module exposes:

| Read-only option | Value | Contains |
| --- | --- | --- |
| `config.services.kuch.web.root` | `…-kuch-frontend/share/kuch` | the built SPA, exercise media included |
| `config.services.kuch.media.root` | `${web.root}/exercise-media` | `still/<id>.webp` and `clip/<id>.mp4`, 180 px |

The URL contract the frontend expects ([`frontend/src/lib/exercises.js`](../frontend/src/lib/exercises.js)):

| URL path | Served from | Notes |
| --- | --- | --- |
| `/` | `web.root` | SPA — any unknown path falls back to `/index.html` |
| `/api/*` | `kuch-api` (the `apiPort` you configured) | reverse proxy, keep `/api` on the URL |
| `/exercise-media/*` | `web.root` | plain static files; nothing extra to map |

The exercise media come from `catalogue/media` in the source tree, copied next to the app at build
time by `scripts/catalogue/stage-media.mjs` (the same step the demo and app builds use). Nothing is
downloaded, at build time or at runtime. They are licensed from Gym visual for openGym only, Kuch
carries them unmodified as a non-commercial fork, and they stay at 180 px; don't publish that
directory on its own (see [`NOTICE.md`](../NOTICE.md)).

### Caddy

The idiomatic NixOS pairing (Caddy terminates TLS, gets automatic certs). Put this in a NixOS
module (where `config` is in scope) so the store paths resolve from the module's read-only options:

```nix
{
  services.caddy = {
    enable = true;
    virtualHosts."gym.example.com" = {
      extraConfig = ''
        encode zstd gzip

        handle /api/* {
          reverse_proxy 127.0.0.1:${toString config.services.kuch.apiPort}
        }
        handle {
          root * ${config.services.kuch.web.root}
          try_files {path} /index.html
          file_server
        }
      '';
    };
  };
}
```

The API must **keep** its `/api` prefix (Kuch routes on it), so `/api` uses a plain `handle`
that passes the full URI through. Order matters: `/api` must be handled before the catch-all
`handle` that serves the SPA. The exercise media are files under `web.root`, so `file_server`
serves them; `try_files` only falls back to `/index.html` for paths that don't exist.

### nginx

Two ways to use nginx. If you don't already run an nginx config you care about, let the module
manage one:

```nix
{
  services.kuch = {
    enable = true;
    rpId   = "gym.example.com";
    origin = "https://gym.example.com";
    nginx = {
      enable = true;              # module writes the virtualHost below for you
      # hostName   = "gym.example.com";   # defaults to rpId
      # enableACME = true;                # Let's Encrypt + force TLS (requires security.acme.acceptTerms = true)
    };
  };
  security.acme.acceptTerms = true;       # only needed with enableACME = true
}
```

That renders a `services.nginx.virtualHosts."gym.example.com"` with the SPA root + fallback, the
`/api` proxy, a cache header on `/exercise-media/`, gzip/optimisation settings, and — when `enableACME` — TLS.
It's ordinary `services.nginx` config afterwards, so you can still extend the vhost or add your own
virtualHosts alongside it.

Note: on the Caddy-native default the module force-disables `services.nginx`, so the way to turn
nginx on (and the only supported one, since the force-off is `mkForce`) is `nginx.enable = true`.

### Passkey constraint (read before choosing a hostname)

WebAuthn passkeys are bound to an exact hostname and require HTTPS. Configure the module with the
name that appears in the browser's address bar, not a container name or internal port:

```nix
services.kuch = {
  rpId   = "gym.example.com";            # bare hostname — no https://, no port
  origin = "https://gym.example.com";    # full origin — scheme, no trailing slash
};
```

Changing `rpId` later invalidates every registered passkey. On a LAN without certificates,
plain `http://<ip>` can't do passkeys — use guest mode or put a certificate in front of it.
The full `RP_ID`/`ORIGIN` troubleshooting guide in
[`docs/SELF_HOSTING.md`](SELF_HOSTING.md#passkeys-fail-even-though-rpid-looks-right) applies
word-for-word.

## 5. Using the NixOS module

### Add the flake as an input

```nix
# flake.nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # the flake lives in a subdirectory — ?dir= points at it
    kuch.url = "github:alikulovuzz/kuch?dir=contrib/nix";
  };

  outputs = { self, nixpkgs, kuch, ... }: {
    nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        kuch.nixosModules.default
        ./configuration.nix
      ];
    };
  };
}
```

Then `sudo nixos-rebuild switch --flake .#myhost`.

Not using flakes in your NixOS config? You can also `imports` the module file directly from a
checkout of the repo:

```nix
{ imports = [ "/path/to/kuch/contrib/nix/kuch.nix" ]; }
```

#### Package provenance

When you load the module *through the flake* (`kuch.nixosModules.default`), the default
`services.kuch.package` set is the one built by this flake — from the flake's **locked**
`nixpkgs` input. Importing `contrib/nix/kuch.nix` directly instead falls back to building the
packages from *your system's* nixpkgs, which may differ slightly. If you ever need a specific set,
override `services.kuch.package` explicitly (e.g. `kuch.packages.x86_64-linux` from your flake
inputs).

### Minimal enable (works on `localhost`)

```nix
{
  services.kuch = {
    enable = true;
    rpId = "localhost";
    origin = "http://localhost:8080";
  };
}
```

This gives you the `kuch` system user, `/var/lib/kuch` (created via `StateDirectory` +
tmpfiles — the default `dataDir`) and the `kuch-api` service listening on `:3000`. The exercise
media are already in the frontend package. Pair it with the Caddy or nginx config from §4 pointing
at `web.root`.

### A realistic production example

```nix
{
  services.kuch = {
    enable = true;

    rpId   = "gym.example.com";
    origin = "https://gym.example.com";
    rpName = "My gym";

    adminUids  = "u-abc123";          # comma-separated; gets the admin dashboard
    inviteOnly = true;                # new signups need an invite code
    allowGuest = false;               # remove "Continue without account"

    auditLog = true;
    auditIp  = "net";                 # record masked network address only

    mcp.enable = false;               # off unless you use an LLM client
  };

  security.acme.acceptTerms = true;
  services.caddy.enable = true;       # or configure nginx as in §4
}
```

### Extra environment variables

Kuch's server is env-var driven, so from time to time a new variable reaches the project
before the module grows an option for it. Two options cover the gap — and they are **mutually
exclusive** (setting both is an evaluation error):

```nix
# Per-variable, declared in Nix:
services.kuch = {
  enable = true;
  environment = {
    NEW_FLAG = "1";          # anything the module doesn't already manage
  };
};
```

```nix
# From an existing env file (KEY=VALUE per line), e.g. generated by sops-nix or a tmpfiles rule:
services.kuch = {
  enable = true;
  environmentFile = "/run/kuch/env";
};
```

Both apply to the `kuch-api` systemd unit only; the module's own options take precedence on a
name collision (and for `environmentFile`, systemd applies the file after the declarative
variables, so entries there can still override).

### What enabling the module creates

| Piece | When | Details |
| --- | --- | --- |
| `users.users.kuch`, `users.groups.kuch` | always | system user/group |
| tmpfiles rules | always | `dataDir` (`0750`) |
| `systemd.services.kuch-api` | always | `Restart=on-failure`, runs as `kuch`, hardened |
| `systemd.services.kuch-mcp` | only when `mcp.enable = true` | stdio bridge, runs as `kuch`, same sandbox as the API |
| `services.nginx` vhost | only when `nginx.enable = true` | managed virtualHost (SPA + `/api`, exercise media from the SPA root) |
| `services.nginx.enable = false` | only when `nginx.enable = false` | force-disabled — bring your own web server |

<span id="systemd-hardening"></span>
The API unit is restricted: `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`,
`PrivateDevices`, `ProtectKernelTunables/Modules/ControlGroups`, `RestrictNamespaces`,
`RestrictSUIDSGID`, `NoNewPrivileges`, `LockPersonality`, a system-call allowlist
(`@system-service`, `~@privileged`), and `ReadWritePaths` limited to `dataDir` — the API can only
write to your data directory. The MCP unit is a **stdio bridge that only reads** the same files, so
it runs under the exact same sandbox (plus `StandardInput=null` / `StandardOutput=journal`, since a
systemd-spawned MCP server has no client on stdin).

## 6. Module options reference

All options live under `services.kuch`. Options marked *(read-only)* are computed by the module
for other modules to consume — setting them yourself is an error.

### Top-level options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enable` | `bool` | `false` | Enable Kuch (user, services, directories). |
| `package` | `attrsOf package` | packages built from source | The package set: `{ kuch-frontend, kuch-api, kuch-mcp }`. Override to serve pre-built binaries (e.g. from a cache). |
| `dataDir` | `path` | `/var/lib/kuch` | Persistent data directory — `db.json`, per-user `state-<uid>.json`, `secret`, `vapid.json`, `audit.log`. With the default `/var/lib/kuch`, systemd's `StateDirectory` creates (and cleans up) it; a custom path is created by a tmpfiles rule and `ReadWritePaths` points at it instead. |
| `apiPort` | `port` | `3000` | Port the API listens on (internal — reachable via your reverse proxy, front it yourself if you open the firewall). |
| `rpId` | `str` | `localhost` | WebAuthn Relying Party ID. Bare hostname, must match the address bar exactly. |
| `origin` | `str` | `http://localhost:8080` | Full origin for CSRF validation. Must match the address bar exactly (scheme + host, no trailing slash). |
| `rpName` | `str` | `Kuch` | Display name shown when the browser prompts for a passkey. |
| `sessionDays` | `ints.unsigned` | `90` | Session cookie lifetime, in days. |
| `adminUids` | `str` | `""` | Comma-separated user IDs granted the admin dashboard. Empty = no admin. |
| `inviteOnly` | `bool` | `false` | Require an invite code to create a new profile. |
| `allowGuest` | `bool` | `true` | Offer "Continue without account" (guest mode — never touches the server). Set `false` to remove the button. |
| `auditLog` | `bool` | `true` | Record sign-ins, signouts, failed attempts and admin actions to `audit.log`. |
| `auditMax` | `ints.unsigned` | `5000` | Max audit events kept (`0` = unlimited). |
| `auditDays` | `ints.unsigned` | `90` | Max days of audit events kept. |
| `auditIp` | `enum ["off" "net" "full"]` | `"off"` | IP recording mode: `off` (none), `net` (network only, e.g. `203.0.113.0/24`), `full`. |
| `vapidSubject` | `str` | `""` | Contact URL sent with web-push requests (e.g. `mailto:you@example.com`). Empty = the `origin` is sent. |
| `environment` | `attrsOf str` | `{ }` | Extra environment variables set on the `kuch-api` unit — the escape hatch for variables the module doesn't manage yet (newly added to the project). On a conflict with a variable the module derives from its own options, the module's value wins. Mutually exclusive with `environmentFile`. |
| `environmentFile` | `str` | `""` | Path to an env file (`KEY=VALUE` per line) read by the `kuch-api` unit via systemd `EnvironmentFile=`. systemd applies it *after* the declarative environment, so entries in the file may override module-managed variables. Mutually exclusive with `environment`. |

### `nginx.*` suboptions

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `nginx.enable` | `bool` | `false` | Have the module configure an nginx virtualHost for Kuch via `services.nginx` (SPA root + fallback, `/api` proxy, cache header on `/exercise-media/`, gzip/optimisation). When `false` (Caddy-native default) the module force-disables `services.nginx`. |
| `nginx.hostName` | `str` | `"${rpId}"` | Server name the virtualHost listens on. |
| `nginx.enableACME` | `bool` | `false` | Serve over TLS: `enableACME` + `forceSSL` on the vhost. Requires `security.acme.acceptTerms = true`. |

### `media.*` suboptions

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `media.root` *(read-only)* | `path` | — | `${web.root}/exercise-media`: the stills (`still/<id>.webp`) and animations (`clip/<id>.mp4`). Serving `web.root` already serves it; the option is there for setups that need the path on its own. |

`media.fetchAtBuild`, `media.dataDir`, `media.imageRoot` and `media.gifRoot` were removed in
v1.4.0, when the media moved into the repository. A configuration that still sets one fails to
evaluate with a message saying what to do: delete `fetchAtBuild` and `dataDir`, and replace
`imageRoot`/`gifRoot` (and the `/img/`, `/gif/` routes built on them) with `web.root` alone. An
old `/var/lib/kuch/media` directory is no longer used and can be deleted.

### `web.*` suboptions

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `web.root` *(read-only)* | `path` | — | Built frontend directory (`…/kuch-frontend/share/kuch`). Serve as the SPA root with a fallback to `/index.html`. |

### `mcp.*` suboptions

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mcp.enable` | `bool` | `false` | Run the read-only MCP server as a systemd service (reads the same `dataDir`). Off unless you point an LLM client at it. |
| `mcp.uid` | `string \| null` | `null` | The Kuch user ID (from `db.json` `"users"[].id`) the MCP server serves. Leave unset to auto-pick when exactly one user exists; with multiple users it must be set (the server otherwise exits listing them). |

### Option → environment mapping

The module renders these into the `kuch-api` systemd unit as environment variables — useful if
you are cross-referencing the Docker/`.env` contract:

| Option | Env var | Option | Env var |
| --- | --- | --- | --- |
| `apiPort` | `PORT` | `auditLog` | `AUDIT_LOG` (`1`/`0`) |
| `dataDir` | `DATA_DIR` | `auditMax` | `AUDIT_MAX` |
| `rpId` | `RP_ID` | `auditDays` | `AUDIT_DAYS` |
| `origin` | `ORIGIN` | `auditIp` | `AUDIT_IP` |
| `rpName` | `RP_NAME` | `vapidSubject` | `VAPID_SUBJECT` (set only when non-empty) |
| `sessionDays` | `SESSION_DAYS` | `adminUids` | `ADMIN_UIDS` (set only when non-empty) |
| `allowGuest` | `ALLOW_GUEST` (`1`/`0`) | `inviteOnly` | `INVITE_ONLY` (`1`/`0`) |

`environment` and `environmentFile` are raw passthrough and don't appear here — they end up on the
unit exactly as you write them (see [Extra environment variables](#extra-environment-variables)).

## 7. Data, backups and updates

**Everything** lives under `dataDir` (`/var/lib/kuch`): `db.json` (profiles + public passkeys),
`state-<uid>.json` (each user's plan, workouts, body weight, settings), `secret` (session-cookie
key), `vapid.json` (push keys), and `audit.log`. Passkey private keys never reach the server.

```bash
sudo tar czf kuch-backup-$(date +%F).tar.gz /var/lib/kuch
```

Restore by unpacking it back; nothing else needs reconfiguring.

Updating is a normal flake workflow:

```bash
nix flake update kuch
sudo nixos-rebuild switch --flake .#myhost
```

Your data is untouched; the exercise media come with the new frontend package. Changing `rpId`/`origin` is *not* a
routine update — see the passkey caveat in §4.

## 8. Troubleshooting

| Symptom | Fix |
| --- | --- |
| No passkey prompt / "verification failed" | `rpId`/`origin` don't match the address bar. Ask the server what it loaded: `journalctl -u kuch-api -b \| grep 'kuch-api on'`.  See §4 and `docs/SELF_HOSTING.md`. |
| App loads but exercises show no image/animation | Your web server doesn't serve `web.root` for `/exercise-media/*`, for example because an older config still routes `/img/` and `/gif/` or sends everything unknown to `index.html` without trying the file first. `curl -I https://your-host/exercise-media/NOTICE.md` should answer 200. |
| `/api` returns 502/404 | Your proxy's `apiPort` (`services.kuch.apiPort`) differs from what `reverse_proxy`/`proxy_pass` targets. |
| `nginx` is silently gone after enabling the module | Expected on the Caddy-native default (`nginx.enable = false`): the module sets `services.nginx.enable = false`. Set `services.kuch.nginx.enable = true` to have the module configure nginx for Kuch (or `lib.mkForce true` to manage it yourself). |
| Service won't start | `journalctl -u kuch-api -xe`. Common: custom `dataDir` not created/owned correctly (the tmpfiles rule should handle it; check `systemd-tmpfiles --create`). |
| Eval fails: `environment and environmentFile are mutually exclusive` | Pick one. Set extra vars either as a Nix attrset (`environment`) or in a file (`environmentFile`), never both. |
| You expected a binary cache | The flake builds from source; override `services.kuch.package` (or `packages.*` via a cache/overlay) to substitute binaries. |
| Exercise media licensing | © Aliaksandr Makatserchyk, Gym visual, licensed for use in openGym only (Kuch carries them as a non-commercial fork) and not covered by the AGPL. They ship at 180 px; don't re-host them on their own. See [`NOTICE.md`](../NOTICE.md) |
| `nix run .#kuch` serves a blank site | The app now serves frontend + API + media behind a local Caddy. If something's off, check the log line it prints (ports/`DATA_DIR`) and that nothing else already binds `:3000`/`:8080` — pass `KUCH_API_PORT`/`KUCH_WEB_PORT` to move them. |

## See also

- [`docs/SELF_HOSTING.md`](SELF_HOSTING.md) — the general self-hosting guide (Docker but the domain,
  passkey and admin/audit details apply unchanged).
- [`docs/MOBILE.md`](MOBILE.md) — the stand-alone Android app, an alternative to self-hosting.
- [`docs/DATA_IMPORTS.md`](DATA_IMPORTS.md) — importing from FitNotes/Strong/Hevy/Apple Health.
- [`NOTICE.md`](../NOTICE.md) — third-party notices, including the exercise-media licence.
