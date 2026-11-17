---
name: caracms-content
description: Change a caracms site's content — the JSON files in content/ (pages, collection documents, shared blocks, Site Settings), rich text, images, references, adding an editor — and get it merged with a pull request after `caracms validate`. Use whenever a task adds, edits, moves or deletes content on a site that has caracms.config.ts.
---

# Changing content on a caracms site

The site's content is JSON files in the repo. The site builds from them, and editors change
the same files through the editor at `/admin`. What a file may hold is set by
`caracms.config.ts`: its collections, blocks and fields. Read it first; it's the schema.

**Write files the way the editor saves them:** two-space JSON with a trailing newline, one
member per line, a string array, a media value and each rich-text block on one line of
their own. Otherwise the editor's next save reformats the whole file. `validate` warns on
a file that's laid out otherwise, and `validate --fix` rewrites it the editor's way
(whitespace only: every key stays where it is, every value as it is).

## Where things are

- **Collections** are in `caracms.config.ts` → `collections`, each with a `folder`.
  - `kind: 'sections'`: a page is a title and a list of blocks. With `nested: true`
    (the usual `pages` collection at `urlBase: '/'`), the file's path is the address:
    `content/pages/about.json` is `/about`, `content/pages/services/print.json` is
    `/services/print`, and `content/pages/index.json` is Home. An `index.json` anywhere
    deeper is an error: `/services` itself is `content/pages/services.json`.
  - `kind: 'fields'`: each document is a title plus the collection's `fields`.
  - **A collection with pages gets its address from one of three places:**

    | Source | In the config | In the content | A document's address |
    |---|---|---|---|
    | Pageless | no `urlBase` | none | none: entries more than one place shows (people listed on several pages) |
    | A prefix in code | `urlBase: '/tags/'` | none | `urlBase` + slug: `content/tags/news.json` is `/tags/news` |
    | Held by a page | `heldBy: 'pages'` | the page's file says `"holds": "journal"` | the page's address + `/` + slug: with `content/pages/journal.json` holding it, `content/journal/a-day.json` is `/journal/a-day` |

    A held collection's posts follow their page: move the page to `/blog` and they are at
    `/blog/<slug>`. Only the config's `heldBy` and the page's `"holds"` say so, and
    they must agree (`validate` errors when they don't). One catch-all route
    (`src/pages/[...path].astro`) serves all three through `addressedDocuments` from
    `caracms/content`; a collection needs no route of its own.
- **Shared blocks** (pieces that repeat across pages: the header, the footer, a call to
  action): `content/shared/<name>.json` (or the config's `sharedFolder`). A header or
  footer (a block type with a `slot`) is never placed in a page's `blocks`: one per slot
  says `"default": true` (between `title` and `block`), and a page that shows another says
  so with `"frame": { "footer": "<name>" }` after `title`, `hidden` and `holds`.
- **Site Settings**: `content/site-settings.json`, one file.
- **Schemas**: `schemas/<collection>.schema.json`, `schemas/shared.schema.json`,
  `schemas/site-settings.schema.json`, generated from the config. Every content file's
  first key is `"$schema"`, the relative path to its schema
  (`"../../schemas/pages.schema.json"`). Never edit `schemas/` by hand; `caracms schemas`
  writes it.

File names are lower case words with hyphens (`about-us.json`), since they're addresses.

## The file shapes

A page (`sections`):

```json
{
  "$schema": "../../schemas/pages.schema.json",
  "title": "About",
  "blocks": [
    { "type": "hero", "heading": ["A small studio", "with big ideas"], "intro": "Six people." },
    { "type": "text", "heading": "How we work", "body": "One team from start to launch." },
    { "shared": "start-a-project" }
  ]
}
```

- `title` is required. It names the page in the editor and in the browser's title
  (`<title> · <brand name>`, unless `seo.title` is set; the config's `titleSeparator` can
  make the ` · ` another separator); it isn't necessarily drawn on the page. The home page
  is the exception: its title is its own `seo.title`, else Site Settings' `seo.title`, else
  the brand name (the document's `title` only when all of those are empty). With the
  config's `titleFallback: 'site'`, every page falls back that way, not only the home page.
- Each block is `{ "type": <a key of the config's blocks>, ...its fields }`. A field left
  out reads as empty.
- `{ "shared": "<name>" }` places the shared block `content/shared/<name>.json` there.
- If the collection has `fields` of its own (page fields), they're top-level keys after
  `title` and before `blocks`.
- A page that holds a collection says so with `"holds": "<collection key>"`, after `title`
  (and `hidden`) and before the page fields, `seo` and `blocks`. Only a page of the
  collection the held collection's `heldBy` names can hold one, never Home, one page per
  collection and one collection per page. Don't put it anywhere else.
- An optional `"seo": { "title", "description", "image" }` sets the page's search and
  share text; leave it out to use Site Settings' defaults.

A fields document: `{ "$schema", "title", ...fields }`, keys in the config's order.

A shared block: `{ "$schema": "../../schemas/shared.schema.json", "title": "Start a project", "block": { "type": "cta", ... } }`.

## Field values

Match each field's kind in the config (`text()`, `richText()`, …):

| Field | Stored as |
|---|---|
| `text()` | `"a string"`; with `multiline: true`, `\n` between lines |
| `lockup({ style })` | lines: `["A small studio", "with big ideas"]`, or with phone lines `{ "lines": [...], "phone": [...] }` |
| `select({ options })` | one option's `value` |
| `richText()` | a list, below |
| `link()` | `{ "label": "Contact us", "href": "/contact" }` |
| `link({ addressOnly: true })` | `{ "href": "/contact" }` |
| `buttons({ styles })` | `[{ "label", "href", "style": <a style's value> }]` |
| `toggle()` | `true` / `false` |
| `number()` | a number |
| `date()` | `"2026-10-21"` |
| `media()` | an image or a clip, below |
| `reference({ to })` | the referenced document's path in that collection, as a string: `"high-street-coffee"` |
| `list(field)` | an array of that field's values |
| `list({ a: …, b: … })` | an array of objects, keys in the config's order |
| `group({ … })` | one object, keys in the config's order |

**Links** (`href`, in links and buttons) are a `/path` on the site, a full `https://` URL,
`mailto:someone@example.com`, `tel:+353…`, or a fragment: `#anchor`, or `#` alone (a
placeholder). Anything else shows as plain text.

**Rich text** is a list of single-key objects:

```json
"body": [
  { "p": "We drew the letters from the old **ferry signs**, see [the print work](/services/print)." },
  { "h2": "From the harbour wall" },
  { "ul": ["First point", "Second point"] },
  { "ol": ["Step one", "Step two"] }
]
```

- `p`, `ul` and `ol` always; `h2` and `h3` only if the field allows them
  (`richText({ headings: ['h2'] })`); never `h1`.
- Inline: `**bold**`, `*italic*`, `[text](href)` (unless the field has `links: false`),
  `\n` for a line break. Marks open and close inside one paragraph, heading or list item.
  Write a literal `*`, `[`, `]` or `\` as `\*`, `\[`, `\]`, `\\`.

**Images** are `{ "key": "uploads/1fb083002e3a/harbour-wall.jpg", "alt": "The harbour wall at dusk", "w": 4000, "h": 2667 }`,
optionally `"focal": [0.4, 0.3]` (the point to keep in a crop, from the left and the top,
0–1) or `"decorative": true` (then `"alt": ""`).

- The `key` must already be in the site's media library. **You can't upload from a
  content change.** Reuse a key that's already in the content, or ask a person to upload
  the image in the editor (or a developer to run `caracms media import`, which prints the
  key, `w` and `h`).
- Give every image its `w` and `h`. Without them it still renders, but the page can't keep
  its space while it loads, and `validate` warns. `caracms media import <the image's file>`
  prints them (an image already in the bucket isn't uploaded again). A file's key (a PDF
  in a media slot) needs no size.
- `alt` says what the image shows, for someone who can't see it.
- A clip (a Mux video) is `{ "video": "<playback ID>", "play": "loop" | "player" }`; only
  the editor makes those.

## Site Settings

`content/site-settings.json` holds:

- `editors`: the email addresses that can sign in to the editor. **To add a person,** add
  their address to this list.
- `brand`: `name` (the site's name in the editor and in titles) and `accent` (`#rrggbb`).
  The logo and icon are uploaded in the editor.
- `seo` (the default search title, description and share image), `googleTag`
  (`G-…` or `GTM-…`), `formRecipients` (`{ "<form id>": ["someone@example.com"] }`),
  `redirects` (`[{ "from": "/old", "to": "/new" }]`).
- `collectionOrder`: each `order: 'manual'` collection's hand order
  (`{ "<collection>": ["<path>", …] }`, first to last; an entry it doesn't name comes after,
  A–Z). `pageOrder` and `pageFolders` are the Pages tree's, written by Arrange (below).
- `formWords`: each form's words, only the ones changed from the config's
  (`{ "<form id>": { "fields": { "<field>": { "label": "Name" } }, "submit": "Send it" } }`).
  A blank or missing word uses the site code's, the config's or the package's.
- The site's own fields, from `caracms.config.ts` → `settings.fields` (contact details,
  social links…). A menu or footer links are the header's or footer's shared block.

### The Pages tree's order and folders

The editor's Arrange pages… screen writes these; a port can write them by hand. Neither
ever changes an address: they're how the Pages tree reads, nothing more.

- `pageOrder`: `{ "<level>": ["<slug>", …] }`, each level's rows first to last. A level is
  a parent's path (`""` for the top level, `"services"` for the pages under /services).
  Home always comes first; a row the list doesn't name comes after the listed ones.
- `pageFolders`: `{ "<level>": [{ "id": "<id>", "name": "<name>", "pages": ["<slug>", …] }, …] }`,
  each level's folders: a label editors file pages under, with no part in the address
  (`/about` filed in a Company folder is still `/about`). Use a group (a folder of files in
  `content/pages/`) when the address should change instead.
  - `id` is made from the name by the slug rules (`Our company` → `our-company`) and kept
    when the folder is renamed. Two folders at a level can't share one.
  - `name` is 1–60 characters, shown in the tree.
  - `pages` are slugs at that level (pages or groups), in the folder's order. A folder holds
    only its own level's rows, never another folder: no folders inside folders. Home
    (`index`) is never filed, and a slug goes in one folder only.
  - A folder's place is its token `(<id>)` in its level's `pageOrder` list. A filed page
    isn't listed there itself: the folder gives it its place. With no token, the folder
    comes after the listed rows.

Filing About and Contact in a Company folder, placed between Work and Journal:

```json
"pageOrder": { "": ["work", "(company)", "journal"] },
"pageFolders": { "": [{ "id": "company", "name": "Company", "pages": ["about", "contact"] }] }
```

`caracms validate` checks both: a wrong shape is an error; a slug that names nothing,
`index` in a folder, a slug in two folders or both in a folder and its level's list, an
empty folder, a token naming no folder and a level with no pages are warnings, and
`caracms validate --fix` prunes them.

## Moving or deleting a page

Prefer the editor for these: it updates links to the page and adds a redirect. By hand:
rename or delete the file, fix every `href` and `reference` that pointed at it (search
`content/` for the old address and path), and for a page that was public add
`{ "from": "/old-address", "to": "/new-address" }` to Site Settings' `redirects`.

**A page that holds a collection takes its documents with it**, and so does every page
under it: in the editor, Change address… moves them all and adds a redirect for each old
address. By hand, the held documents' files don't move (their address is the page's plus
the slug), but every `href` to each of them changes and each old address that was public
needs its own `redirects` entry. A holder can't be deleted while it holds: take its
`"holds"` line out first, or move the documents to another page.

A page can't go at an address the site's own code serves (a route in `src/pages/`), at
a held document's address (`/journal/a-day`), or at `/admin`, `/_caracms` or `/files`.

## Choosing blocks for a page

**Read the page component before choosing** (the config's `page`, usually
`src/components/caracms/Page.astro`). How a page looks around its blocks can depend on
what it's made of: the header's colour or variant, `<main>`'s classes or an intro can
follow from the page's first block (a map keyed by block type), or from a page field (a
key after `title`). Pick the first block and the page fields for the look the page should
have, and compare with an existing page that looks that way.

**When no block fits the content,** a content change can't make one: blocks are code, and
code is the `caracms-blocks` skill's. Don't bend a block that doesn't fit (a heading
squeezed into a plain text field), and don't write a component as part of a content
change. Either:

- say in the pull request what's missing and what you used instead, or
- make the block first, as a separate change with the `caracms-blocks` skill, then the
  content on top of it.

Either way, tell the person who asked: they may want the block, or a different page.

## Getting it merged

1. **Work on a new branch** off the site's main branch, and open a pull request into it.
   Never commit to `main` directly.
2. **Never touch the `drafts` branch.** It's the editor's: it holds editors' unpublished
   changes, and publishing from the editor commits to `main`. Don't push to it, merge it
   or base work on it.
3. **Run `npx caracms validate` from the site's root before you open the pull request**
   (with pnpm, `pnpm caracms validate`). It checks every content file against
   `caracms.config.ts`:
   - Each problem is a line `file › path.in.the.json: what's wrong`, under `Errors:` or
     `Warnings:`. It exits 1 when there are errors. Fix every error.
   - Warnings (a missing `$schema`, schema files out of date, a heading too long for its
     box, an unknown select value, an image with no `w` or `h`, a file the editor's save
     would reformat) don't break anything, but fix the ones you caused.
   - `npx caracms validate --fix` writes the schemas, adds any missing `$schema` keys and
     lays out each file as the editor saves it, changing only whitespace (that's all it
     fixes). `--json` prints `{ "errors": [...], "warnings": [...] }`,
     each `{ "file", "path", "message" }`.
4. Keep the pull request to content (`content/`, and `schemas/` if `--fix` changed it).
   Changing blocks or the config is the `caracms-blocks` skill's, in a change of its own
   (see Choosing blocks for a page).

The site builds from these files, so a merged content change is live on the next deploy.
