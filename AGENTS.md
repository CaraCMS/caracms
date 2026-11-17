## Development

A pnpm workspace: the package in `packages/caracms`, `npm create caracms` in
`packages/create-caracms`, and the starter in `starter/` (a small site about CaraCMS itself),
which uses the package from the workspace. The repo is public, at `CaraCMS/caracms`: every
tracked file is read by strangers, so no client names, no real people, no made-up business
names (plain labels: "the site", `site-a`), and example addresses on `example.com`,
`example.org` or a `.test` host.

The starter's dev server runs on port 4326 (strict). When starting it, use background
mode, from `starter/`:

```
pnpm astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

For the preview browser, `.claude/launch.json` has these configurations:
- `starter`: the dev server on 4326, with the editor at `/admin`.
- `starter (live, memory)`: the same in live mode on the in-memory GitHub (`CARACMS_GITHUB=memory`), signed in as `walker@example.com` with the link the server logs (`second@example.com` is allowed too, for a second person in another browser). Edits and Publish stay in memory; the disk is untouched.
- `starter (live, memory media)`: the same, also with `CARACMS_MEDIA=memory`, so uploads in a walk never reach a real bucket (pictures already in a bucket don't show in it).
- `starter (built)`: `pnpm build`, then the production server on 4330, started with `caracms start` so requests go through its gate (runs-anywhere Decision 17). The client IP comes from the socket unless `CARACMS_CLIENT_IP_HEADER` says otherwise (set it to an empty value to see `caracms start` refuse to start). A built server is always in live mode (M4): without a GitHub credential (`CARACMS_GITHUB_TOKEN`, or the App's variables) and the rest, `/admin` answers 503 with a sentence naming what's missing, and the public site still works.
- `mockups`: `packages/caracms/test/mockups/` served on 4328: the mockups the visual tests compare against. A new mockup is drawn in `notes/mockups/` (private, see Planning) and copied here when a visual test is written against it (for example `/m2-editor.html#home`).

Only one thing can hold 4326, so stop a background dev server before starting the `starter` preview.

**Which tests to run when.** Timings measured 2026-11-10 on Rich's M1 Air.
- **After every phase** (builders): `pnpm check` (about 40 s), `pnpm --filter caracms test:unit`
  (about 2½ minutes), and only the browser files for the area the phase touched, e.g.
  `node --test --experimental-strip-types test/media-*.browser.test.ts` from
  `packages/caracms`. Not the whole browser suite: it's about 9 minutes, and a phase's
  change rarely reaches the rest.
- **Once, at the end** (the orchestrator's test pass): the slow tests the change needs, picked
  from the diff by `pnpm --filter caracms test:pick <base> --run` from the repo root (`<base>`: the
  commit before the run's first; without `--run` it only prints the picks, each with its reason,
  and what it skipped). In one breath: each changed folder picks its area's browser files;
  touching the editor's core adds one broad browser file per main screen; any change to how the
  editor looks (`.css`, `*-css.ts`, `.tsx` under `src/editor/`) runs the whole visual pass; the
  starter's tests run whenever `src/` or `starter/` changed. An edit to the pinned demo
  (`test/fixtures/demo-content/`, or an existing file in `demo-site/`) runs everything, since
  every browser test runs on it. The map and the rules are at the top of `test/pick.ts`.
  - Why not the whole browser suite each time: in a month of test passes (Oct–Nov 2026) it
    caught one product bug outside its run's area. The visual pass is what catches one screen's
    change showing in another (a new button in an older mockup's state), so it still runs
    whenever the look changes.
  - **Keeping the map current.** A new area adds its row to `test/pick.ts` in the same commit.
    Forgetting fails safe: a browser or visual file in no row always runs, and a path under
    `src/editor/` or `src/components/` in no row counts as core; the picker names it, so add
    the row then. Setup only a few tests use goes in a helper of its own, not `dev-site.ts` or
    `live-site.ts`: a change to those picks nearly every file.
  - The full suites: `pnpm --filter caracms test:browser` (`test/*.browser.test.ts`, two files
    at a time, about 9 minutes), `pnpm --filter caracms test:visual` (`test/*.visual.test.ts`,
    three at a time, about 7 minutes: every mockup state beside the editor, and the chrome's
    contrast, side-rail, motion and focus sweeps with both sample accents), and the starter's
    `pnpm --filter caracms-starter test` (about 40 s; it builds its own copy of the demo, so no
    `pnpm build` first, and its wraps check runs in Chromium).
  A visual phase may run `node --experimental-strip-types test/mockup-diff.ts <state…>` for its own states.
- **The full run** (all three full suites): before a minor or major npm publish, or when Rich
  asks for one. Before every publish, also `pnpm --filter caracms test:release`
  (`test/*.release.test.ts`, a few minutes): the packed tarball installed into a plain site, and
  `look-same`, the adopt skill's look-the-same script, run end to end.
  - **A patch publish** (0.x.y → 0.x.y+1, a fix) runs `test:pick` from the last published
    version's commit, plus `test:release`, not the full run. The last published version's commit
    is the second line of `git log -G'"version":' --oneline -- packages/caracms/package.json` once
    the new version commit is in. This repo's history starts at its first public commit, so the
    first release after it has no earlier version commit to pick from: that one is a full run. A
    fix rarely reaches past its own area, and what a publish can
    break on its own (the packed package in a plain site) is what `test:release` covers.
- `pnpm --filter caracms test` runs unit, browser and visual in turn.
- **Two browser files at a time is the ceiling on this Mac.** Four at a time (tried
  2026-11-10) made each test about twice as slow, saved nothing overall, and timed one out.

The browser and visual tests, and the starter's render, build and wraps tests, run on
`packages/caracms/test/fixtures/demo-content/`, a pinned copy of the demo's content,
never `starter/content` (when the demo deployed from here, a Publish from its editor
changed that: on 2026-10-15 one left tests waiting out 30 s clicks on pages that were
gone or already there). A test that needs new content adds it to the fixture. The
starter's round-trip test is the exception: it reads the starter's own files, since
whatever is published must round-trip.

## Deploying

**Pushing deploys nothing.** The package ships by publishing to npm. The repo is
`CaraCMS/caracms`, public.

**Every release adds its entry to the upgrade notes** (`packages/caracms/site-skills/caracms-upgrade/SKILL.md` → What each release asks of a site), in the version commit: what breaks, anything to run, what shows in the editor, what's worth adopting. "Breaks: nothing" is an entry too. A site's agent reads these from the installed package when it moves the site, so a release with no entry leaves every site to work out the breaks alone.

The starter's local dev reads `starter/.env` (git-ignored) if there is one. With a media
bucket and imgproxy set there, an upload from local dev goes to that bucket and is permanent.

Local live mode never points at a real repo. Tests and local walks use the in-memory GitHub
(`CARACMS_GITHUB=memory`).

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)

## Planning

caracms is planned with the milestone method. The planning notes (the product spec, the milestones, the lasting decisions) are private and not in this repo; locally they sit in `notes/`, which this repo ignores and which is a git repo of its own with its own commits and pushes. Code comments cite a feature's name and a decision number ("runs-anywhere Decision 17"), never a path under `notes/`. A clone of this repo has no `notes/`, and nothing in the package or its tests may read from it. Todoist project: **CaraCMS**.
