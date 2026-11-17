---
name: caracms-tina
description: Port a site built on self-hosted Tina (a Caracode Tina template site, with `tina/`, `server.mjs` and pages as JSON read through `src/lib/sections.ts`) onto caracms — strip Tina, run the reference conversion script (`tina-to-caracms.mjs`) once, rewrite each block onto `Block`, `Text`, `RichText` and `Media` so text is typed on the page, carry page-wide rules and cards into the page component, re-model the content for the editor, deploy to a branch environment that can't publish to the live site, and prove visitors' pages look the same. Use when porting a Tina site, re-running its conversion, or adapting the script.
---

# Porting a Tina site onto caracms

**The bar: visitors' pages look the same.** The port changes what editors see, not what
visitors see. Any redesign is separate work, after the switch.

**The port is done in a sitting or two, on a site nobody is editing meanwhile.** The developer
picks the day and keeps the old site quiet until it's flipped; that's theirs to arrange, not
yours. So the conversion script is a start, not the owner of the content: it writes
`content/` once (re-run it while you're still getting the conversion right), and from the
moment you edit `content/` yourself, the content is the site's. Then it's re-modelled for
the editor (section 12), which the script doesn't do.

Read with this skill:

- `caracms-blocks`: blocks, fields, collections, the page component, forms.
- `caracms-adopt`: `init` in detail, the look-same script (section 9), motion under the
  preview (section 8). This skill is the Tina-specific order; adopt's page-by-page
  method doesn't apply, since the script converts every page at once.
- `caracms-content`: the content files the script writes.
- `caracms-hosting`: the mode `init` is run with, the host, and (on CaraCMS Cloud) the
  move list to follow at the switch. Hosting is that skill's, not this one's.
- Beside this file: **`tina-to-caracms.mjs`**, the reference script (its header is its
  manual), and **`field-kinds.md`**, the mapping table: how each Tina field kind becomes a
  caracms field and value.

Commands run from the site's root: `npx caracms …` (or `pnpm caracms …`).

**Swapping in a new packed tarball** at the same `file:` path (`vendor/caracms.tgz`):
`pnpm install`, even with `--force`, keeps the old copy, since the lockfile holds the old
file's integrity. Remove and add it again:
`pnpm remove caracms && pnpm add caracms@file:vendor/caracms.tgz`.

## 0. Before anything moves: the block table

A template site has its own block templates (`_template` names, camelCase). Propose the
**old-to-new block table** to the developer and get it approved before content moves: each Tina
template, the caracms block key it becomes, and whether it maps one to one, splits or
is flattened. Keys are kebab case (`textMedia` → `text-media`, the script's default);
rename where the editor's label reads better (`features` → `steps`, `fullMedia` →
`wide-media`). The approved renames go into the script's adapt table (`blockRenames`).

Also list, for the same approval: the fields that will be **edited in the sidebar only**
(display text fitted to its box, split-letter headings, a word drawn as artwork), anything
the template does that caracms has no place for yet, and **what you'd re-model** (section
12: each collection and what becomes of it, each order number, toggle and icon dropdown).
One stop, at the start; the developer is there to answer it.

## 1. The order

Work on a branch (`caracms-port`, say) in a worktree of the site. Commit after each step.

1. **Bump Astro on its own commit** to the version caracms needs (its peer dependency:
   `npm view caracms peerDependencies`, or the tarball's `package.json` while the package
   is unpublished or the port runs on a packed tarball). Build and check the site still looks the same
   before anything else changes. If the site pins its own `vite`, bump it with Astro:
   left behind, it leaves a second Vite in the tree and `astro check` fails in the Astro
   config. **Bump `.nvmrc` and `engines.node` in `package.json` with Astro** (Astro 7.4
   needs Node 22.23.4 or later, and so does caracms): a host that reads them builds on
   the older Node otherwise (Railway fails with exit 1 and no error text in the build
   log).
2. **Strip Tina** (section 3): `tina/`, `server.mjs`, `server/`, Tina's routes and admin,
   **including the untracked `tina/__generated__/` and `public/admin/`** (they're in
   `.gitignore`; delete them from disk too, or `init` and the build trip on them).
3. **Delete `content/`** (git keeps it). `init` refuses a `content/` that isn't caracms's.
4. **Switch the adapter to standalone:** `@astrojs/node` with `mode: 'standalone'`.
   `caracms start` serves `dist/server/entry.mjs` and refuses any other mode.
