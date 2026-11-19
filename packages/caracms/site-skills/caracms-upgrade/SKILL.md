---
name: caracms-upgrade
description: Move a caracms site onto a newer caracms release — the steps in order (the version bump, pnpm's release-age rule, init refreshing the skills, validate, audit, the walk), and what each release asks of a site, newest first, from 0.9.0 on - what breaks, what to run, what shows in the editor, and what's worth adopting later. Use whenever a site's caracms version changes, before running `pnpm add caracms@…`, or when `astro dev` or `caracms validate` says the skills are behind.
---

# Moving a site onto a new caracms release

An upgrade is a version bump with a few checks. Most releases need nothing from the site;
the notes below say which ones do. A release can also bring features worth adopting
(slots, `caracms audit`): adopting is separate site work, done when it's scheduled, never
part of the bump.

**Read the notes from the new version, not this copy.** Until `init` runs, this file is
the old release's. After step 3 the new one is at
`node_modules/caracms/site-skills/caracms-upgrade/SKILL.md`: read every version between
the site's old one and the new one there before going on. To read them before installing,
`npm view caracms@<version>` names the version, and the package's tarball holds the same
file.

## The steps

1. **Find out what a push sets off.** The site's `CLAUDE.md` (or `AGENTS.md`) says; on a
   client site a push to `main` is usually a production deploy. Do the upgrade locally and
   push only once every check below passes.
2. **Set aside unrelated work.** Commit only what the upgrade changes; another edit in
   `.claude/skills/` (a skill that isn't caracms's) stays out of both commits.
3. **Bump.** `pnpm add caracms@<version>`, pinned exact (`"caracms": "0.13.0"`, no `^`):
   a site moves when someone moves it, not when an install runs.
   pnpm holds back a release younger than its `minimumReleaseAge` (a day by default).
   The site's `pnpm-workspace.yaml` lets caracms through by name, which covers every
   version:

   ```yaml
   minimumReleaseAgeExclude:
     - caracms
   ```

   A site whose list names caracms version by version (`caracms@0.8.3 || 0.9.0 || …`, which
   pnpm writes when it asks) gets that line replaced by the bare name. Other packages in
   the list stay as they are.
4. **Fix what the release breaks.** The notes below list it; `pnpm astro check` (or the
   site's typecheck) finds the type breaks. Then commit the bump and its fixes together:
   `caracms <version>`, with a line on what had to change if anything did.
5. **Refresh the skills.** `npx caracms init --write`, then commit what it wrote on its
   own: `caracms init: the skills from <version>`, so the skills' diff reads apart from
   the site's. init leaves a skill file someone edited alone and says so: carry the new
   release's changes into it by hand. "Nothing to copy" is normal when a release didn't
   touch the skills.
6. **Check.**
   - `npx caracms validate`: 0 errors. A warning that a file isn't in the editor's layout,
     or that an order names something gone, is fixed by `npx caracms validate --fix`
     (no values change); commit that alone. Content warnings (alt text, a link to a
     hidden page) predate the upgrade: leave them for the people editing.
   - `npx caracms audit` when the notes say audit changed. Lines the site already
     accepted are in its `docs/decisions.md`; a new line is either the release's doing
     (say so) or adopt work for later.
   - The site's build and its own tests.
7. **Walk the editor** on what the notes say shows: `astro dev`, `/admin`, and the pages
   the release touches. Restart `astro dev` after the bump, or the editor keeps the old
   code. Leave the content as it was (`git status` clean after the walk).
8. **Push** by the site's own rules (pull first), and check the deploy it sets off.

## What each release asks of a site

Newest first. **Breaks** must be fixed in step 4; **Run** is anything beyond the steps;
**Shows** is what to look at in the walk; **Adopt** is optional, for later; **Worth
knowing** is a change around the package (the cloud, a skill) that asks nothing of the
upgrade itself.

### 0.21.0

- **Breaks:** nothing. Nothing in content, on a public page or in the editor changes.
- **Run:** nothing.
- **Adopt:** on a Starlight site only. The docs kit now ships inside the package, at
  `node_modules/caracms/starlight-kit/`, and caracms-starlight copies it from there. A site
  that already has `src/starlight-kit/` keeps its copy and needs nothing; to take the
  package's (it adds `groupLabels` for naming the sidebar's groups), follow caracms-starlight
  → the copy step, and keep any changes the site made to its own copy.
- **Worth knowing:** the package's source is public, at `github.com/CaraCMS/caracms`, and its
  npm page links there; issues are open on that repo. The examples in the skills and the
  README use plain labels and `example.com` addresses now, which changes nothing on a site.

### 0.20.1

- **Breaks:** nothing. Nothing in content, on a public page or in the editor changes.
- **Run:** nothing.
- **Worth knowing:** `caracms audit` now renders each page through the site's own middleware,
  as its dev server does. A site whose pages read something a middleware puts in
  `Astro.locals` (every Starlight site: Starlight's sets `Astro.locals.t`) had every page fail
  with "couldn't be rendered" and nothing checked; its audit now checks them.
- **Worth knowing:** the audit's "Words no field holds" counts more as held, on every site: a
  page's title anywhere on its own page (a layout's `<h1>` outside the blocks), a document's
  title inside a link to that document (a nav, a sidebar, prev/next), and the words of a
  marked heading inside an in-page link to it (a table of contents). So a list that used to
  name every page title in a nav is shorter. On a Starlight site what's left of the chrome is
  Starlight's own fixed words (caracms-starlight → Other traps says how to read them).

### 0.20.0

- **Breaks:** nothing. Nothing in content or on a public page changes.
- **Run:** nothing.
- **Shows:** a shared block placed in a page's body (not a header or footer) now has
  clickable words in the editor's preview, as the header and footer do. The first click
  selects it as the page's block (moved and removed there, as before); a click on its words
  opens the shared block over the page, under "Changes here show on every page that uses
  it", and typing on the page edits it. As in a footer, an empty field now draws its empty
  element in the editor's preview (somewhere to click and type), which can add a little space
  there; the public page is unchanged. Separately, a click on a list item's rich text on the
  page now always puts the caret in that item's editor in the sidebar (it sometimes landed on
  the formatting bar's Bold button, and typing went nowhere).
- **Worth knowing:** nothing in the site's code is needed: the package's field components
  draw the marks. A block component that draws a field without one (plain markup, not
  `<Text>`, `<Lockup>` and the rest, or `<Block field>`) stays unclickable there, as it is
  on its own preview; `caracms audit` reports it, as before.

### 0.19.1

- **Breaks:** nothing. Nothing in content, on a public page or in the editor changes.
- **Run:** nothing.
- **Worth knowing:** `caracms media push` (and the other media commands that talk to the
  site's own bucket) no longer gets a 403 from S3 for a file whose name holds `(`, `)`,
  `!`, `'` or `*`, such as `photo (1).jpg`. A port that worked round it in its own script
  can drop the workaround.

### 0.19.0

- **Breaks:** nothing. Nothing in content or on a public page changes.
- **Run:** `npx caracms schemas` (the Site Settings schema gained `pageFolders`).
- **Shows:** Arrange pages… has New folder beside New group. Folders show in the Pages
  sidebar with their rows under them, and a folder can be put in the addresses (made a
  group) and taken out again from its row on the Arrange screen.
- **Adopt:** folders, on any site whose nav groups pages its addresses don't (a
  "Company" menu over /about and /contact): file those pages in a folder of the same name,
  in the editor or by hand (`caracms-content` → Site Settings).
- **Worth knowing:** a site moved back below 0.19.0 must remove `pageFolders` from
  `content/site-settings.json` first (and the `(<id>)` tokens from `pageOrder`): the older
  `caracms validate` refuses the unknown key.

### 0.18.0

- **Breaks:** nothing. Nothing in content or on a public page changes.
- **Run:** nothing.
- **Shows:** only on a site using CaraCMS Cloud with its spam check switched on (a
  CaraCMS admin setting, off by default). A submission the cloud flags shows "Possibly
  spam" in the inbox list, and its sheet says its email wasn't sent, with **Not spam,
  send it**, which sends it. Separately, on any version, a form email that bounced now
  shows on its submission as not delivered, with the reason.
- **Worth knowing:** folder and bucket submission stores never flag spam. The button
  needs the cloud's `/v1/submissions/not-spam` (live since 2026-11-12); older caracms
  versions show a flagged submission's email as held, with no way to send it, so move a
  site to this release before its spam check is switched on.

### 0.17.1

- **Breaks:** nothing. Only the skills changed; no code did.
- **Worth knowing:** `caracms-tina` now describes a port done in a sitting or two on a
  site nobody is editing: the script converts once, the content is then the site's, and a
  new section 12 says how to re-model it for the editor (order numbers, collections only
  one block reads, featured toggles, icon dropdowns). `caracms-blocks` → Where content
  lives gained the rules it lacked: choose and order where it's shown, a hand order over
  an order field, no words tied to another document's title, an icon is an image field,
  `help` says the limits, the preview shows what the page hides.
- **Adopt:** on a site already ported, read those rules against its collections; a port
  that copied the old CMS's shape one to one usually breaks a few.

### 0.17.0

- **Breaks:** nothing in content or on a public page. A select with no placeholder of its
  own still starts on the form's "Choose…".
- **Run:** `npx caracms schemas`, so `site-settings.schema.json` gains the new Forms words
  (`astro dev` also rewrites it when it starts). On a site part-way through a port from
  Tina: after step 5, copy the new `.claude/skills/caracms-tina/tina-to-caracms.mjs` over
  the site's `scripts/` copy and move its adapt table across. The scaffold now carries a
  template select's `source` and `placeholder` and a field's `watermark` (as `suffix`), and
  leaves a field type caracms doesn't have out with a note that names `rows`.
- **Shows:** Site Settings › Forms gives every select a "Before a choice is made" word
  (blank means the form's "Choose…"), and in the preview a click on a select's first
  choice opens that word, not the form's. An inbox submission opened by its address no
  longer logs a hydration error: the time zone's name on a submission is now the server's
  wording, so it may read "Irish Time" where the browser used to say "Ireland Time".
- **Adopt:** forms gained two things (caracms-blocks → Forms). A select can list a
  collection: `source: { collection: 'jobs', where: 'live' }`, after any fixed `options`,
  checked against the deployed content at each submission. A `type: 'rows'` field holds
  repeating rows of declared `columns` (`select`, `number`, `text`), up to `max`, and one
  column's choices can follow another's pick (`from: { column, field, else }`). The email
  and the inbox show a row a line ("Paint — 2.5 L"); a site's own form markup reads the
  words, each select's `choices` and a narrowed column's `allowed` from `cms.formWords`.
  Smaller: a select takes `placeholder`, a text or tel field takes `suffix`. A site that
  kept a field out of caracms's forms for want of these (an order's products, a job list)
  can now declare it.
- **Worth knowing:** on CaraCMS Cloud a rows submission needs the cloud's 2026-11-11
  deploy (a field's value may be a list of up to 50 rows of up to 20 text columns); it is
  live, and submissions that are all text are unchanged. `caracms audit` no longer lists a
  pageless collection as having one reader when a form's `source` reads it.

### 0.16.0

- **Breaks:** nothing for a site already on caracms. `caracms media push`'s JSON gains a
  `left` count: `{ copied, skipped, left, failed }`. A key not of the upload shape
  (`uploads/<12 hex>/<name>.<ext>`) is now counted in `left` and named on its own line
  instead of failing the run, and the exit code is 0 when nothing failed. A script that
  parses the output reads `failed` as before.
- **Run:** only on a site part-way through a port from Tina. After step 5, copy the new
  `.claude/skills/caracms-tina/tina-to-caracms.mjs` over the site's `scripts/` copy and
  move its adapt table across (the table gained `shared`, `formWords`, `redirects` and
  `formsConfig`; their defaults are the template's). Images and files now take new keys by
  their bytes, so `scripts/tina-media-sizes.json` gives way to `scripts/tina-media-keys.json`:
  the first run with the bucket's `S3_*` settings writes it (commit it, and delete the old
  sizes file). Run once with `S3_*` before relying on an offline run, so each entry
  records its ETag and a file replaced in Tina is noticed. The caracms-tina skill's
  sections 2 and 7 say how.
- **Worth knowing:** CaraCMS Cloud sends no sign-in link until the site's domains are set on
  its page in app.caracms.com (`wrong_address`), nor one to an address not among them. Set
  every address the editor is opened at, branch environments included (caracms-hosting,
  section 3 step 1 and section 4).

### 0.15.0

- **Breaks:** nothing. With the new `vivid` switch off (the default) every page is the same,
  byte for byte.
- **Adopt:** a site with Vivid, the feedback widget, on it sets `vivid: true` in
  `defineSite({ … })`. Every field drawn through `<Text>`, `<RichText>`, `<Lockup>`,
  `<Buttons>`, `<Link>`, `<Media>` or `<Block field>` then carries, on public pages only,
  `data-vivid-field` (`pages/about#blocks.2.heading`, `settings#contact.phone`,
  `shared/footer#block.address`) and `data-vivid-edit` (the document's absolute `/admin`
  address), so a pin names the field and links to it in the editor (README → Vivid feedback
  attributes). The build takes the address from Astro's `site`, else `SITE_URL`, else
  Railway's domain, and warns when it has none. Fields a block draws by hand
  (`{block.heading}` straight into the markup) aren't tagged: move them onto the package's
  components. The route must read its document with `readDocument` (the starter's
  `[...path].astro` does); a document built in code, like the 404's, has its own fields
  untagged.
- **Shows:** nothing in the editor; the preview never carries these attributes. Check one
  built page's HTML for `data-vivid-field`.

### 0.14.0

- **Breaks:** nothing on screen. Every `<h2>` and `<h3>` drawn by `<RichText>` now has an
  `id`: GitHub's slug of its text, made unique across the page with `-1`, `-2`… in page
  order. Stored content is unchanged (ids are never saved). If the site's own tests compare
  rich-text HTML exactly, add the `id` to the expected markup.
- **Shows:** in the editor's block list, a block whose words are all in rich text or in a
  list now shows them instead of "Nothing in it yet" (a block that opens with a select shows
  its choice first: "Tip · …"). Rich-text list items show their words instead of "Empty",
  and a row with no text field of its own (a table row of cells) is named by its first item.
- **Adopt:** `pageHeadings(site, document, { collection, read })` and `headingId(text, seen)`
  from `caracms/content` give a page's headings for a table of contents and matching anchors
  (README → Rich text: heading ids). `media({ altFrom: 'capture' })` names a text field beside
  an image: a picture placed with no alt starts with that field's words. A new site skill,
  `caracms-starlight`, is copied by step 5; it's only for Astro Starlight docs sites.

### 0.13.3

- **Breaks:** nothing. Nothing to change; restart `astro dev` after upgrading.
- **Shows:** the editor works in `astro dev` on a site with `@astrojs/react`. Before
  0.13.3 the sidebar drew but the preview pane never appeared, and /admin's console said
  `$RefreshSig$ is not defined`: React's Fast Refresh instrumented the editor, and /admin
  never loaded its preamble. /admin now loads the site's before-hydration scripts first,
  as an island page does. The built site (`caracms start`) was never affected.

### 0.13.2

- **Breaks:** nothing in the site. `caracms audit` now exits 1 when any document couldn't
  be rendered (those weren't checked), and its last line says how many instead of "quiet";
  a script that runs it sees the failure.
- **Run:** a site with React, Preact, Svelte, Vue or Solid islands re-runs `caracms audit`
  after upgrading. Before 0.13.2 every page holding a framework component failed with
  "Unable to render X", and the audit still said quiet; it now renders them with the
  site's own renderers, so expect findings it never showed. An island's server-rendered
  HTML counts like any other markup: a field it draws needs `data-cms-field` on its
  element (hand the island the marker as a prop, from `cms.preview`), and words of its own
  are words no field holds. A slot block (header, footer) whose component's outermost
  element is an island rather than `<Block cms={cms}>` is now reported by name: wrap the
  island in `<Block cms={cms} as="header">` (or whatever element it should be). Without
  that root nothing in the editor's preview opens the shared block, and its links' words
  count as no field's.

### 0.13.1

- **Breaks:** nothing. Adds this skill, `caracms-upgrade`: step 5 copies it, and init lists
  it in the site's `CLAUDE.md`. A site whose `minimumReleaseAgeExclude` names caracms
  version by version moves to the bare name (step 3).

### 0.13.0

- **Breaks:** nothing.
- **Shows:** the editor's restyle (warmer neutrals, a dark bar, a fixed green Publish).
  Site Settings' brand colour is a row of six presets (Navy, Slate, Petrol, Plum, Walnut,
  Ink) and paints the editor's main buttons and switches. A site whose stored colour isn't
  a preset keeps it, shown as "Current"; nothing migrates.

### 0.12.0

- **Breaks:** nothing.
- **Shows:** Replace… on an image in the library: every page using it takes the new
  picture.

### 0.11.2

- **Breaks:** nothing. The skills changed (what the first two moves onto 0.11 taught):
  step 5 copies them.

### 0.11.1

- **Breaks:** nothing. Fixes: bare boolean attributes, audit's own media (it draws
  images without the site's media set up), and links a frame builds in code.

### 0.11.0

- **Breaks:** nothing. With no words set in Site Settings, every form reads as it did.
- **Run:** `validate` may say `content/site-settings.json` isn't in the editor's layout:
  `validate --fix`, its own commit.
- **Shows:** Site Settings › Forms holds each form's words; a block with states gets a
  switch over the preview.
- **Adopt:** `order: 'manual'` on a collection kept in a hand order (in place of a number
  on each entry); `states` on a block whose look changes (a form's sent state); a form in
  the site's own markup reads its words with `cms.formWords(form)`; `caracms audit` lists
  every word no field holds. On the first two sites audit's first run listed well over a
  hundred lines: that's a scheduled job (`caracms-adopt` → the editor walk), not part of
  the bump.

### 0.10.0 (edit in context)

- **Breaks:**
  - A page or fields-collection field named `frame`: the name is now a page's pick of
    header and footer. Rename the field (and its content) before upgrading.
  - A block context built by hand is a type error: `BlockContext.settings` and `.of` are
    required. Use the page's `PageProps.cms`; a code route outside the page component (a
    design-system page) uses `siteSettingsContext(site, Astro.locals)` from
    `caracms/content`.
- **Shows:** a click on what the page shows opens where it lives; another document's
  element (a shared block, Site Settings) opens that document over the page. The preview
  is the page with scripts off: everything showing, nothing moving.
- **Adopt:** the header and footer as Shared slot blocks (`slot: 'header' | 'footer'`,
  drawn by `<Slot>`); marking sources (`cms.settings`, `cms.of(entry)`,
  `<Block cms field>`) so a click opens the right document (`caracms-blocks`).

### 0.9.1

- **Breaks:** nothing. init leaves a set-up site's deleted starter components alone.

### 0.9.0

- **Breaks:** the skills move from links to copies. **Run** `npx caracms init --write`
  before pushing: it copies the skills into `.claude/skills/`, removes pnpm's
  `pnpm-caracms-*` links and takes `permissions: caracms: skills: true` out of
  `pnpm-workspace.yaml`. Left in, that approval fails the host's install
  (`ERR_PNPM_NO_AGENT_SKILLS_DIR`).

Releases before 0.9.0 aren't covered: no site in use is on one.
