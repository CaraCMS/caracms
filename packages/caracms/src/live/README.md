# Live mode (`src/live/`)

M4's server side: git, Redis and the mode
(M4 Decisions 1–3, 5–8, 10, 12, 14, 16, 17). Phase 1 built this folder with no UI; Phase 2's
live drafts store, sweep, locks and status route, and Phase 3's sign-in, sit on top.

| File | What |
|---|---|
| `mode.ts` | `readMode(env, production)` → `local`, `live` (with `LiveSettings`) or `unconfigured` (`missing`, `problems`); `unconfiguredMessage()` for the 503 |
| `runtime.ts` | `liveRuntime(site, settings)`: one per process, lazy. With a cloud key it reads the repo from the cloud and takes its first token before anything else, so a refusal stops the start (the guard answers 503 with the cloud's sentence; the next request tries again). `createLiveRuntime({...})` for tests (inject backend, Redis, clock). `CARACMS_GITHUB=memory`: a MemoryBackend seeded from disk (`siteFiles`), refused in production |
| `git.ts` | `LiveGit`: the `drafts` copy (`files()`, `read()`, `contentSource()`), `commitDrafts()`, `check()`, `publish()` and its `commitPending` hook, `waiting()`, `publishStatus()`, `history()`, `tryAgain()`. M5a: a draft entry with `text` null removes the file; "Contact (deleted)" in the headlines; `mainHas`, `changeOf` (new, deleted or changed), `titleFor`; `matchesMain` (an undo back to what's live isn't waiting: main's text kept for files this server's commits changed) |
| `timings.ts` | `LiveTimings` and `DEFAULT_TIMINGS`: every timing, Phase 2's sweep and lock ones included |
| `merge.ts` | `mergeFile({ base, draft, other })`: the per-key three-way merge, pure and byte-preserving |
| `messages.ts` | The commit-message contract (`draftMessage`, `mergeMessage`, `publishMessage`, `parseMessage`), `Person`, `displayName` |
| `status.ts` | Pure: `waitingFromCommits()`, `publishState()`, `PublishRecord` |
| `redis.ts` | `RedisClient`; `connectRedis(url)` (ioredis with M1 → R2's retry and idle close) and `memoryRedis()` (the stand-in, with `calls` and `flush()`). Redis diet: `batch()`, a pipeline sent again whole only when every command in it is safe to send twice |
| `status-cache.ts` | Redis diet. `StatusCache` (one per process, `git.statusCache`): what the status poll reads, by Redis key, re-read once 30 s old, refreshes single-flight; the modules that write Redis tell it what landed (`string`, `hash`, `add`, `drop`, `landed`) |
| `notices.ts` | Redis diet. `Notices`: "published as it stood" notices and dismissed "draft kept" ones, written through the status cache |
| `backend.ts` | `GitBackend`; `GitHubBackend`, `MemoryBackend` (test helpers: `seed`, `push`, `file`, `deployments`, `beforeRequest`); `StaleHeadError` |
| `branches.ts` | `Branch` (a role: `main` or `drafts`), `BranchNames` (the refs behind them), `DEFAULT_BRANCHES`. `CARACMS_MAIN_BRANCH` and `CARACMS_DRAFTS_BRANCH` (read by `mode.ts`, M9 Decision 6) name the branch Publish commits to and the one autosaves land on; unset, `main` and `drafts`. They're set together or not at all: one alone is a problem, so the mode is unconfigured (`/admin` answers 503 saying both must be set; the public site still serves). Only the backends turn a role into a ref name, so with both set a branch called `main` is never read or moved. `MemoryBackend.refs` is keyed by name |
| `github.ts` | The App's JWT, the installation token (one repo, refreshed early), `Tracker` (request counts). A third credential, `cloud`: the token from CaraCMS Cloud, refreshed the same way; its refusals are an access problem of kind `cloud` |
| `cloud.ts` | CaraCMS Cloud (`CARACMS_CLOUD_KEY`; caracms-cloud M2): `DEFAULT_CLOUD_URL`, `fetchCloudSettings()` (the repo and the media; M3), `loadCloudSettings()` / `heldCloudSettings()` (one fetch per process, shared by the media and the runtime), `cloudSettings()` (the repo, at start), `cloudCall()` (one call, for the cloud bucket too), `cloudToken()`, `CloudRefusal` (the cloud's `error`, `message`, `installUrl`), and `cloudUnavailable()`, the sign-in guard's 503 for a refusal at start |
| `webhook.ts` | `handleGithubWebhook()`, behind `POST /_caracms/github` (`../editor/routes/github.ts`) |
| `autosaves.ts` | Phase 2. Autosaves in Redis (`caracms:autosave:<file>`, a week; stored compare-and-set, ordered per tab by `X-Caracms-Seq`), the session's last commit (the merge's ancestor) and who last changed a document (Decision 11; no expiry, and `known: false` when neither Redis nor git can say). M5a: a new document's autosave carries `created: { over }` (its ancestor until committed), a deletion is a "gone" autosave (`text` and `document` null, `gone: { title }`) |
| `locks.ts` | Phase 2. `Locks`: taken by the first write, heartbeat on the poll (Redis diet: only when `needsBeat`), lapse only once committed, releasing, Edit here; presence, each record holding for twice its tab's poll interval plus 3 s |
| `sweep.ts` | Phase 2. `Sweep`: one commit per tick for everything ready; ticks only while something is pending (no Redis call otherwise); `commitAll` fills `git.commitPending` |
| `drafts-store.ts` | Phase 2. The live `DraftsStore`: the copy with autosaves on top (a gone one leaves the file out); `write` takes the lock and stores the autosave. M5a Phase 3: `create` (the lock, then the new document as an autosave) and `delete` (the lock, then a gone autosave, the lock released to drop once committed), with `editor/server/create.ts`'s rules. M5a: any kind of document; Site Settings' autosave is marked `sweepAtOnce` (the sweep commits it on its next tick, no idle wait); `source()` is the copy with every autosave on top (a preview's reads) |
| `editor.ts` | Phase 2. `createLiveEditor(runtime)` / `liveEditor(site, settings)`: the store, sweep and locks, and the handlers for write, status, lock, publish, history, try-again, notice |
| `locals.ts` | The hand-off from the sign-in guard to the routes: `setPerson` / `personOf` on Astro's `locals` |
| `auth/` | Phase 3. Sign-in: the whitelist, the session cookie, links and rate limits, email, the guard and the `/admin/login` pages (map: `auth/index.ts`'s header) |

Rules that hold everywhere here:

- **Two servers run at once during a deploy.** Ref moves are compare-and-swap; after any
  failed move both heads are re-read and the copy refreshed before a retry. The newest
  publish lives in Redis (`caracms:publish:last`), not in memory.
- **Status reads never ask GitHub**, except `check()`'s once-a-minute ref read (started,
  never awaited: the poll answers with what's known) and the deployment reads while a
  publish is in flight (at most every 10 s). Every GitHub request times out after 20 s.
- **The startup check runs in `createLiveEditor`**, once `commitPending` is filled, so a
  merge from `main` at startup commits pending autosaves first (Decision 8).
- **Nothing polls Redis.** The client connects on the first command and closes after 30 s idle.
- **Paths:** the copy and every message use paths relative to the site's folder
  (`content/pages/index.json`); `repoPath` is joined only at the git boundary.
