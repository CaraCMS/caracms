---
name: caracms-adopt
description: Bring an existing Astro site onto caracms — run `caracms init`, then convert the site's pages to caracms documents one at a time (its layout into the page component, its sections into blocks, its content collections into caracms collections, its settings into Site Settings), move its images with `caracms media import`, and prove visitors' pages look the same with the look-same script. Use when adding caracms to a site, or converting a page, collection or the header and footer of one.
---

# Bringing an existing Astro site onto caracms

**The bar: visitors' pages look the same.** Moving to caracms changes what editors can do,
not what visitors see. Every converted page is checked against the site as it was, with
the look-same script below.

Read `caracms-blocks` for how blocks, collections and the page component work, and
`caracms-content` for the content files. This skill is the order to do things in.

Commands run from the site's root: `npx caracms …`, or `pnpm caracms …` in a pnpm site.

## 1. Add the plumbing: `caracms init`

Start from a clean git checkout (untracked files are fine). The order is:

1. **Install caracms**, pinned, if `package.json` has none yet: `npm install caracms --save-exact`
   (or `pnpm add caracms --save-exact`).
2. **Commit the install** (`package.json` and the lockfile). `init --write` refuses while
   tracked files have uncommitted changes, so that its own change is one diff to review.
3. **`npx caracms init --cloud`** (or `--self-hosted`), the dry run (below), and read it.
   The flag is the site's mode, where its services come from: choosing it is
   `caracms-hosting` → section 1. Always pass it: run without a terminal, `init` won't
   pick a mode, and on a new site it writes nothing and exits 1.
4. **`npx caracms init --cloud --write`** (or `--self-hosted --write`).
5. **Install again** (`npm install` / `pnpm install`): `init` adds dependencies to
   `package.json`.

**`npx caracms init --cloud`** (or `--self-hosted`) without `--write` is a dry run: it
writes nothing and prints

- one line per file: `add` (a new file), `edit` (an existing one), `remove` / `unlink` (a
  skill file or link in `.claude/skills/` that goes);
- a diff of each;
- `Already done: …` on a site partly set up;
- `Notes:`, things it can't do itself, with the lines to add by hand (an `astro.config` it
  can't parse, a `tsconfig.json` it can't follow, a `.railway/railway.ts` the site already
  has, an existing `/health` route);
- what to run next.

If something is in the way it prints `caracms init: N things are in the way, so nothing
was planned:` with each problem and what to do, and exits 1. Fix them all and run it
again. The blockers: a `content/` folder holding files that aren't caracms's; a route or
`public/` folder at `/admin`, `/_caracms` or `/files`; the site's own `/sitemap.xml` or
`/robots.txt` route (caracms serves both); a route that already catches every top-level
address (`src/pages/[...slug].astro`); an adapter other than `@astrojs/node`, or the Node
adapter in middleware mode; an Astro outside caracms's range, or none; a Tina site
(`tinacms` in its dependencies, or tracked files under `tina/`: those come in through a
port, not `init`; an untracked leftover `tina/__generated__/` is only a note). `init --write` also refuses with uncommitted changes
to tracked files: usually the install of step 1, not yet committed.

Read the diff. Then **`npx caracms init --cloud --write`** (or `--self-hosted --write`),
install again (`npm install` / `pnpm install`), and commit that as one change.