5. **`npx caracms init --cloud`** (or `--self-hosted`), read the dry run, then
   **`npx caracms init --cloud --write`** (or `--self-hosted --write`) and install again
   (caracms-adopt → section 1). The flag is the site's mode: choosing it is
   `caracms-hosting` → section 1, and it's always passed (without a terminal `init`
   won't pick one). It links the skills, writes the config (with `services`), the
   CLAUDE.md block and the health route. On a site with a template's `railway.ts`,
   `--cloud` also prints the move list: hold it for the switch (section 9). **A template site already has a
   `.railway/railway.ts` that describes production: leave it alone and never apply it**
   (applying it can switch production's CDN off). `init` treats a site that has one as
   a Railway site and leaves the file untouched, which is the expected outcome. Set the
   branch environment up with the Railway CLI or MCP, scoped to that environment
   (section 9).
6. **Copy the script and run it** (section 2) against a **built** checkout of `main`.
   First run with `--scaffold-config` for a starting `caracms.config.ts`. It names a
   component per block before any is written, so nothing builds until they exist: point
   every block's `component` at one stub first, then swap each in as it's rewritten.
7. **Rewrite the blocks** onto caracms's components (section 4), the page component
   (section 5), the routes (section 6), forms (section 8).
8. **`npx caracms validate`**: no errors and no warnings, the missing-`w`/`h` warning
   included (the key map carries every image's size, section 7).
9. **Look-same** every public page against `main` at the commit the script ran on
   (section 11).
10. **Re-model the content for the editor** (section 12), then look-same again: the pages
    must not have moved.
11. **The branch environment** (section 9), and the flip.

## 2. The conversion script

Copy `.claude/skills/caracms-tina/tina-to-caracms.mjs` into the site's own
`scripts/`. The site's copy is the one that runs; it's committed with the site.

**Adapt only the table under `ADAPT HERE`** (the script's header says what each entry is):
the approved `blockRenames`, `fieldDefaults` (values Tina's files leave out but the
template's mapper code read as set: a toggle that defaulted on, a per-block background
default that isn't the first option), `addressFields`, `headingFields`, `docTitleAlt`,
the file-link pattern, Tina's home file, `holders` (which page holds which collection;
the only source of holding, so an empty table holds nothing), `shared` (shared blocks:
Site Settings fields that are one piece's own, such as a footer's columns, moved out of
Site Settings, and words the template's code drew, such as a footer's "Contact" heading or
the 404's words, each held as a field), `formWords` (Site Settings › Forms words the
template's code said differently from caracms's defaults), `redirects` (addresses the
template served that caracms doesn't; `/sitemap-index.xml` → `/sitemap.xml` is there
already) and `formsConfig` (the template's `forms.config.mjs`). Words the template's code
drew go in the table, never into `content/` by hand: a re-run writes `content/` whole.
**`addressFields` matters:** Tina's schema has
no marker for a link field (a custom component serialises to `ui: {}`), so only strings
named `href` are known to be addresses; list every other one. Everything below the table is generic and
driven by Tina's generated schema; never add per-block code. If a block needs something
the table can't say, that's a gap in the script: change the generic part, and say so in
your report so it reaches the package's copy.

Run it from the site's root:

```bash
node scripts/tina-to-caracms.mjs --from ../old-site-main --scaffold-config
```

- `--from` is a checkout of the Tina site's `main` that has been **built** (`pnpm build`,
  or the template's `build:local`), so `tina/__generated__/_schema.json` exists. Only that
  schema is needed: the site's own build may fail there for lack of env, and that's fine.
  If `build:local` stops on a busy port 9000 (Tina's datalayer), pass
  `--datalayer-port <another>` to the Tina site's own `build:local` / `tinacms build`, not
  to this script (it rejects unknown arguments).
- Run it after `caracms init --write` and an install: it borrows the installed package's
  upload key rule, image sniffer and S3 signer.
- `--scaffold-config` writes a starting `caracms.config.ts` from Tina's schema, with
  Tina's labels and help. **Once.** After that the config and the block components are
  the site's own, hand-maintained, and a normal run never touches them (section 4 says
  which options only you can add). A collection the adapt table's `holders` names
  (`products: 'products'`) is **held by that page**: the scaffold writes `heldBy: 'pages'` and
  no `urlBase`, and every run writes `"holds": "products"` on the page (section 6). A
  collection not in the table keeps `urlBase`. The script prints a hint for each sections
  collection that has a same-named page but isn't in the table, saying what to add. The
  scaffold also writes the config's `forms` from the template's forms config (each field's
  on-page label; an `onSubmit` or a key caracms's forms don't take is printed as a note to
  carry over by hand), adds the shared blocks to `blocks` (with their `slot`), and keeps
  `init --cloud`'s `services` line (it accepts init's starting config with that line
  without `--force`).
- `--recipients <address>` replaces every form's recipients in Site Settings with one
  address. **Always pass it for a branch environment**: the converted Site Settings name
  the client, and a test submission would email them. The client's own addresses go back
  into Site Settings at the flip (section 9).

**What it owns: `content/`, nothing else.** Each run deletes `content/` and writes it again,
laid out the way the editor saves it, so the same Tina content gives byte-identical files
and `validate` finds nothing to reformat. **A re-run deletes `content/` whole**, so re-run only
while `content/` is still exactly as the script wrote it. Once you've changed it yourself
(the re-modelling, an edit in `/admin`), stop running the script: the content is the
site's from then. Beside it, it only adds to two things (section 7):

- `scripts/tina-media-keys.json`, the key map (commit it): each Tina bucket key the
  content uses → its caracms key by its bytes, with an image's `w`/`h`.
- the media bucket: each object copied within it to its caracms key (skipped when the key
  exists; it never deletes or overwrites).

A key the map lacks is read from the bucket, so the first run needs the bucket's `S3_*`
settings. A key whose bytes can't be read fails the run, each named with where the
content uses it, and nothing is written: fix it in the Tina content, or run with the
settings. With every key in the map, a run needs no bucket (it says the bucket wasn't
checked; run once with `S3_*` to make any copy still missing).

If the old site's content did change before you've touched `content/`: pull `main` in the
`--from` checkout, build it, re-run (with `S3_*` if Tina has new images), commit `content/`
and the key map, and look-same again against that commit. After you've touched it, carry a
late change across by hand.

What the script converts (the full table is `field-kinds.md`): `_template` → `type`,
the section list → `blocks`, the home file → `index.json`, Tina's Markdown rich text →
caracms's (Tina's escapes such as `Q\&A` and `mailto\:` undone), an image and its `…Alt`
sibling → one media value, a Mux clip → a video value, `linkLabel` + `href` → one
`link()`, references → document paths, Site Settings (`formNotifications` →
`formRecipients`, `adminBranding` → `brand`, `adminAccess` → `editors`, `defaultSeo` →
`seo`), images and file links → keys by their bytes and file addresses (section 7),
Tina's `hidden` → `"hidden": true` (section 6), the page that sits at a collection's base
→ `"holds": "<collection>"` (section 6), and, from the adapt table, the shared blocks
(`content/shared/`), Site Settings' `formWords` and its `redirects` (each old
`/files/<name>` to its new address, then the table's own).

## 3. Tina's pieces and what replaces each

| The template's | Goes | Replaced by |
|---|---|---|
| `tina/`, `tina/__generated__/`, Tina's dependencies | yes | `caracms.config.ts` |
| `public/admin/`, `public/admin-previews/` | yes | `/admin` (caracms's editor) |
| `server.mjs`, `server/` (Express: forms, downloads, the admin, previews) | yes | `caracms start`; forms → `/_caracms/form` (section 8); downloads → caracms file addresses `/files/<12 hex>/<name>` |
| `src/pages/[...slug].astro` and the collection routes reading Tina (`blog/[slug].astro`) | yes | the one catch-all (section 6) |
| `src/lib/sections.ts` (the mappers: Tina document → component props) | yes, except page-wide logic | blocks draw from their own data; page-wide rules → the page component (section 5) |
| `Sections.astro` / `PageView` | yes | the page component and `<Blocks>` |
| `data-tina-field` on every element | yes | caracms's markers, added by `Block`, `Text`, `RichText`, `Media` in a preview only |
| `islandPreview.ts`, Tina's preview islands | yes | caracms's preview; site scripts listen for `caracms:rendered` (section 4) |
| `@astrojs/sitemap` | yes | caracms's `/sitemap.xml` (needs `SITE_URL`) |
| `.template-sync`, engine-sync scripts, the deploy-gate workflow, `@caracode/pins` | yes | nothing (`.carapin/` can stay as history) |
| The header, footer, motion, fonts, analytics tags, design-system routes, the site's own `src/lib/` logic | **stays** | |

**Tests:** delete tests of Tina's machinery, of the mappers, of deleted files, and of
`data-tina-field`. A test that guards site behaviour that still exists is rewritten
against caracms's content format; the template's helper that reads committed content is
usually the one to rewrite first. **Docs:** the engine and Tina docs go (Tina behaviour,
publishing, admin login, the media pipeline, downloads). The site's own half of
`docs/decisions.md` stays, rewritten where it describes Tina. CLAUDE.md loses the
engine/site split; `init` added its caracms block.

## 4. Rewriting a block onto caracms's components

**The default: every block draws through caracms's components**, keeping the template's
markup and classes exactly. That's what makes its text typed on the page in `/admin`.
(Keeping the template's components behind a reverse adapter, feeding them props from
caracms's data, is faster to look-same but leaves every field sidebar-only. Use it only
as a stepping stone, a block at a time.)

```astro
---
import Block from 'caracms/components/Block.astro';
import Media from 'caracms/components/Media.astro';
import RichText from 'caracms/components/RichText.astro';
import Text from 'caracms/components/Text.astro';
import type { BlockProps } from 'caracms/document';
import type { TextMediaData } from './text-media.ts';

type Props = BlockProps<TextMediaData>;
const { block, cms } = Astro.props;
---

<Block cms={cms} class={`section bg-${block.background}`} id={block.anchor || undefined}>
	<Text cms={cms} field="heading" value={block.heading} class="heading text-balance" lineClass="block text-balance" />
	<RichText cms={cms} field="body" value={block.body} class="prose" />
	<Media cms={cms} field="media" value={block.media} sizes="(min-width: 1024px) 50vw, 100vw" class="media" />
</Block>
```

- **`Block`** is the block's root (`as="section"` by default; `as` and every attribute
  pass through). Drop the template's `data-tina-field`.
- **`Text`** for a plain text field: `as` sets the tag; a field declared
  `text({ heading: true })` is the page's `h1` when it's the first heading, else `h2`.
- **Lines** (`text({ lines: true })` in the config, `lineClass` on `Text`): for a heading
  the template drew one element per typed line (its `typography.ts`/`Heading.astro`).
  Two lines or more draw a `<span class={lineClass}>` each, blank lines draw nothing,
  and a single line is drawn bare, as the template's `ui/Heading.astro` does. Typed on
  the page, Shift+Enter still stores `\n`.
- **`RichText`** for rich text: semantic HTML with no classes, inside one wrapper (`as`,
  default `div`). Style it from the wrapper's class (`.prose p`, `.prose strong`).
- **A rich-text heading** (`richText({ heading: true })`): for a heading the template
  drew from rich text with bold as a highlight colour and each paragraph a line
  (`ui/RichLine.astro`). It draws inline runs joined by `<br>` inside its own heading
  tag (`h1` when it's the page's first heading), never `<p>`. It takes bold and line
  breaks only, typed on the page. The template's highlight class becomes site CSS on
  `strong` inside it: `.statement strong { color: var(--highlight); }`.
- **`Media`** for an image or a Mux clip: one `<img>` with a srcset (or the clip's
  video). Fluid: `sizes` (and `ratio` to crop); fixed: `width`/`height`. For flat
  artwork the template served as PNG (WebP smears it), declare the field
  `media({ format: 'png' })`: every width is then `@png`.
- **YouTube**: a `link({ addressOnly: true })`; the block parses the id from the address.
- **Sidebar-only fields** (fitted display text, split letters, a word drawn as artwork):
  draw the value yourself (`{block.word}`) instead of through `Text`, so it isn't typed
  on the page. Text the template splits into letters for motion can be drawn unsplit in
  the preview (`cms.preview`), where motion is off, and then typed on the page.
- **Help:** Tina's long block descriptions go into the block's `help` (one or two
  sentences, shown at the top of the block in the sidebar). Field `help` stays short.
- **Site scripts and the preview:** the preview re-renders a block in place after each
  edit (a morph, no reload). A script that measures or fits text (`fitText.ts`) re-runs
  on it: `document.addEventListener('caracms:rendered', run)` (fired on the frame's
  `document` after each morph, never on public pages). Motion follows caracms-adopt →
  section 8.

The options only you can add (`--scaffold-config` doesn't know them): `heading: true` on
the block's heading field, `lines: true`, `richText({ heading: true })`,
`media({ format: 'png' })`, `media({ play: 'loop' })` for a hero's loop, `allowNoLink: true`
on buttons that may be a label alone ("Coming soon": `validate` warns on one until it's
set), select defaults from mapper code, and trimmed `help`.

## 5. The page component: page-wide rules and cards

The template's page-wide logic (`pageRules.ts`, `pageParts()`) moves into the page
component (`page:` in the config). It gets `document`, `collection`, `path` (the page's
path in its collection, `null` for none), `preview`, `data`, `settings` (Site
Settings), `listPage` and `read`.

- **A block sees only its own data.** Page-wide rules the Tina mappers applied across
  blocks (dropping an anchor already used higher up the page, say) belong here, through
  `<Blocks>`'s context or its `wrap` rule. Check whether today's content needs each one
  before carrying it over.
- **Titles.** Tina template sites show Site Settings' title on every page without its own
  `seo.title`, not `<page> · <brand>`: set `titleFallback: 'site'` in the config
  (caracms-adopt → Keep the old title format). Check the `<title>` lines in look-same's
  HTML diff.
- **Time zone.** A Tina template site keeps its zone in the `SITE_TIMEZONE` variable;
  caracms reads `timeZone` in the config (default UTC) for the editor's and the inbox's
  times. Copy production's value into the config.
- **The h1 and eager loading** are caracms's own: the first block with a heading holds
  the `h1`, and the first two blocks' images load eagerly (`cms.first`, `cms.eager`). Drop
  the template's versions.
- **Cards** (a run of neighbouring blocks drawn inside a band, each card holding several
  blocks, the anchor `id` on the card): give `<Blocks>` a `wrap` rule. It gets the blocks
  that render (`{ index, type, data }`, `data` as the block gets it) and returns runs:
  `{ from, to, component, props, runs }`, document indices inclusive, with `runs` nested
  inside (the cards inside a band). Each block inside keeps its own index, context and
  preview markers, so it's selected, typed into and morphed as anywhere else.

```astro
---
import Blocks from 'caracms/components/Blocks.astro';
import type { BlockRun, PageProps, WrapBlocks } from 'caracms/document';
import CardBand from './CardBand.astro';
import Card from '../components/ui/Card.astro';

type Props = PageProps;
const { document, collection, preview = false, listPage } = Astro.props;

/** The template's pageParts(), on the blocks' `card` field: "start" opens a card, "continue" joins the one above. */
const cards: WrapBlocks = (blocks) => {
	const bands: { from: number; to: number; cards: BlockRun[] }[] = [];
	for (const b of blocks) {
		const spot = b.data.card as string | undefined;
		if (!spot || spot === 'none') continue;
		let band = bands.at(-1);
		// A band is a run of neighbouring carded blocks: a gap (an uncarded block) starts a new one.
		if (!band || band.to !== b.index - 1) bands.push((band = { from: b.index, to: b.index, cards: [] }));
		const card = band.cards.at(-1);
		if (spot === 'start' || !card) band.cards.push({ from: b.index, to: b.index, component: Card, props: { id: (b.data.anchor as string) || undefined } });
		else band.cards[band.cards.length - 1] = { ...card, to: b.index };
		band.to = b.index;
	}
	return bands.map((band) => ({ from: band.from, to: band.to, component: CardBand, runs: band.cards }));
};
---

<Blocks document={document} collection={collection} preview={preview} listPage={listPage} wrap={cards} />
```

A wrapper component renders `<slot />` where the blocks go. Rules that break the runs'
order (overlapping, out of order, a card outside its band) stop the render with a
sentence: that's a bug in the rule. The block's anchor `id` goes on the card, not the
block, when the template put it there: section links jump to those ids.

## 6. Routes, hidden pages and the 404

A collection with pages gets its address from one of three places, and the port picks
one per collection:

| Source | In the config | In the content | A document's address | In the template |
|---|---|---|---|---|
| **Pageless** | no `urlBase` | none | none | entries more than one page lists (people on About and on each post) |
| **A prefix in code** | `urlBase: '/tags/'` | none | `urlBase` + slug | `/tags/<slug>`, with no Tags page |
| **Held by a page** | `heldBy: 'pages'` | the page says `"holds": "posts"` | the page's address + `/` + slug | the Blog page and its posts: `/blog/<slug>` |

**Don't write a route per collection.** A template's Blog page **holds** its posts
collection: the posts are at the page's address, so they follow the page wherever it
moves. A prefix with no page (tags) keeps `urlBase`. `init` writes one catch-all
(`src/pages/[...path].astro`, once Tina's `[...slug].astro` is gone: it refuses while
another route catches the top of the site), and it serves pages, held documents and
prefix documents alike, through the reader from `caracms/content`:

```ts
import { addressedDocuments } from 'caracms/content';

export async function getStaticPaths() {
	const documents = await addressedDocuments(site); // { collection, path, url }[]
	return documents.map((d) => ({ params: { path: d.url === '/' ? undefined : d.url.slice(1) }, props: { collection: d.collection, path: d.path } }));
}
```

The reader already leaves out **`e.warning`** (a file that can't be opened) and
**`e.hidden`** (a hidden page, one under it, and the documents of a hidden holder). A
site that renders on demand asks `documentAt(site, pathname)` instead: the document at a
request path, or `null`.

**The script holds only what the adapt table says.** `holders: { products: 'products' }` (or
`posts: 'blog'` where the folder isn't named like the page) makes `/products/` the page's
address and the collection's; with no entry nothing is held, so a site ported before this
keeps its `urlBase`. For each sections collection that has a same-named page and no entry,
the script prints a hint with the line to add (then re-run with `--scaffold-config
--force`); a fields collection is never suggested. Home never
holds a collection, one page holds one collection, and a held collection is flat;
`validate` says when any of that is wrong. A `holds` added to a page by hand is
lost on the next run (`content/` is written whole), so the table is where it belongs.

**Delete the template's collection routes.** A route with parameters left at a held base
(`src/pages/blog/[slug].astro`) is a `validate` error: the catch-all serves those
documents. A route at a prefix collection's base (`src/pages/tags/[slug].astro`) is the
site's own for that collection, and the reader leaves the collection out, so keep it only
for a page the catch-all can't draw (a listing built from logic); otherwise delete it
and let the catch-all serve the prefix too.

**Hidden pages:** Tina's `hidden` becomes `"hidden": true` at the top of the document,
after its title. A hidden page isn't served (visitors get the site's own `404.astro`),
isn't in the sitemap, isn't offered by the link picker, and isn't in a block's
`cms.read.documents(…)`; pages nested under it are hidden with it. It stays editable,
previewable and publishable in `/admin`, marked "Hidden" in the pages list, with a
"Hidden from the site" switch in its page settings. The home page can't be hidden (the
script warns and leaves it shown). A link to a hidden page is a warning, not an error,
in the editor and in `validate`, naming the page.

## 7. Images

- **New keys, by the bytes, in the same bucket.** The template's images are imgproxy URLs
  over the media bucket (`…/unsafe/plain/s3://<bucket>/uploads/…`), its downloads
  `/files/<name>` over `uploads/<name>`. Those keys aren't caracms's: `media push` and the
  cloud take only the upload route's shape, `uploads/<12 hex of the bytes' SHA-256>/<name>.<ext>`.
  So the script reads each object the content uses once, copies it within the bucket to
  that key, and the content names the new key. Nothing is deleted or overwritten: the
  live Tina site keeps serving the old keys until the switch, and the bucket only grows.
- **The key map** (`scripts/tina-media-keys.json`, commit it) holds each old key's new key
  and an image's `w`/`h`. The first run needs the bucket (`S3_*`); after that the map
  answers. A key it can't read fails the run by name (section 2). `validate` warns on any
  image still missing its size.
- **A run with `S3_*` notices replaced files.** Tina's editor re-uploads a file over the
  same key (a new price list PDF lands on the same `uploads/…pdf` again), so the map alone
  would keep pointing at the old bytes. With the bucket's settings, the script HEADs every
  key the map has and compares the ETag and size kept in its entry: unchanged costs that
  HEAD and nothing more; changed means the bytes are read and hashed again, copied to
  their new key, and the new key goes into the map and the content, while the old copy
  stays (the run prints each re-keyed key). An entry from before ETags were kept gets one
  at its first credentialed run, its bytes hashed once to confirm its key. Without `S3_*`
  the map is used as it is, so an offline re-run gives the same bytes but can't see a
  replaced file: the final run before a switch always has the bucket's settings.
Where the images are served from then depends on the mode (`services`, section 1 step 5):

- **On CaraCMS Cloud:** `caracms media push` copies the upload-shaped keys, under the same
  keys, from the template's bucket into the site's cloud folder (README: *Moving a site's
  images in*; `caracms-hosting` → section 3, step 3). The template's old keys are still in
  that bucket: push leaves them, each named on a `left` line and counted in `left`, not
  `failed`, and that's expected. The content doesn't change, and the cloud serves the
  images signed from `img.caracms.cloud`, so **no signed imgproxy goes up beside the old
  one**. Run the push with the bucket's `S3_*` on its
  command line before the branch environment's first build that shows images, and again
  before the switch for anything uploaded in Tina since (it skips what's copied).
  `CARACMS_CLOUD_KEY` alone shows images (a key per place: the laptop, the branch
  environment). The template's own imgproxy keeps serving Tina's site untouched until
  the switch.
- **Self-hosted:** caracms signs every URL (`CARACMS_MEDIA_URL`, `IMGPROXY_KEY`,
  `IMGPROXY_SALT`, `S3_BUCKET`). The template's production imgproxy is unsigned and its
  URLs are cached by the CDN, so **never give it a key while Tina runs**: stand up a new,
  signed imgproxy beside it, reading the same bucket.

In both, without the credentials (the key, or the media variables) the preview draws no
images, and a build stops with a sentence naming what's missing.

## 8. Forms

Both of a template's usual forms fit caracms's own: define them in the site's forms
(caracms-blocks → forms; `--scaffold-config` writes them from the template's
`forms.config.mjs`, section 2), and their submissions go to the inbox in `/admin`, with a
notification to Site Settings' `formRecipients`. A form drawn with `<Form>` is styled from
the site's CSS to the template's markup; its hooks (caracms-blocks → Forms: `submitClass`,
`thanks`, `errors`, `actions`, `labelPlaceholders`, attributes on the form, a textarea's
`rows`) carry the template's button classes, its wording and its layout, so no wrapper or
copied CSS is needed for them.

A form that keeps its own markup (a footer's newsletter signup) reads its words with
`cms.formWords` and draws its states from `cms.state` (caracms-blocks → Forms), so its
labels, errors and sent line are Site Settings › Forms' and typed on the page, never
copied into block fields. Where the template's code said different words from caracms's
defaults (a button's "Send a message", a sent line), put them in the adapt table's
`formWords`: every run writes them into Site Settings › Forms. It posts to caracms's endpoint by its **wire contract**:

- `POST /_caracms/form`, urlencoded (or `multipart/form-data` when the form has a files
  field; JSON is accepted too).
- `form`: the form's id. `return`: the page's path, where a no-script post comes back to.
- Each field by its name. `fax`: the honeypot, an empty text input hidden from people
  (`tabindex="-1"`, off-screen); filled in, the post is dropped and answered as sent.
- `cf-turnstile-response`: Turnstile's token, added by Cloudflare's widget when the site
  has `TURNSTILE_SITE_KEY` (at build) and `TURNSTILE_SECRET_KEY` (at run time). Without
  the secret the endpoint accepts and logs it.
- Answers: with `Accept: application/json`, `200 {"ok":true}` or the status with
  `{"error":"…"}` (400 a field, 403 the bot check, 429 too many, 502 storing failed);
  without, a `303` to `<return>?sent=1`, or the error as plain text.

Not `/api/forms` with `source`/`redirectTo` (the template's): nothing stays a site
endpoint. The template's existing submissions stay in its own bucket and need no
conversion: caracms's inbox reads the template's records as they are (`<id>.json` with
`v: 1`, files at `<id>/<n>-<name>`), including a list the template stored under
`fields` (its order lines, `fields.orderLines = [{ product, amount, unit }]`), shown one
line per row once the form declares that field as rows. Older template records kept order
lines under a top-level `rows[<name>]`: those aren't read (the inbox shows the rest of the
record).

**The template's own field types and sourced selects.** caracms has no site-registered
field types (`form-fields.mjs` doesn't come over), but its forms say what the template's
did, declared (caracms-blocks → Forms):

- A select with `source: 'jobs'` → `source: { collection: 'jobs' }`. `--scaffold-config`
  writes it with no `where`, and prints a note: the template filtered in code
  (`form-collections.mjs`: live jobs only), so add `where: '<the toggle>'` (`'live'`) and
  give that toggle a default of on in the collection, since a blank one read as on there.
- A field's `watermark` → `suffix`; a select's `placeholder` carries over as its blank
  first choice.
- An `orderLines` field → a `rows` field. The scaffold leaves it out with a note showing
  the template's field; declare it by hand: a product column with `source`, an amount
  `number` column, a unit `select` with every unit as `options` and `from: { column:
  'product', field: 'units', else: [the fallback units] }`. Products need a hand order
  in caracms to keep their order, and old records name a product by its Tina file name, so
  they show a title only where the ported document keeps that name.
- The template's own refusal wordings become the package's sentences; anything a site
  added around its form in code (a prefill from the query string, a default unit, an extra
  line under the rows) stays in the site's own markup and script.

## 9. The branch environment

The port is deployed from its branch to its own environment, **never production**. The
template sites run on Railway, so this section is written for it. A site on another host
needs the same pieces there (the caracms README's Hosting section has each host):

- A new environment in the site's Railway project (`caracms`), with its own `web` and
  Redis, deploying from the port branch, and `CARACMS_ALLOW` from the template's admin
  allow list. Then, by mode:
  - **On CaraCMS Cloud:** a key of its own, labelled for the environment in
    app.caracms.com, as `CARACMS_CLOUD_KEY`; no imgproxy, buckets, Resend, Mux or GitHub
    variables (the key replaces them). Its images are the ones `media push` copied
    (section 7).
  - **Self-hosted:** a signed imgproxy and its own submissions bucket. It reads the live
    media bucket (caracms only ever adds to a bucket). Its variables copy production's
    where they carry over (`RESEND_API_KEY`, `FORMS_FROM`, the site's `MUX_TOKEN_*`).
- **`CARACMS_MAIN_BRANCH` and `CARACMS_DRAFTS_BRANCH`** name caracms's two branches
  (default `main` and `drafts`). Set them to the port branch and its own drafts branch
  (`caracms-port`, `caracms-drafts`) **before anyone signs in**: a Publish there then
  commits to the port branch and redeploys the environment, and the live site's `main`
  never moves. With the defaults, the first Publish would land caracms's content on the
  live site's `main`.
- Self-hosted, a GitHub credential on the environment, as for any caracms site: a
  fine-grained token on the site's repo, or the App (the caracms README → Hosting →
  GitHub). On the cloud, the caracms App on the repo covers it (`caracms-hosting` →
  section 1).
- Convert with `--recipients <agency address>`, so test submissions never reach the client.
- **Never `railway config apply` against production**: production's variables are set
  with `railway variables --set` (a template's Railway file can switch its CDN off).

**The flip** (the developer's, at the end of the port): the client's form recipients go back into
Site Settings in place of the agency's address, the branch is merged, production's
variables move to caracms's (the branch variables unset), and Tina's imgproxy and
variables retire.
Production's hosting is `caracms-hosting`'s: before the merge deploys, follow it (the
host, section 2; on the cloud, the move list `init --cloud` printed, in its order,
retiring nothing until its checks hold, section 3).

## 10. Before calling it done

- `npx caracms validate`: no errors, no warnings.
- `astro check` and `astro build` pass; the site's remaining tests pass.
- In `/admin`: every heading, intro, body, caption and button label the template marked
  with `data-tina-field` can be typed on the page, except the sidebar-only fields you
  listed; rich headings keep bold as the highlight after an edit; blocks inside cards
  select and morph; a hidden page 404s publicly and edits in `/admin`.
- `npx caracms audit` is quiet, or each line it still prints is accepted in the site's
  `docs/decisions.md` (caracms-adopt → Before the pull request). Tina only marked what the
  template's editors could reach; the header, footer, cards and contact details usually
  weren't, and audit lists them.

## 11. Look-same

Run caracms-adopt's look-same script (section 9) on every public page, the 404 included,
at 1440 and 390, against a build of `main` at the commit the script ran on. Build that baseline with **production's** media
base URL: a local build takes it from `.dev.env`, which may point at the template's
imgproxy, and then images render unresized and nothing compares. Pass the template's
attributes and random ids:

```bash
node .claude/skills/caracms-adopt/look-same.mjs --playwright /tmp/look-same --old <main's build> --new <the port's build> --pages <list> --out <dir> --ignore-attr data-tina-field,data-tina-island --mask-ids auto
```

If an element varies from run to run on the old site itself (a wordmark fitted to its box
while the display font loads), add `--css '<rules>'` to hide it or pin its size on both
sides (caracms-adopt → section 9).

**A 1px crop difference on a responsive image** is a known cause of a small pixel share.
caracms rounds each srcset width's crop height from the ratio, while an Astro `getImage()`
site scaled every width from the top width's rounded height (1280 × 875 where caracms
draws 1280 × 876 at 962:658). Match it in the site, not in caracms: one port reads
the image's ratio in a helper of its own and keeps the design ratio in the frame's CSS.

Passing means a pixel share of 0.00% and no height change at both widths, and the same
status on both sides (a hidden page answers 404 on both). Review the HTML diff: every
difference should be one the rewrite explains (caracms's wrappers, Tina's attributes
gone).

## 12. Model it for the editor

The script copies Tina's shape one to one, and Tina's shape was built around Tina: an
order number on every entry, a toggle to show or hide one, a collection for every list, a
dropdown over icons in the site's code. Left alone, the agency can't find, sort or swap
what a section shows. So once the conversion is right and look-same passes, go through the
site against `caracms-blocks` → Where content lives and Fields, and change what breaks
them. What a template site usually has:

| Tina's shape | Becomes |
|---|---|
| An `order` number field on a collection | `order: 'manual'` on the collection, its order seeded from the numbers, the field gone |
| A collection with no pages of its own that only one block reads (a marquee's logos, an FAQ) | that block's own `list()`; the collection goes |
| A "featured" toggle or an order number that decides what one block shows | a picker list on that block, in the order it shows them |
| A select over icons drawn in the site's code | an image field, the old files uploaded (caracms-adopt → the card's icon) |
| Labels that name the code ("Variant B") | what the editor sees; `help` says the design's limits |

Keep a toggle the site's code really reads to decide what's live (a job that's open, which
a form's `source` filters by with `where`): that one is content.

Change the config, the content and the components together, a collection at a time, and
run look-same after: re-modelling changes where the agency edits, never what visitors see.
`npx caracms audit` then names what's still unreachable (its one-reader line is the second
row of the table).
