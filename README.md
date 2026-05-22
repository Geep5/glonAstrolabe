# glonAstrolabe

Live 3D dashboard for a **[glon](https://github.com/Geep5/glon)**
environment. Every object is a planet; clicking an agent or peer opens
the inspector with deep-link buttons into the agent's Discord chat
threads. Agent-to-agent conversations live in Discord — Astrolabe is
the observatory, not the chat client.

## What you see

**The cosmos.** Objects orbit their parent by link relation: agents at
the center, sub-objects (memory, todos) as satellites, shared
programs/peers/source files on outer type rings. Links render as
color-coded quadratic-Bezier arcs. Nodes drift on sin waves so the
scene feels alive.

**Activity heat.** Every object decays heat as `exp(-Δt / 30s)` from
`lastSeen`. Heat drives emissive intensity, halo opacity, and a scale
pulse. Any object touched by a recent Change lights up briefly.

**Top-bar agents widget.** Pill chips showing every local agent —
live/idle dot, name in mono font. Click a chip to jump to that agent's
inspector. Same name string you'd use in `peer_conversation_start({
display_name: ... })` when telling one agent to talk to another.

**Live event log** (bottom-right collapsed strip). SSE tail of
`~/.glon/changes/`. Every `.pb` file becomes one row per op. Click a
row to inspect the object it touched. List/map field writes render
their size (`tools = [38 items]`) instead of blank.

**Inspector** (right panel). Object metadata, fields, links, raw
content, change DAG. For agents it also has:

- **Stats**: model, turn count, tool calls, compactions, tools
  registered, a gradient **context-fill bar** showing how close to
  compaction.
- **Discord chat links** (was: Chat / Peer chats tabs): a single
  "💬 Chat with `<Name>` in Discord →" button that opens the agent's
  `#roster` forum thread, plus a list of active A2A conversation
  threads (each linking straight to the thread in the pair channel).
  The chat itself happens entirely in Discord — multi-human, native
  reply chains, lock-on-done.

**Tasks panel.** Daemon-level recurring tasks + reminders, each with
an enable/disable toggle.

**Peer planets.** Other glon hosts/agents discovered through the
shared Discord guild appear as their own planets in the cosmos; click
one to inspect trust level, agent UUID, and the Discord deep-link to
chat with them.

**Search** (top). Live highlight on type/name/id/scalar, plus
server-side block-text search.

**Time scrubber** (bottom). Filter to `createdAt ≤ slider` and replay
growth.

## How it works

```
~/.glon/changes/                  glonAstrolabe server (Node + Express)
├ <object-id>/                →   decodeChange → computeState
│ ├ <hex>.pb   (Change)            ↓
│ ├ <hex>.pb                       VizObject + agentStats + outLinks
│ └ …                              ↓
└ …                                /api/state, /api/objects/:id,
                                   /api/agents/:id/conversation,
                                   /api/discord/config (guild id),
                                   /api/peer-chat/* (read-only),
                                   /api/events (SSE)
                                   ↓
                                   three.js frontend
                                   ↓ (chat surfaces)
                                   discord.com/channels/<guild>/...
```

Read path has **no dependency on glon running** — it scans the disk
snapshot on demand and caches for 3 seconds. The SSE watcher
(`fs.watch` recursive on the changes dir) tails new `.pb` files as
they land.

**Chat lives in Discord.** Each agent has a `#roster` forum post for
human-to-agent messaging, and pair channels under `glon-a2a` for
agent-to-agent conversation threads. Astrolabe just builds deep links
into them — `/api/discord/config` returns the guild id (and roster
forum id) at boot, the frontend assembles
`https://discord.com/channels/<guild>/<thread>` URLs from each
object's stored ids. If `GLON_A2A_DISCORD_GUILD` isn't set, the
inspector shows a disabled "Discord A2A is not configured" tile.

Read-only mutation paths (the few that remain — peer trust changes,
task toggles) still proxy to the glon daemon's `/dispatch` endpoint.

### Server-side filters

- **Junk filter** — drops objects with no `typeKey` and agents with a
  truncated `system` field. Set `GLON_ASTROLABE_JUNK_FILTER=0` to
  disable.
- **Dedupe filter** — collapses identity-duplicate peers and agents,
  keeping the highest `changeCount`. Set `GLON_ASTROLABE_DEDUPE=0`.

## Run

```bash
npm install
npm run dev      # http://127.0.0.1:4173
```

