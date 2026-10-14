# Kuch MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) bridge that lets an external LLM
application (Claude Desktop, Cursor, Cline, Continue, etc.) read your Kuch profile —
routines, workouts, body-weight log, estimated 1RMs, and muscle balance — directly from your
self-hosted `./data` directory, or from the PostgreSQL database when the API runs on
`STORAGE_BACKEND=postgres`.

It is read-only, runs locally as a stdio process spawned by the LLM client, and adds no new
container. The LLM never sees passkeys, VAPID keys, or session secrets — it can only read the
same training document the Kuch api already writes (`state-<uid>.json`, or the `user_state`
table on Postgres).

The numbers it answers with are computed by the **same pure functions the React UI uses**
(`frontend/src/lib/*.js`) — `estimate1RM`, `loadOfWorkouts`, `effectiveRoutine`, etc. — so a
"what's my bench 1RM?" answer matches the Stats screen exactly.

> Phase 1 of a multi-phase plan. Read-only today; long-lived token auth + write tools are
> planned but not shipped yet. See **Roadmap** below.

## Quick start

### 1. Install

```bash
cd mcp
npm install
```

### 2. Point it at your data

The MCP server reads the same `./data` directory `docker compose up` creates. Pick the profile
to answer for — its user id is in `./data/db.json` under `users[].id`:

```bash
# single-user instance (the common self-hosted case) — auto-detected:
node src/index.js

# multi-user instance, or just to be explicit:
KUCH_UID=<your-uid> KUCH_DATA=/path/to/kuch/data node src/index.js
```

### 3. Register with your LLM client

Add the server to your LLM client's MCP config. For Claude Desktop, edit
`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "kuch": {
      "command": "node",
      "args": ["/absolute/path/to/kuch/mcp/src/index.js"],
      "env": {
        "KUCH_DATA": "/absolute/path/to/kuch/data",
        "KUCH_UID": "<your-uid>"   // optional — auto-detected if you have one profile
      }
    }
  }
}
```

A config written for upstream openGym keeps working: `OPENGYM_DATA` / `OPENGYM_UID` are still
read when the `KUCH_*` names are not set.

For Cursor and other MCP-compatible clients, see the client's MCP docs — the same `command` +
`args` + `env` shape is what every stdio MCP server expects.

Restart the client; you should see the Kuch tools appear with "serving profile \<name\>" on
the server's stderr.

### When the API runs on Postgres

Once the API runs on `STORAGE_BACKEND=postgres`, nothing writes `./data` any more. Point the MCP
server at the database instead by setting `KUCH_DATABASE_URL` (`DATABASE_URL` is read when it is
unset). It then reads the `user_state` and `users` tables and ignores `KUCH_DATA`. A profile is
re-read when its `rev` moves, which the API bumps on every save, so a session logged a moment ago
shows up on the next tool call.

Give it a role of its own that can read only what it needs: the training document and each
profile's id, name and creation date. It never sees credentials, e-mail addresses, password
hashes or push subscriptions, and it cannot write. Run this as the database owner, in the
database and schema the API uses:

```sql
CREATE ROLE kuch_mcp LOGIN PASSWORD '<a password of its own>';
GRANT CONNECT ON DATABASE kuch TO kuch_mcp;
GRANT USAGE ON SCHEMA public TO kuch_mcp;          -- the schema holding the API's tables
GRANT SELECT ON user_state TO kuch_mcp;
GRANT SELECT (id, name, created) ON users TO kuch_mcp;
```

Then give the client that role's URL, never the API's own `DATABASE_URL` (that one can write):

```jsonc
{
  "mcpServers": {
    "kuch": {
      "command": "node",
      "args": ["/absolute/path/to/kuch/mcp/src/index.js"],
      "env": {
        "KUCH_DATABASE_URL": "postgres://kuch_mcp:<password>@localhost:5432/kuch",
        "KUCH_UID": "<your-uid>"   // optional — auto-detected if the database holds one profile
      }
    }
  }
}
```

The database has to be reachable from the machine the LLM client runs on. The profile ids are in
`SELECT id, name FROM users`. The URL may carry the role's password: the server never prints it,
and it says "from Postgres" on its startup line instead.

The migration to Postgres leaves `./data` in place and drops a `MIGRATED-TO-POSTGRES` file in
it. A server still configured for files refuses to answer while that file is there, and tells
you to set `KUCH_DATABASE_URL`, rather than quietly serve the data as it was on the day you
switched.

## Tools

Nine read-only tools in v1:

| Tool | What it answers |
|---|---|
| `list_routines` | What routines are saved in my profile? (names + exercise counts) |
| `get_routine` | What does the Push Day routine prescribe? (sets/reps/weight and rest per exercise) |
| `preview_session` | What will the app actually put on screen when I start this routine — after the progression policy and my history have overridden the plan? |
| `get_week_plan` | What's planned when: the next seven days with their routines and how each was decided (coach week, a pinned session, an override, the weekday plan), the current coach week when one is running, and the weekday table. |
| `list_workouts` | Recent sessions — newest first, with dates, sets done/planned, volume, duration, PRs. |
| `get_workout` | Full set-by-set breakdown of one session, by `workout_id` or by date. On a day with two sessions the date alone returns both ids to pick from rather than guessing at one. |
| `get_bodyweight` | Weigh-ins with the latest weight, the goal line, and deltas vs goal. |
| `estimate_1rm` | All-time best 1RM for an exercise + the trend, or a PR table across all exercises. |
| `muscle_balance` | Which muscles I've trained this week/month/all-time, ranked + which I've neglected. |

`get_routine` and `preview_session` answer two different questions, and confusing them is the
easiest way for a coach to give wrong advice. `get_routine` reports what the routine *stores*.
`preview_session` reports what the athlete will actually *see*: a routine holding "squat 3×8 @
60 kg" opens at 75 kg if the policy progressed or deloaded from that routine's last logged
session. The routine's own weight is the last fallback the session builder consults, not the
first; its reps hold unless a policy that moves reps moved them, or the profile starts planned
sessions from the last session (`starts_from`). Ask `preview_session` before naming a weight.

Each tool returns JSON the LLM can format as it likes; structured fields (sets, dates, levels)
are pre-formatted into human-readable labels in `src/labels.js` so the LLM doesn't need to
re-interpret them.

## How it reuses the training logic

The MCP server imports the training helpers under `frontend/src/lib/` directly as Node ESM
and calls the same functions the React UI does (`history.js`, `onerm.js`, `muscles.js`,
`exercises.js`). The numbers it returns match what the Stats screen shows, because they are
the same code.

The one lib file that wasn't Node-safe was `i18n.js` (Vite's `import.meta.glob` at module
top level) — split into `i18n-core.js` (pure, Node-safe) + `i18n.js` (Vite/React bits,
re-exports from core). `exercises.js` got a one-line `import.meta.env || {}` guard. No new
dependencies landed in `frontend/`, no public exports changed.

## Design constraints honoured

- **Three runtime dependencies:** the MCP SDK, `zod`, and `pg` (the same Postgres driver the API
  uses) for Postgres mode. No HTTP framework.
- **No new container.** stdio transport is spawned by the LLM client; nothing to add to
  `docker-compose.yml`.
- **No new auth.** In file mode the filesystem is the boundary — same as `docker compose`
  running on the user's box. In Postgres mode it is a database role that can read two tables
  and nothing else. No passkey material, VAPID keys, or session secrets ever cross either.
- **No telemetry.** Reads `./data/*.json`, or the database you point it at and nothing else,
  and exits when the LLM client disconnects.

## Tests

```bash
cd mcp && npm test
```

58 cases seeding state from `frontend/src/lib/demoSeed.js` (the same deterministic fixture
the public demo runs on). Pins JSON shape and the user-facing edge cases: rest-day override,
missing routine, zero-workout history, no synced state, superset links, three 1RM formulas.
"Today" is pinned via `vi.useFakeTimers({ now: ..., toFake: ['Date'] })` so date-dependent
tools see consistent values regardless of when the suite runs. The pure lib functions have
their own 92 tests in `frontend/src/lib/*.test.js`.

The Postgres-mode tests (`test/state-pg.test.js`) need a database to make throwaway schemas in,
built by the API's own migrations; they are skipped with a message when it is not set:

```bash
DATABASE_URL_TEST=postgres://user:pass@localhost:5432/kuch_test npm test
```

## Roadmap

- **Done (Phase 1):** read-only stdio, 8 tools, direct `./data` access.
- **Done (Phase 1.5):** `preview_session` — the policy's next prescription, the opening set
  rows it produces, and which of plan / confirmed weight / history each number came from.
- **Phase 2:** read+write over stdio. Requires a long-lived token auth path minted from the
  admin dashboard (new `./data/tokens.json`) and a write-lock against the web UI's read-modify-
  write of `state-<uid>.json`. Tools: `log_workout`, `add_bodyweight`, `edit_routine`,
  `assign_weekday`, `override_day`.
- **Phase 3:** Streamable HTTP transport, opt-in 4th container in `docker-compose.yml`. Same
  tool implementations, second transport — the MCP SDK supports both behind one tool registration.

## License

AGPL-3.0-or-later, same as Kuch and upstream openGym.