caracms's skills are copied into `.claude/skills/` by `init`, as real files committed with
the site, so they work on a fresh clone with nothing installed. pnpm doesn't ask to approve
them (since 0.9.0 the package keeps them where pnpm doesn't look). A site that approved
0.8's has `permissions: caracms: skills: true` in `pnpm-workspace.yaml`, which fails an
install that runs before the repo is copied in (Railway's, `ERR_PNPM_NO_AGENT_SKILLS_DIR`):
`init --write` takes it out.

`init` added:

- `caracms.config.ts`: a `pages` collection at `/` (nested), one `text` block, no text
  styles, and `services: 'cloud'` (or `'self-hosted'`), the mode;
- `src/components/caracms/Page.astro` (the page component) and `TextBlock.astro`;
- `src/pages/[...path].astro`, the one catch-all, which serves every document with an
  address (the pages today; a collection added later needs no route of its own, section
  6) through `addressedDocuments` from `caracms/content`, and `src/pages/health.ts`;
- `content/site-settings.json` (its `brand.name` is the package name title-cased: correct
  it), and `schemas/`;
- `astro.config` edits: the Node adapter (standalone), `integrations: [caracms(site)]`,
  `devToolbar: { enabled: false }`;
- `package.json`: `@astrojs/node`, `"start": "caracms start"`;
  `.gitignore`: `.caracms/`; the tsconfig's `allowImportingTsExtensions`;
- the skills, copied into `.claude/skills/` with a stamp (`.caracms.json`) of what it copied, and a block in `CLAUDE.md`;
- with `--railway` only, `.railway/railway.ts` (when the site had none) and `railway`
  (dev). Without it, `init` prints the variables any host needs instead. Where and how
  the site runs (Railway, Render, Fly, a VPS) is `caracms-hosting` → section 2.

Then `astro build`: every existing page must still build. The pages stay prerendered, but
the output moves to `dist/client/` and `dist/server/`, and `npm start` is now
`caracms start` (`PORT`, default 8080). Anything in the site that reads `dist/` directly
(its own built-site checks, a script) needs the new paths: the pages are in
`dist/client/`.

Re-run `init` after updating caracms: it reads the mode from the config, refreshes the
skills (leaving any file edited here alone, with a note), the CLAUDE.md block and the schemas. On a set-up site with nothing
to do it says
`caracms init: nothing to do. caracms is set up here.`

## 2. Set up the comparison before changing a page

Keep the site as it was running, to compare against: a git worktree at the commit before
`init`, built and served the way the site served it.

```sh
git worktree add ../<site>-baseline <commit before init>
```

Install and build there and serve it on its own port. The new site is `astro dev`
(give it a port of its own: `astro dev --port <port>`), or a build served with
`PORT=<port> npm start`. For look-same's HTML diff both must be builds (section 9).

**Run the site's own tests now**, before any page moves, and note what passes. Tests that
read the old routes (`src/pages/about.astro`), the old collection files (YAML, Markdown)
or `dist/` will break as pages move. When they do, change where they read (the documents
are `content/pages/<path>.json` and `content/<collection>/<slug>.json`, the built pages
`dist/client/`), not what they check. A check that a page's own CSS isn't on another page
is the exception (section 4).

**Images need credentials** in the site's `.env` (never committed). On CaraCMS Cloud
that's `CARACMS_CLOUD_KEY` alone: a key labelled for this laptop, made in
app.caracms.com (`caracms-hosting` → section 1); it shows, imports and uploads images,
and `astro dev` still edits the files on disk. Self-hosted, it's the media
variables: `CARACMS_MEDIA_URL` (imgproxy's origin), `IMGPROXY_KEY`, `IMGPROXY_SALT` and
`S3_BUCKET` to show images, plus `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID` and
`S3_SECRET_ACCESS_KEY` to import and upload them. Without them `astro dev` draws a
caracms image as nothing, and `astro build` stops with a sentence naming what's missing.
If they aren't there, say so; don't invent values.

## 3. The page component

**Reuse the site's own layout.** `src/components/caracms/Page.astro` renders the layout
the old routes used (`src/layouts/…`), with `<Head>` in its head and `<Blocks>` where the
page's content went (see `caracms-blocks` → The page component). Give the layout what it
needs to stay usable by the code routes too: its own `<title>` and description only when
no `<Head>` is passed (a slot or an optional prop), so a document page has one of each.
Its markup, classes, CSS imports and scripts stay as they are. Set `<html data-preview>`
from `preview`.

**Keep the old title format.** `<Head>` titles a page `<document title> · <brand name>`.
If the old titles used another separator (`About | CaraCMS`), set the config's
`titleSeparator: ' | '` (spaces included; see `caracms-blocks` → The page component), not a
Site Settings value: the format is design. Code routes that build their own `<title>` use
`settings.seo.titleSeparator` and `settings.brand.name` from `siteSettings` (section 7), so
every title matches. Check each page's `<title>` line in look-same's HTML diff (section 9).

How `<Head>` chooses a title:

1. the page's own `seo.title`, exactly as written;
2. otherwise, on the home page only, Site Settings' `seo.title`, then the brand's name,
   with no separator (the document's `title` only when both are empty);
3. otherwise `<document title><titleSeparator><brand name>`.

So a page whose old title was `<page> | <brand>` drops its `seo.title` and lets step 3
build it (give the document the old `<page>` part as its `title`). A home title in another
form, such as `<brand> | <tagline>`, goes in the home page's own `seo.title`
(`content/pages/index.json`), not Site Settings'. That way the home page's title sits with
the home page, where an editor changing it will look, and it wins whatever Site Settings
holds.

If the old site showed one site-wide title on every page without its own (a Tina template
does), set the config's `titleFallback: 'site'` beside `titleSeparator`: step 2 then holds
on every page, not only the home page (the paged-listing ` — page N` still follows). The
default, `'page-and-brand'`, is the list above.

**Per-page layout props.** The old routes often passed the layout something by hand: the
header's colour or variant, `<main>`'s classes, a script in `<head>` for one page, the
current page for the nav's highlight. A document has no route to do that, so the page
component works them out:

- from the page's address, when it's about where the page is (the nav's current item, a
  section of the site): `const { path } = Astro.props`, the document's address (`/about`),
  the same on the public page and in the preview, and null when the document has no page.
  Never read `Astro.url` or `?path=` for it: in the preview they're the editor's own
  address. Pass it on to `<Head path={path}>` as `init`'s page component does;

- from a page field, when an editor might choose it: give the `pages` collection
  `fields` (`fields: { ground: select({ options: […] }) }`) and read it from
  `Astro.props.data`. Never for which header or footer a page shows: those are slots, and
  a page picks among their shared blocks (section 7);
- from the page's first block, when it follows from how the page opens:

  ```astro
  ---
  const LOOKS: Record<string, { header: string; mainClass?: string; intro?: boolean }> = {
  	homeHero: { header: 'blue', mainClass: 'home-page', intro: true },
  	aboutHero: { header: 'ink', mainClass: 'bg-ink text-white' },
  };
  const first = 'blocks' in document ? document.blocks[0]?.type : undefined;
  const look = (first && LOOKS[first]) || { header: 'ink' };
  ---
  ```

A head script that plays an intro or hides content goes in only when `!preview`: the
preview is the page as it is with JavaScript off (section 8).

**The page's own fields** (a case study's hero drawn by the page component, not a block)
are marked with `Astro.props.cms`: wrap the region in `<Block cms={cms} as="header">` and
draw its fields with `Text`, `Media` and the rest, `cms={cms}` (`caracms-blocks` → Marking
sources).

## 4. Convert page by page

For each page, in one commit:

1. **Its sections become blocks.** Each section component becomes a block: a config entry
   (`caracms.config.ts` → `blocks`) with a field for each thing an editor would change,
   and a component that renders **the same elements and classes** as before, with the
   text drawn through `Text` / `RichText` / `Lockup`, links through `Link` / `Buttons` and
   images through `Media` (use `as` and `class` to keep the old elements; `Text` always
   renders one, so pick the element the old markup had, `as="span"` inside a sentence).
   Attributes pass through as written (`<Block data-hero>` renders bare). In a component
   slot write `{label}{" "}<span>`, not `{label} <span>`: Astro's compiler drops that
   space (see `caracms-blocks` → A block component). Reuse a block
   across pages when the sections are the same; don't make one block per page. Things
   that aren't content (an animation's settings, a decorative SVG) stay in the component.
   **A card's icon is an image field** (`media({ only: 'image' })`, with the old files
   imported as its values), never a `select` over files in `public/`: a designer makes their
   own icons, and a select only offers the ones the code knew.
   **A form** draws through `<Form form="…" preview={cms.preview} state={cms.state} />` where
   the look allows, its block declaring `states: { sent: 'Sent', error: 'Couldn’t send',
   invalid: 'Invalid' }`. A form whose markup is the site's own keeps its markup and reads
   its words with `cms.formWords('<form>')`, drawn under `cms.settings` (`caracms-blocks` →
   Forms): its labels, placeholders, button and messages are Site Settings › Forms', never
   block fields or words typed in the component. The config's `label`, `placeholder`, `help`
   and `error` are the defaults; the old copy goes there word for word.
2. **Its content becomes a document**: `content/pages/<path>.json` (`index.json` for
   Home), with the page's copy word for word, its `$schema`, a `title`, and its blocks in
   order. Images by key (step 5).
3. **Its `.astro` route is deleted** (`src/pages/about.astro` for `/about`,
   `src/pages/index.astro` for Home), in the same change. A page is code or a document,
   never both: while the route exists, its address belongs to it.
4. **Lists of pages in the site's code become content.** Search the code for the page's path (`'/about'`).
   A site often lists its pages by hand: a table of each page's colour or header variant,
   a sitemap or page list its tests check, a nav it doesn't read from settings. An editor
   who adds a page in `/admin` can't add it to those, so the new page would fall through to
   a default no one chose. Turn each list into something the page brings with it:
   - a page field, when it's a choice per page (`fields: { ground: select({ options: […] }) }`
     on the `pages` collection, read from `Astro.props.data` in the page component, which
     can write it onto the page for a script to read);
   - the page's first block, when it follows from how the page opens (the `LOOKS` map in
     section 3);
   - the content itself, when it's a list of pages: read the documents
     (`contentReader(site)` from `caracms/content` in a code route, or the files in
     `content/pages/` in a test) rather than a list kept by hand.

   Give each a default that looks right on a plain new page.