The reader resolves `glon/proto.js`, `glon/dag/dag.js`, and
`glon/crypto.js` via `node_modules/glon → ../../glonFiggies/src`
(symlink). Make sure the [glon](https://github.com/Geep5/glon) checkout
exists at that relative path, or adjust the symlink.

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | bind host |
| `PORT` | `4173` | bind port |
| `GLON_DATA` | `~/.glon` | DAG root to read from |
| `GLON_DISPATCH_PORT` | `6430` | daemon dispatch port (used to build the URL) |
| `GLON_ASTROLABE_DEDUPE` | unset (on) | set to `0` to disable dedupe |
| `GLON_ASTROLABE_JUNK_FILTER` | unset (on) | set to `0` to disable junk filter |

```bash
GLON_DATA=~/.glon-other npm run dev               # different DAG root
HOST=0.0.0.0 PORT=8080 npm run dev                # bind elsewhere
GLON_ASTROLABE_DEDUPE=0 GLON_ASTROLABE_JUNK_FILTER=0 npm run dev   # raw mode
```

## Interactions

| input | effect |
|---|---|
| `drag` | orbit |
| `scroll` | zoom |
| `right drag` | pan |
| `click` a ball | select; inspector opens |
| `click` an agent ball or top-bar chip | inspector opens with the "Chat with `<Name>` in Discord →" button |
| `click` a conversation orb | inspector opens for that peer; the Discord link below the stats jumps straight to the relevant pair-channel thread |
| `dbl-click` a ball | focus camera + select |
| `click` an event row | select the object it touched |
| `Esc` | clear selection |
| legend type | click a type row to mute all objects of that type |
| search box | live highlight + backend search over block text |
| `?reset-layout` URL param | wipe `glonAstrolabe.*` localStorage and reload |
| time scrubber | filter to `createdAt ≤ slider-ms` |

## API

```
GET  /api/meta                                 { root, now }
GET  /api/state                                graph snapshot (objects, links, byType, timeline)
GET  /api/objects/:id                          detail + outLinks + inLinks + rawFields + contentPreview
GET  /api/objects/:id/changes                  full Change DAG
GET  /api/agents                               list of agent objects
GET  /api/agents/:id/conversation              classified blocks + registered tools
GET  /api/agents/:id/context                   { agentId, agentName, objectIds }
GET  /api/discord/config                       { guild_id, roster_forum_id, pair_category_id } — frontend builds Discord links from these
GET  /api/peer-chat/conversations              read-only list of A2A conversations (used to build per-agent Discord link lists)
GET  /api/peer-chat/messages?conversation_id=… messages in a conversation (read-only fallback)
GET  /api/wallet                               { pubkeys: [...] } from ~/.glon/wallet.json
GET  /api/search?q=…&limit=20                  free-text over metadata + agent block content
GET  /api/events                               SSE stream (replay last ~50, then live)
GET  /api/events/recent                        last ≤200 events as JSON
```

## Gotchas

1. **Hard-refresh after CSS / JS changes.** The HTML links `style.css`
   and `js/main.js` with a `?v=N` cache buster, but Chrome occasionally
   ignores it. `Cmd+Shift+R` is your friend.
2. **`?reset-layout` if panels are in a weird state.** Wipes every
   `glonAstrolabe.*` localStorage entry (panel positions, sizes,
   hidden state, expanded peer-chat conversations) and reloads on a
   clean URL.
3. **The reader is read-only.** Mutations (chat, resume, end) all go
   through `/dispatch` on the glon daemon. If the daemon's offline,
   those routes 503 but the cosmos view still works.
4. **`nohup` + `disown` for background daemons.** Bare `&` kills the
   child when the launching shell exits.

## Layout

```
glonAstrolabe/
├ server/
│ ├ index.ts          Express + static + SSE + API routes
│ ├ reader.ts         disk scan + computeState + dedupe/junk + context refs
│ ├ events.ts         fs.watch + op summarizer + SSE bus
│ └ daemon-client.ts  HTTP client for the daemon's /dispatch
├ public/
│ ├ index.html        shell + importmap + panels + agents widget
│ ├ style.css
│ └ js/
│   ├ main.js          scene, camera, controls, raycasting, agents widget
│   ├ cosmos.js        ball layout, drift, magnet, heat, halo, link tubes
│   ├ inspector.js     inspector DOM + Discord chat links + context bar
│   ├ livelog.js       SSE client + console row renderer
│   ├ spell-bar.js     panel-toggle keyboard shortcuts
│   ├ planet-styles.js procedural planet surfaces
│   ├ planet-forge.js  agent-driven render edits
│   ├ physics.js       rapier WASM init
│   └ colors.js        stable type palette + block colors
└ snapshots/           screenshots
```

No compile step on the frontend — `index.html` uses an importmap to
resolve `three` from `node_modules`.