5. `npx caracms validate`, `astro build`, the site's own tests (section 2), and the
   look-same check for that page. After a script writes the content files (a conversion
   from the old CMS's), run `npx caracms validate --fix`: it lays each file out as the
   editor saves it (two-space JSON, whitespace only), so an editor's first save doesn't
   reformat the whole file.

**Ship a general block.** With the first converted page, add a block any new page can be
made from, a heading and rich text, even if the site's pages don't need one yet: `init`'s
`text` block is one plain field, so without it a plain new page (a Careers page, a
policy) means writing code. Style it with the site's own CSS for headings and paragraphs:

```ts
// src/components/caracms/prose.ts
import { richText, text, type BlockConfig, type BlockData } from 'caracms/config';

export const prose = {
	label: 'Heading and text',
	component: 'src/components/caracms/ProseBlock.astro',
	fields: {
		heading: text({ heading: true }),
		body: richText({ headings: ['h2', 'h3'] }),
	},
} satisfies BlockConfig;

export type ProseData = BlockData<typeof prose.fields>;
```

with `prose` in `caracms.config.ts` → `blocks`, and a component that draws `heading`
through `Text` and `body` through `RichText` (see `caracms-blocks` → A block component).
Give it a `LOOKS` entry (or whatever the page component reads) so a page that opens with
it gets a sensible header.

**Every block's CSS loads on every document page.** `[...path].astro` serves every
document, so it imports every block component, and Astro bundles all their CSS for it.
Astro scopes a component's `<style>` to its own elements (`data-astro-cid-*`), so About's
styles can't touch Home's blocks; that part is bytes, not looks. caracms's `<Media>` brings
its `.cms-player` styles the same way. What isn't fine is a block with `<style is:global>`
or a global stylesheet import: that now applies on every document page, so move it to the
layout or scope it. A site check that one page's CSS is absent from another can't hold any
more; change it to check the looks.

**The order changes too, and order can decide who wins.** The page's CSS now comes in
other chunks and another order (a chunk per shared component, every block's styles on
every page). The cascade settles a tie in specificity by order, so check where a global
rule (the layout's stylesheet, a reset, Tailwind) and a block's scoped rule set the same
property on the same element:

- **How Astro scopes**: the site's `astro.config` `scopedStyleStrategy`. The default since
  Astro 3 is `'attribute'`: each compound in a scoped selector gets `[data-astro-cid-…]`,
  so `.title` is written out as `.title[data-astro-cid-x]`, one class's worth of
  specificity more per compound (`.a .b` gains two). `'class'` adds a class the same way.
  `'where'` adds `:where(.astro-x)`, which adds no specificity.
- **With `'attribute'` or `'class'`**, a scoped rule beats a global rule with the same
  selector whatever the order. Order decides only when they tie after the extra: a global
  `.card .title` (two classes) against a block's `.title` (a class plus the attribute),
  `.prose h2` against a block's `h2`, and any selector inside `:global(…)`, which isn't scoped.
- **With `'where'`**, every scoped selector counts as written, so a global rule with the
  same selector ties, and the one loaded last wins: that's what can change.
- **Global against global** is all order: a block's `is:global` styles or global import
  against the layout's stylesheet. `!important` and `@layer` (an unlayered rule beats a
  layered one) win regardless of order.

**List each page's stylesheet order, old and new.** look-same's HTML diff sorts `<head>`
(section 9), so it shows which stylesheets changed but not their order. With both sites
served as builds (section 2; a dev server inlines its CSS), print each page's `<link rel="stylesheet">` and `<style>` tags in the
order the page loads them:

```sh
for page in / /about /team; do
  for site in http://localhost:<baseline port> http://localhost:<new port>; do
    echo "== $site$page"
    curl -s "$site$page" | grep -oE '<link[^>]*stylesheet[^>]*>|<style[^>]*>'
  done
done
```

Find the global stylesheet in each list (the layout's import, Tailwind). A stylesheet that
was after it and is now before it, or the other way round, is where a tie can change
sides: open that chunk (`dist/client/_astro/<name>.css`) and look for the ties above, and
grep the moved components for `:global(`. Then look at the elements they style in the
screenshots at both widths. Nothing else tests the order: a tie the screenshots don't show (a hover, a
state behind a toggle) needs a look by hand, and a note in the pull request.

**`draft: true` and similar per-entry markers** (copy that's a placeholder, say) have no
built-in equivalent: caracms's drafts are unpublished edits, not a flag on a page. If
something in the site reads the marker, keep it as a `toggle()` field on the collection;
otherwise drop it. Either way, say so in the pull request.

**Code routes.** Every route in `src/pages/` other than caracms's `[...path].astro` (and a
prefix collection's own route, section 6) is the site's code, and its address is reserved: a static
route (`contact.astro`) reserves exactly `/contact`; a route with parameters
(`work/[slug].astro`) reserves everything under `/work/`. The editor refuses a page there
("… is served by the site's own code (…), so a page can't go there."), and `validate`
reports a document on one as an error, telling you to delete the route if the document
replaces it.

**What stays code:** pages that aren't content: a design-system or style-guide page,
developer pages, anything driven by logic rather than copy. Leave them as routes. Pages
can still link to them, and code can keep using the site's Astro content collections
(`getCollection`) for anything not yet moved.

## 5. Images: `caracms media import`

```sh
npx caracms media import src/assets/team/ana.jpg src/assets/hero.webp
```

It puts each file in the media bucket (under `uploads/<hash>/<name>.<ext>`, as the
editor's uploads are) and prints one JSON array on stdout:

```json
[{ "file": "src/assets/team/ana.jpg", "key": "uploads/3f9c0a1b2c3d/ana.jpg", "w": 1200, "h": 1500, "existed": false }]
```

- It reads `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and
  `S3_SECRET_ACCESS_KEY` from the environment, else the site's `.env`. On CaraCMS Cloud it
  reads `CARACMS_CLOUD_KEY` instead (the same places) and uploads to the site's cloud
  folder, with the same output. It goes by the config's `services`: the other mode's
  variables, if set, are ignored with one warning naming them.
- The same image again writes nothing and prints its key with `"existed": true`. It never
  deletes anything.
- JPEG, PNG, WebP, AVIF, HEIC/HEIF, GIF and SVG, up to 40 MB and 50 megapixels. If any file
  is refused (its type or size), none are written. Exit 0 fine, 1 failed, 2 bad usage.

In the content an image is `{ "key", "alt", "w", "h" }` from that output, with the old
page's alt text. Keep `w` and `h`: without them the image renders, but its box isn't kept
while it loads, and `validate` warns on every image (not a file such as a PDF) that lacks
them. For images already in the bucket, run `media import` on their files again: it
uploads nothing and prints `w` and `h`. A crop keeps the centre unless the value has a `focal` point: if the old
page cropped elsewhere (an `object-position`), set `focal` to match. The images come
through imgproxy now, so their bytes and sometimes their sub-pixel sizes differ from
Astro's; their crops and boxes must not.

Once a page's images are in the bucket and its content points at them, the old files can
go only when nothing in the code still uses them.

## 6. Content collections

The site's Astro content collections (`src/content.config.ts`) become caracms collections
when editors should change them:

- **Pick the address source for each**, one of three:

  | Source | In the config | In the content | A document's address |
  |---|---|---|---|
  | **Pageless** | no `urlBase` | none | none: entries more than one place shows |
  | **A prefix in code** | `urlBase: '/tags/'` | none | `urlBase` + slug, with no page at the prefix |
  | **Held by a page** | `heldBy: 'pages'` | the page's file says `"holds": "journal"` | the page's address + `/` + slug |

  A collection whose old site had a page at its base (a Journal page and the posts under
  it, a Work page and its case studies) is **held** by that page: `heldBy: 'pages'` in
  place of `urlBase`, and `"holds": "<collection>"` in the page's file, after `title`.
  Its documents are served from the page's address and follow the page if it moves. A
  prefix with no page at it (tags) keeps `urlBase`. Neither needs a route:
  `[...path].astro` serves them through `addressedDocuments` (`documentAt` for a site
  that renders on demand). Delete the old collection's `[slug].astro`; one left at a
  held collection's address is a `validate` error. A prefix collection's route file you
  keep is the site's own, and the reader leaves that collection out.
- **Is it a collection at all?** Only when more than one place shows its entries, or each
  has a page (`caracms-blocks` → Where content lives). An FAQ, a logo strip or a team grid
  that one block shows becomes that block's `list()`, even if the old site kept it in a
  content collection: an editor finds it in the block they clicked.
- A collection other pages show (people listed on About and on each case study):
  `kind: 'fields'` with **no `urlBase`** and a `component` (the editor's preview of one
  document). A block shows them
  with `cms.read.documents('<name>')`, which orders them **by title**. To keep the old
  order, give the collection `order: 'manual'` (the agency then drags entries in the
  editor's list) and write the order into Site Settings' `collectionOrder`
  (`{ "<name>": ["<path>", …] }`, first to last); or let a page pick them with a
  `list(reference({ to }))`. **Never an `order` number field**, and never a sort by date
  where the old page listed them by hand. **Take the old order from the old page's HTML,
  not the data file.** It's often implicit: `getCollection` can return a file collection's
  entries in id (slug) order, not the order the YAML lists them. Check it in look-same's
  HTML diff. Mark each entry a block draws with `cms.of(entry)`, never its title.
- Each entry becomes `content/<name>/<slug>.json`: `$schema`, `title`, then the fields.
  Map each zod field to a caracms field kind; images through `media import`.
- **A zod rule that refuses a value** (`.refine()`, `.regex()`, a `.min()` on a string)
  has no caracms equivalent: a caracms field can't refuse what an editor types. Write the
  rule into the field's `help` (`text({ help: 'End with a full stop.' })`), and use what
  the field kinds do offer: `select` options instead of a free string, `text({ max })`
  (a soft limit the editor counts, never a refusal).
- Code that still reads the old collection with `getCollection` keeps working until you
  move it. A code route can read caracms's documents with `contentReader(site)` from
  `caracms/content` (`site` from `virtual:caracms/config`); the page component gets the
  same reader as `Astro.props.read`.
- Delete the old collection's files and its entry in `content.config.ts` only when nothing
  reads it any more.

## 7. The header, the footer and Site Settings

Sort the site-wide data by `caracms-blocks` → Where content lives; the starter
(`src/blocks/site-header.ts`, `site-footer.ts`, `Header.astro`, `Footer.astro`) is the
worked example.

- **The header and footer become shared blocks that fill slots**, even when the site has
  one of each: a block type with `slot: 'header'` (its fields: the menu) and one with
  `slot: 'footer'` (its link columns, its heading and button), their content in
  `content/shared/header.json` and `footer.json` with `"default": true`. The block's
  component draws the site's existing header or footer component, its root through
  `<Block cms={cms} as="footer">`. The page component draws them with
  `<Slot name="header" {...Astro.props} />` and `<Slot name="footer" {...Astro.props} />`.
- **Versions a page picks between** (footers A, B and C) are more shared blocks of the same
  slot, one of them the default; a page that used another says so in its file,
  `"frame": { "footer": "footer-b" }`. Never a page field, a collection or groups in Site
  Settings. A port that already has them there (a page's `footer` select, Site Settings'
  `footerA`/`footerB`): each group becomes a shared footer with its words, the select's value
  becomes the page's `frame.footer` (none for the default's), and the field goes. A cut-down
  footer with no call to action is one more shared footer, not a special case.
- **The header's words go into its shared block** with it (the menu's labels, the menu
  button's names), not Site Settings. What the frame needs from the page (a nav colour
  from the first block) can't be a prop on a slot's block: pass it through `Astro.locals`
  (`caracms-blocks` → Slots).
- **Site Settings keeps setup and details more than one piece shows** (contact details,
  socials): `caracms.config.ts` → `settings: { fields: { … } }`, values in
  `content/site-settings.json`. The footer reads them with `siteSettings(site,
  Astro.locals)` and marks them with `cms.settings` (an email drawn with `<wbr>` breaks by a
  valueless `<Block cms={cms.settings} field="contact.email" as="a">`). Set `brand.name` to
  the site's real name. The logo stays the site's own file.
- **Code routes** that draw the frame themselves use the same slots with Site Settings'
  context: `<Slot name="footer" settingsCms={siteSettingsContext(site, Astro.locals)} />`
  (`siteSettingsContext` from `caracms/content`, `site` from `virtual:caracms/config`).
  They get the defaults.

**Placeholder links** (`#`) are valid link values; keep them as links. An address-only
link that isn't a valid address renders as `null`: draw no link, never `href=""`.

**A value in both places** (the site's name in `brand.name` and in the old settings file
that code routes still read for their titles): an editor changing one would leave the
other behind. Point the code routes at Site Settings with `siteSettings`; where something
can't move yet, list each duplicate in the pull request.

## 8. Scripts under the preview

The editor's preview renders the page in iframes. Opening a document loads them fresh;
each edit morphs the new render into the frame's `<body>` without reloading. **In the
preview, the page is its JS-off self: everything showing, nothing moving or reacting**, so
a click there is always an edit (details in `caracms-blocks` → Scripts and the live
preview):

- Set `<html data-preview>` in the page component. Leave the scroll native (Lenis with
  `smoothWheel: false`) and an intro's head script out.
- Don't set up what moves or reacts when the flag is set: entrances, scroll-driven or
  scroll-scrubbed animation, hover and click behaviour, form validation. Not a "settled"
  version of them: skip them.
- Show what an interaction would reveal (closed folders, covered tiles, an accordion) with
  CSS under `[data-preview]`, since no script runs to open it.
- A script that only lays things out (a carousel placing slides side by side, a grid
  measuring rows) may run, as long as nothing moves or hides, and runs again on
  `caracms:rendered` (fired on `document` after each edit's morph, never on a load).

Check it with the editor walk (section 10).

## 9. The look-same check

`look-same.mjs` is beside this skill (`.claude/skills/caracms-adopt/look-same.mjs`). It
screenshots each page of the old site and the new, full page, at 1440 and 390 wide, with
reduced motion and lazy content scrolled in, and writes a side-by-side report. It also
diffs each page's HTML. It needs
`playwright-core` and Google Chrome on the machine. Install the tool in a temporary folder
**outside the site**, so the site's `package.json` and lockfile don't change:

```sh
npm i --prefix /tmp/look-same playwright-core
node .claude/skills/caracms-adopt/look-same.mjs --playwright /tmp/look-same \
  --old http://localhost:<baseline port> --new http://localhost:<new port> \
  --pages /,/about,/team --out /tmp/look-same/report
```

- `--pages` is a comma list or a file with one path per line. `--widths` defaults to
  `1440,390`. `--out` gets `index.html`, `scores.json`, `shots/` and `html/`. An option
  it doesn't know is refused (exit 1), so a misspelt flag doesn't quietly do nothing.
- **Any status is compared.** A page that answers 404 (or anything) on both sides is
  compared like any other, so put a path that doesn't exist in the list to check the
  site's 404 page. Two different statuses are a difference (`statusDiffers: true`), not an
  error: both pages are still shot and diffed. Each result has `status: { old, new }`,
  and the report shows it beside the page.
- **Images**: before each shot it waits for the images that have started loading, up to
  `--image-wait` seconds (default 5). A lazy image that never starts (in a hidden tab
  panel, a closed `<details>`) isn't waited for. A shot that hit the cap is still taken
  and says so: `imageCap` in `scores.json` (per side, how many images were still loading
  and the first few addresses), a line in the report and on the console. Look at that
  shot before trusting its score.
- Each pair gets `differingShare` (the share of pixels that differ) and `heightDelta`
  (new height minus old, in CSS pixels). It prints one line per page and width.
- **The HTML diff**, per page: both pages' HTML as the server sends it, one tag or text
  per line, with asset hashes, `data-astro-cid-*`, attribute order and what renders the
  same normalised away (the script's header lists exactly what). `scores.json` → `html`
  has `differingLines` per page; the diff is in `html/<page>.diff` and in `index.html`.
  Point both `--old` and `--new` at **builds**: a dev server's injected scripts and inlined
  CSS would fill the diff.
- **A port from another CMS** leaves its own attributes and per-render ids, which fill the
  diff with lines that aren't differences. `--ignore-attr <list>` drops attributes by name,
  a comma list where a trailing `*` matches by prefix. `--mask-ids <regex|auto>` writes ids
  drawn at random per render as `[id1]`, `[id2]`, …, and the same in what points at them
  (`for`, `aria-controls`, `aria-labelledby` and the other id lists, `href="#…"`,
  `url(#…)`). The regex is tested against the id's value, unanchored (`'^(st|sp)-'`);
  `auto` masks React's `:r1:` and ids ending in a run of 5 or more letters and digits with
  both in it (`st-a8f3k2`, not `section-12345`). A reference that no longer points at its
  element still shows (`[id2]` against `[missing1]`). For a Tina site:

  ```sh
  node .claude/skills/caracms-adopt/look-same.mjs --playwright /tmp/look-same \
    --old http://localhost:<baseline port> --new http://localhost:<new port> \
    --pages pages.txt --out /tmp/look-same/report \
    --ignore-attr 'data-tina-*' --mask-ids auto
  ```
- **An element that varies run to run on the old site itself** (a wordmark fitted to its box
  while the display font loads, so two shots of the same build differ) can't be fixed by
  either site. `--css <rules>` adds the same CSS to both pages just before each shot: hide
  the element or pin its size, e.g.
  `--css '[data-logo-wrap]{visibility:hidden!important}'`. It changes the shots only,
  not the HTML diff, and the report names the rules; keep them to the one element, since
  whatever they cover is no longer compared.
- **Spaces**: a space between inline content shows as `␣` at the start of the next text,
  wherever it sat (`<span>sub </span><em>` and `<span>sub</span> <em>` are the same), and a
  space beside a block tag is dropped, since neither shows. So a `␣` line in the diff is a
  space that was really added or lost.
- **`<head>`'s children are compared in any order** (caracms writes `<title>` and the
  description in its own place), so a `<head>` line in the diff is a tag that changed or
  is new. Check the `<title>` line on every page: a different separator or brand name
  shows there (section 3). Order in `<body>` is compared.
- Exit 0 when the report is written (whatever the scores, statuses or image caps), 1 for a
  usage error, 2 when a page couldn't be fetched at all.
- **Read both.** Screenshots miss what doesn't show: an attribute, a list in the wrong
  order under an image or a cover, a space a font hides (`␣→` in old, `→` in new, after `VIEW ALL`:
  a slot's `{label} <span>` that needs `{label}{" "}<span>`), a link's `href`. The HTML diff misses what CSS does. Expect caracms's own
  `og:` and `twitter:` meta tags in the diff; everything else in it is a difference to fix
  or to explain in the pull request.
- **The bar:** text, layout and spacing the same: `heightDelta` 0 and a `differingShare`
  near 0. Image encoding and sub-pixel scaling may differ a little; a person judges those
  from `index.html`. Anything else is a difference to fix, not to explain away.

## 10. Before the pull request

1. `npx caracms validate`: no errors (see `caracms-content` → Getting it merged).
2. `astro build`: every page builds.
3. The site's own tests, as they passed before `init` (section 2).
4. The look-same check of every page you converted: screenshots and HTML diff.
5. **A new page needs no code.** In `/admin`, add a page made of the general block, then
   look at it in the preview and, after `astro build`, on the built site: its header,
   colours and anything else the site set per page come out right, and the site's own
   tests still pass with it there. Anything that's wrong points at a list still kept in
   code (section 4, step 4: lists of pages). Delete the test page before the pull request.
6. **The editor walk**, last. Run `npx caracms audit` first too, and walk what it lists: on
   the first two real moves it found far more than a hand walk had (165 lines on one site:
   the whole case study frame, the nav and the footers). Restart `astro dev` after any
   config change, or the editor shows the old fields. `astro dev`, open `/admin` (with no GitHub App configured it
   runs in local mode: no sign-in, edits save to the files on disk), and on every page you
   ported:
   - **click every visible word** (inside a block, select the block first): each opens its field (the header's and footer's open
     their shared block, the phone Site Settings, a card its entry);
   - **scroll the whole page**: nothing moves;
   - **open anything hidden** behind an interaction: it already shows in the preview;
   - **select a block with states** (a form): the switch over the preview shows each one;
     click its words in each state too.

   Whatever can't be clicked is a field that isn't marked: mark it (`caracms-blocks` →
   Marking sources). Whatever lives in a collection only that block reads becomes the
   block's list (section 6). The exceptions, which rightly don't open a field: a document's
   title (edited at the top of its form), and the header and footer of a site
   not yet on slots (the editor marks them "Edited elsewhere").

   **The walk ends with `npx caracms audit`.** It renders every page and shared block in
   the site's Vite (with the in-memory media, so images draw and count whether or not the
   site's media is set up where it runs) and lists what clicking can miss: fields with words nothing on the page
   marks, words in the page no field holds (the header, a card's label, a "Read more" the
   component codes; words inside the header's or footer's links are never listed, since
   the frame's links stay unmarked so they follow), and a pageless collection only one block reads (a list on that block,
   section 6). End with it **quiet**, or with every line it still prints accepted in the
   site's `docs/decisions.md` (the line, and why). Lines that rightly stay are data only a
   script reads (a scroll piece's extra images, a panel the script fills), and a word that
   only sits in a data attribute until the script shows it. A "Read more" an editor should be able to
   change is a field; words that are the site's code on purpose (a calculator's interface)
   get `data-cms-fixed` on an element round them, which audit leaves out. Never loosen
   what audit checks to make it quiet.

Work on a branch and open a pull request; never commit to `main` directly, and never
touch the `drafts` branch.

## 11. Before the first deploy: `caracms-hosting`

The site's hosting is `caracms-hosting`'s, not this skill's. Before the site is first
deployed with caracms, `init` must have run with the mode (`--cloud` or `--self-hosted`,
section 1), so `caracms.config.ts` has `services`; then follow `caracms-hosting`: the
host for the server (section 2), and, for a site that ran self-hosted and is going onto
the cloud, the move list `init --cloud` prints (section 3).
