---
name: caracms-blocks
description: Build or change a caracms site's code — blocks and their fields, collections (with or without pages), text styles and lockups, Site Settings fields, the page component, forms, and how the site's scripts (GSAP, Lenis, carousels) behave in the editor's live preview. Use when editing caracms.config.ts or the Astro components it names.
---

# Building blocks and collections

`caracms.config.ts` is everything caracms knows about the site. It's plain data: fields
are made with helpers from `caracms/config`, and components are named by their path from
the site's root (strings, never imports). `astro.config` passes it to the integration
(`integrations: [caracms(site)]`). A mistake in it stops `astro dev` and `astro build`
with a sentence naming the problem.

```ts
import { defineSite, list, richText, text } from 'caracms/config';

export default defineSite({
	collections: {
		pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true },
	},
	blocks: {
		faq: {
			label: 'Questions',
			component: 'src/components/caracms/Faq.astro',
			fields: {
				heading: text({ heading: true }),
				items: list({ question: text(), answer: richText() }, { itemLabel: 'question' }),
			},
		},
	},
	textStyles: {},
	page: 'src/components/caracms/Page.astro',
});
```

A block's `type` in the content is its key here, so **never rename a block key or a field
key** once content uses it: the content would stop matching. Add new ones instead.

After changing the config, run `npx caracms schemas` (or `validate --fix`) so `schemas/`
and the content's `$schema` keys match, and commit `schemas/` with the change.
`astro dev` rewrites the schema files when it starts or restarts, but never touches
content. **Restart `astro dev` after changing the config** (a new block type, a slot, a
collection's options): until it restarts, the editor keeps the old fields and pickers, and
a shared block of a type it doesn't know yet shows as missing.

## Where content lives

Decide this before adding a field. The editor opens each piece where the agency expects it,
so the same kind of content always lives in the same place:

| Lives in | What | For example |
|---|---|---|
| **Shared** (`content/shared/`) | pieces that repeat across pages | the header (its menu), the footer (its link columns), a "Start a project" call to action |
| **Site Settings** | setup, and details more than one piece shows | the phone, email, address and socials the footer *and* the Contact page show |
| **A collection** | entries shown whole (a page each), or in more than one place | case studies, the journal, a team with its own bio pages |
| **The block** (a `list()`) | data one block shows, in an order of its own | Home's picked case studies, a client marquee, an FAQ, a team grid only one page shows |

- **A header or footer is a shared block even when the site has one.** It fills a slot
  (The page component → Slots). Versions a page picks between (a dark footer for some
  pages) are more shared blocks of the same slot, never a collection or groups in Site
  Settings.
- **An FAQ or a logo strip one block shows is that block's list**, not a collection the
  block reads: a pageless collection is for entries shown in more than one place.
- **Choosing and ordering happen where it's shown.** What Home features is a picker list
  on Home's block (`list(reference(…))`), dragged into order; never a "Featured" toggle
  and an order number on each entry, which also reorders every other list.
- **A collection the site lists in one order gets a hand order** (`order: 'manual'`,
  Collections below), never an `order` number field.
- **Don't tie words to another document's title** where the agency will want to say it
  differently: a row of word + link, not a list of references.
- **A card's icon is an image field**, never a select over icons in the site's code: the
  designer uploads or swaps one, and the block sizes it in a fixed box.
- **`help` says the design's limits** ("2 to 6 cards", "no longer than DIGITAL MARKETING"),
  and labels say what a thing is, never its name in the code.
- **The preview shows what the page hides.** Content behind an interaction (closed
  folders, covered tiles, other tabs) is shown open in a preview by CSS under
  `[data-preview]` (caracms-adopt → the preview), so every item can be clicked and edited.

## Fields

All from `caracms/config`. Every one takes `label` (default: the key, title-cased) and
`help` (a line under the field in the editor).

| Helper | Options | The component gets |
|---|---|---|
| `text()` | `multiline`, `heading` (it can hold the page's `h1`), `max` (a soft limit) | `string` |
| `lockup({ style })` | `style`: a key of `textStyles`; `heading` (default true) | `{ lines, phone }` |
| `select({ options })` | `options`: strings or `{ value, label }`; `default` (else the first) | the value |
| `richText()` | `headings: ['h2']` or `['h2', 'h3']` (default none); `links` (default true) | rich text, for `<RichText>` |
| `link()` | `addressOnly: true` for an address with no words | `{ label, href }`, or `{ href }` / `null` |
| `buttons({ styles })` | `styles` (strings or `{ value, label }`), `max` (default 2), `allowNoLink` | `[{ label, href, style }]` |
| `toggle()` | `default` | `boolean` |
| `number()` | `min`, `max`, `step` | `number \| null` |
| `date()` | | `"YYYY-MM-DD"` or `null` |
| `media()` | `only: 'image'` or `'video'`; `play: 'loop'`; `format: 'png'`; `altFrom` (a text field beside it) | for `<Media>` |
| `reference({ to })` | `to`: a collection's key | the document's path, or `null` if it's gone |
| `list(field)` / `list({ … })` | `itemLabel`, `itemNoun` (what one row is called, "person" for a list labelled People), `min`, `max` (warned, never enforced) | an array |
| `group({ … })` | | one object |

- `media({ altFrom: 'capture' })`: an image placed (picked or uploaded) with no alt text
  starts with the words of `capture`, a `text()` field beside it in the same block, group or
  list row. Only an empty alt is filled, and only at placing; the editor can change it after.
  `altFrom` naming anything but a sibling text field stops the build with a sentence.
- A list of several fields may hold one list among its fields; that inner list can't hold
  a list. A group can't hold a group.
- Type a component's data from the schema:
  `export type FaqData = BlockData<typeof faq.fields>;` (keep the block's config in a
  `.ts` beside its component and import it into `caracms.config.ts`).

## A block component

```astro
---
import Block from 'caracms/components/Block.astro';
import RichText from 'caracms/components/RichText.astro';
import Text from 'caracms/components/Text.astro';
import type { BlockProps } from 'caracms/document';
import type { FaqData } from './faq.ts';

type Props = BlockProps<FaqData>;
const { block, cms } = Astro.props;
---

<Block cms={cms} class="faq">
	<Text cms={cms} field="heading" value={block.heading} class="faq-title" />
	{block.items.map((item, i) => (
		<details>
			<summary><Text cms={cms} field={`items.${i}.question`} value={item.question} as="h3" /></summary>
			<RichText cms={cms} field={`items.${i}.answer`} value={item.answer} class="prose" />
		</details>
	))}
</Block>
```

- **Wrap the block in `<Block cms={cms}>`** (`as` sets the element, default `section`;
  `class` and other attributes pass through). In the editor's preview it marks the block
  so it can be selected.
- **Attributes pass through as on a plain element**, on `Block`, `Text`, `RichText`,
  `Lockup`, `Buttons`, `Link` and `Media`: a bare `data-hero` renders bare, and so does
  an HTML boolean attribute (`<Block as="form" novalidate>`, `hidden`, `open`, `disabled`,
  `required`); `hidden={false}` renders nothing. `aria-*`, `draggable`, `contenteditable`,
  `spellcheck` and `writingsuggestions` keep their `"true"` / `"false"` values.
- **Whitespace in a slot**: Astro's compiler drops the space between an expression and an
  element in any component's slot, so `<Link …>{label} <span>→</span></Link>` loses it.
  Write `{label}{" "}<span>→</span>`.
- **Draw every field through the package's component for its kind**, with `field` (its
  key, or a dotted path into a list: `items.0.question`) and `value`. In the preview they
  carry the markers that make text editable on the page; on the public page they're plain
  markup. Each takes `class` and `as` (the element) and passes other attributes on.
  - `Text`: a `<p>`, or `h1`/`h2` for a `heading: true` field (the page's first heading is
    the `h1`). `as` overrides that. It always renders its element, since the editor
    needs one to edit, so text that was a bare text node gains one: use the element the
    old markup had where it had one (`as="span"` inside a sentence).
  - `Lockup`: a lockup in its text style, fitted to its box.
  - `RichText`: a `<div>` of the rich text's HTML.
  - `Link`: an `<a>` holding the label (or what you put inside `<Link>`); a link with no
    label or no address draws nothing. An address-only link wraps what's inside it (an
    image, an icon). An address-only link's value is `{ href }`, or `null` when it's
    empty or isn't a valid address; handle `null` in your own markup (draw no link), never
    fall back to `href=""`. A valid address is a `/path`, `https://`, `mailto:`, `tel:`,
    `#id`, or `#` alone.
  - `Buttons`: the buttons, each with `buttonClass` and `<buttonClass>--<style>`.
  - `Media`: exactly one `<img>` (or the clip). Pass `sizes` (and optionally `ratio`,
    width / height) for a fluid image, or a CSS `width` and/or `height` for a fixed one;
    `fit: 'contain'` to fit instead of crop. The block's CSS sizes it through `class`.
    It takes the element's own attributes (`id`, `title`, `draggable`, `aria-*`,
    `data-*`) too. With an empty value it draws nothing for visitors and, in a preview,
    a dashed placeholder the editor can click to pick the image. So call it as
    `(block.media || cms.preview) && <Media …/>`, not `block.media && …`, wherever an
    empty slot should still be reachable on the page.
  - **A media value reaches the block resolved, not as stored.** Where the file has
    `{ key, alt, focal, w, h }` or `{ video, play, poster: 12.5 }`, the block gets
    `{ kind: 'image', key, alt, decorative, focal, position, w, h }` or
    `{ kind: 'video', playbackId, play, name, mp4, poster: <url>, duration, w, h }`
    (`poster` is Mux's still as a URL, `w`, `h` and `duration` are numbers or `null`;
    `block.media` is `null` when the slot is empty). A site helper that reads a media
    value (a hero's poster, a video's `playbackId`) reads this shape; use `kind` to tell
    the two apart.
- `cms` is the render context: `cms.preview` (a preview render), `cms.first`,
  `cms.index`, `cms.read` (other documents, below). For "the first block on the page"
  (an eager hero, a heading that opens the page) use `cms.first`, true for the first
  block that renders. Not `cms.index === 0`: `index` is the entry's place in the
  document's `blocks`, counting entries that don't render (an unknown type, a shared block
  that's gone). `headingTag(cms, 'heading')` from
  `caracms/document` gives `'h1'` or `'h2'` for markup of your own.
- In a preview, draw empty fields too (`cms.preview || block.heading`), so an editor can
  click into them.

### Block states

A block a visitor sees in more than one way (a form once it's sent, a step of a
calculator) names its other states on its config, key → the label the editor shows:

```ts
export const formBlock = {
	label: 'Form',
	component: 'src/blocks/Form.astro',
	states: { sent: 'Sent', error: 'Couldn’t send', invalid: 'Invalid' },
	fields: { … },
} satisfies BlockConfig;
```

While the block is selected, a switch over the preview shows each state ("First look",
then the block's own). The component draws the chosen one **on the server**: `cms.state`
is the chosen key for that block, and `null` everywhere else (every other block, the
public page, a build). No script runs to reach a state, so write each state's markup in
the component, its words as ordinary marked fields, so they're typed on the page like any
other:

```astro
{cms.state === 'sent' ? <Text cms={cms} field="sentHeading" value={block.sentHeading} as="h3" /> : <form>…</form>}
```

A state is a view: never saved, never published, gone when another block is selected.
The package's `<Form>` draws its own states from `state={cms.state}` (Forms, below).

## Collections

A collection with pages gets its address from exactly one of three places:

| Source | In the config | In the content | A document's address |
|---|---|---|---|
| **Pageless** | no `urlBase` | none | none: entries more than one place shows (people on About and on each case study) |
| **A prefix in code** | `urlBase: '/tags/'` | none | `urlBase` + slug, with no page at the prefix |
| **Held by a page** | `heldBy: 'pages'` | the page's file says `"holds": "journal"` | the page's address + `/` + slug; move the page and they follow |

```ts
// Held by a page: the Work page's file says "holds": "work", so a case study is at /work/<slug>
work: { kind: 'fields', folder: 'content/work', heldBy: 'pages', component: 'src/components/caracms/CaseStudy.astro', fields: { … } },
// A second section builder, held by the Journal page ("holds": "journal"): posts at /journal/<slug>
journal: { kind: 'sections', folder: 'content/journal', heldBy: 'pages', fields: { date: date() }, blocks: ['text', 'image'] },
// A prefix in code, with no Tags page: /tags/<slug>
tags: { kind: 'sections', folder: 'content/tags', urlBase: '/tags/' },
// A collection with no pages (people several pages list): leave out urlBase and heldBy
people: { kind: 'fields', folder: 'content/people', component: 'src/components/caracms/Person.astro', fields: { role: text(), photo: media({ only: 'image' }) } },
```

- **`heldBy` names the nested section builder whose page holds the collection** (`'pages'`),
  and is exclusive with `urlBase`. The held collection is flat (not `nested`), either
  kind. The mount is in the content, not here: one page of `pages` says
  `"holds": "journal"` (a document key after `title` and `hidden`; the editor shows it
  on the page and doesn't change it), one collection per page and one page per
  collection, never Home. Until a page holds it the collection has no addresses; `caracms validate` errors
  on a collection no page holds, two pages holding one, and a `holds` anywhere else.
- A `fields` collection's `component` renders one document: it gets
  `{ document, cms }` (`FieldsDocumentProps` from `caracms/document`), with
  `document.title` and each field's value; draw fields with `field="<key>"`. The page
  component's `<Blocks>` renders it. For a pageless collection that's only the editor's
  preview of one document.
- `title` is every document's own; no field can be called `title` (or, on a `sections`
  collection, `blocks` or `seo`).
- Options: `label`, `columns` and `sort` (the editor's table), `order: 'manual'` (below),
  `view` (`{ default: 'list' | 'grid' }`), and on a `sections` collection `fields` (page
  fields) and `blocks` (the block types its pages may use).
- **A hand order: `order: 'manual'`.** For a flat collection whose entries the site shows in
  an order an editor picks (case studies, people): the agency drags them in the collection's
  list in the sidebar (⌥↑ / ⌥↓ from the keyboard), the order is kept in Site Settings
  (`collectionOrder`), a new entry goes first, and `cms.read.documents()` returns them in it.
  Not with `sort`, and not on a nested collection (Pages have Arrange). **Never add an
  `order` number field** to order entries: that's what this replaces.
- **Show a pageless collection** from a block: `await cms.read.documents('people')` gives
  every document as `{ path, title, data }` (`data` is its fields' values, as a component
  gets them), **ordered by title**, or in the hand order with `order: 'manual'` (hidden
  entries are left out, the rest keep their places). To let a page pick some and order
  them, `list(reference({ to: 'people' }))`. `cms.read.document('people', path)` reads one.
  Mark what you draw from an entry as that entry's (Marking sources, below).
- **Routes: one catch-all serves every document with an address.** `src/pages/[...path].astro`
  (`caracms init` writes it) builds from `addressedDocuments(site)` in `caracms/content`,
  which lists `{ collection, path, url }` for every public page of Pages, every held
  collection and every prefix collection, and renders with `RenderDocument` from
  `caracms/components/RenderDocument.astro` and `readDocument`. A site that renders on
  demand asks `documentAt(site, pathname)` for the document at a request path (or
  `null`). Both leave out entries with a `warning` (a file that can't be opened) and
  `hidden` ones (a page hidden from the site, one under it, and the documents of a hidden
  holder): those answer the 404 page. **Don't write a route per collection.** A collection
  doesn't need `src/pages/work/[slug].astro`, and one left at a held collection's address
  is a `validate` error. A prefix collection that keeps its own route file
  (`src/pages/tags/[slug].astro`) is left out of the reader, so the page is never built
  twice. Every other route in `src/pages/` is the site's own code, and its address can't
  hold a document.
- Shared blocks (`content/shared/`) and Site Settings are built in; no config.

## Site Settings fields

```ts
settings: { fields: { contact: group({ email: text(), phone: text(), address: text({ multiline: true }) }) } },
```

Only setup and details more than one piece shows (Where content lives): contact details,
socials. A menu or footer links belong to the header's or footer's shared block. They're
edited under Site Settings and saved in `content/site-settings.json`, beside the
package's own keys (`title`, `editors`, `brand`, `seo`, `googleTag`, `formRecipients`,
`redirects`, `pageOrder`, `pageFolders`, `collectionOrder`, `formWords`, which a field can't be called). The page component gets them as
`Astro.props.settings` (plus `settings.brand.name`). A preview shows the draft.

The site's own `.astro` routes get the same object from `siteSettings`, and blocks too:

```astro
---
import { siteSettings } from 'caracms/content';
import { site } from 'virtual:caracms/config';
const settings = await siteSettings(site, Astro.locals);
---
```

**A block that needs Site Settings** (a footer, a contact block showing the phone number)
reads them the same way, with `siteSettings(site, Astro.locals)`: in a preview it reads the
editor's draft, so an edit to Site Settings shows in the block too, and marks them with
`cms.settings` (Marking sources). `cms.read` is for collections only; it doesn't reach Site
Settings.

## Text styles and lockups

A lockup is a heading whose lines are set by the editor and fitted to their box in a
text style. A style, in `textStyles`:

```ts
display: {
	family: 'Site Display', cssVariable: '--font-display',
	fontFile: { measure: 'src/fonts/Display.ttf', web: 'src/fonts/Display.woff2' },
	weightRange: '400 700', axes: { wght: 600 },
	sizePx: 96, minSizePx: 40, trackingEm: -0.02, leading: 1, textTransform: 'none',
},
```

`measure` must be a TTF or OTF; `axes` pins every variable axis (`{}` for a static font).
`<Fonts />` in the page's `<head>` loads the styles' fonts. `phoneLinesWidth` (default
640) is where a lockup's phone lines take over. A plain heading that doesn't need fitting
is simpler as `text({ heading: true })` in the site's own CSS.

## The page component

The config's `page` renders a whole page from a document, for the public site and the
editor's preview alike. It gets `PageProps` (`caracms/document`): `document`,
`collection`, `path`, `preview`, `data` (the document's own fields), `settings`,
`listPage`, `read`, and two contexts for marking: `cms` (the page's own fields) and
`settingsCms` (Site Settings'), both in Marking sources below.

```astro
---
import Slot from 'caracms/components/Slot.astro';
// … Head, Fonts, Blocks
const { document, collection, path, preview, listPage } = Astro.props;
---
<html lang="en" data-preview={preview ? '' : undefined}>
	<head>
		<Head document={document} collection={collection} path={path} preview={preview} listPage={listPage} />
		<Fonts />
	</head>
	<body>
		<Slot name="header" {...Astro.props} />
		<main><Blocks document={document} collection={collection} preview={preview} listPage={listPage} /></main>
		<Slot name="footer" {...Astro.props} />
	</body>
</html>
```

- `path` (`string | null`) is the document's address (`/`, `/about`,
  `/work/high-street-coffee`), the same on the public page and in the editor's preview: no
  trailing slash, not URL-encoded. Page 2 of a paged listing (`/journal/page/2`) gives its
  document's `/journal` (`listPage` says which page). It's null when the document has no
  page of its own (a shared block's preview, a collection without pages). Read it as
  `const { path } = Astro.props`, never from `Astro.url` or `?path=`: in the preview those
  are the editor's own address. Pass it on as `<Head path={path}>` (it's optional there);
  `caracms init`'s page component does.
- `<Head>` (`caracms/components/Head.astro`) writes the title, description, canonical and
  share tags. A page's title is its own `seo.title` as written; otherwise, on the home
  page, Site Settings' `seo.title`, then the brand name; otherwise
  `<document title> · <brand name>`. (A home title like `<brand> | <tagline>` goes in the
  home page's own `seo.title`.) The ` · ` is the
  config's `titleSeparator`, spaces included: `titleSeparator: ' | '` beside `page` in
  `defineSite({ … })` keeps a site's old `About | CaraCMS`. It's code, not a Site
  Settings field: the title's format is design. `titleFallback: 'site'` beside it makes every
  page without its own `seo.title` fall back as the home page does (Site Settings'
  `seo.title`, then the brand name); the default is `'page-and-brand'`. A code route builds its title the same way
  from `siteSettings`: `` `${title}${settings.seo.titleSeparator}${settings.brand.name}` ``. `<Blocks>` renders the blocks (or a fields document through its
  collection's component).
- `document.kind === 'shared'` is a shared block's own preview. `<Slot>` handles it (a
  body block's preview draws no slots; a slot block's draws in its own slot), so the page
  component needs no case for it unless it draws more frame of its own.
- **An image in the frame** from a Site Settings `media()` field: in a slot's block (a
  header logo) it's `<Media cms={cms.settings} field="logo" value={settings.logo} …>`, like
  any field. One a script reads (a mega-menu photo in a `data-` attribute) is a URL from
  `settingsImageUrl` in `caracms/content`:

  ```astro
  ---
  import { settingsImageUrl, siteSettings } from 'caracms/content';
  import { site } from 'virtual:caracms/config';
  const settings = await siteSettings(site, Astro.locals);
  const photo = settingsImageUrl(settings.megaPhoto, { width: 640, height: 400 });
  ---
  <div class="mega" data-image={photo ?? '/images/placeholder.svg'}></div>
  ```

  It gives one URL by `<Media>`'s rules: one side is a `fit`, both are a `fill` cropped to
  the focal point, a GIF or an SVG passes through unresized, no size is a `fit` at 1920. Ask
  for the size it's shown at (twice it for a sharp 2× screen); there's no `srcset`. It's
  null when the field is empty or the media isn't set up, so give the frame a fallback. It
  works in the build, in the editor's preview (the draft's image) and under
  `CARACMS_MEDIA=memory`.

### Slots: the header and footer

A block type that fills the page's frame says which slot: `slot: 'header'` or `'footer'`.
The starter's (`src/blocks/site-footer.ts`, drawn by `Footer.astro`):

```ts
siteFooter: {
	label: 'Footer',
	component: 'src/blocks/Footer.astro',
	slot: 'footer',
	fields: { columns: list({ heading: text(), links: list(link()) }, { itemLabel: 'heading' }) },
},
```

- Its content is a shared block, `content/shared/footer.json`:
  `{ "$schema", "title": "Footer", "default": true, "block": { "type": "siteFooter", … } }`.
  One per slot is the default (`"default": true`, between `title` and `block`); a site with
  one footer has just that one.
- `<Slot name="footer" {...Astro.props} />` in the page component draws the page's pick,
  else the default, through the block's component, and marks it as its shared block. A
  page picks another in its own file, `"frame": { "footer": "footer-dark" }` (the editor
  shows Header and Footer pickers once a slot has more than one block). A pick that's
  missing falls back to the default, with a warning; `caracms validate` reports it.
- **A slot block is never a body block:** a collection's `blocks` naming it is refused, and
  a `{ "shared": … }` body entry naming it is skipped on the page.
- Its component gets `cms.path`, the page's address, for a current-page mark in a menu
  (null on its own preview), and reads Site Settings with `siteSettings()` as any block.
- **It gets only `block` and `cms`**: `<Slot>` passes nothing else on. A value the page
  works out (the nav's colour from the page's first block) reaches it through the request's
  locals, set in the page component or layout before `<Slot>`:
  `Astro.locals.navGround = ground`, read back in the slot block's component.
- **The header's own words go in its block** (the menu's labels, the menu button's name),
  not in Site Settings: they're the header's. Site Settings keeps what more than one piece
  shows (contact details, socials).
- **Drawing the frame's component outside a slot** (a design-system page showing every
  footer) needs that shared block's own context, `cms.of(entry)` for its entry from
  `read.documents('shared')`. A context that doesn't have the field a marker names fails the
  render, on the public page too (`<Block field>: Site Settings has no field "headingLines.0"`).
- A code route drawing the frame itself (not through `RenderDocument`) gets the defaults:
  `<Slot name="footer" settingsCms={siteSettingsContext(site, Astro.locals)} />`, with
  `siteSettingsContext` from `caracms/content`.

### Marking sources

A block's own fields are marked by `<Text cms={cms} field="…">` and the rest. What a block
draws from **another document** is marked with that document's context, the same way, so a
click opens that document over the page:

| Drawing | Context |
|---|---|
| Site Settings' fields, in a block | `cms.settings` |
| Site Settings' fields, in the page component | `Astro.props.settingsCms` |
| An entry read with `cms.read` | `cms.of(entry)` |
| The page's own fields, in the page component | `Astro.props.cms` (a `sections` page's fields; marks nothing elsewhere) |

```astro
<Block cms={cms.of(c.entry)} as="li">            <!-- the card is the case study's -->
	<Media cms={cms.of(c.entry)} field="cover" value={c.data.cover} sizes={COVER_SIZES} />
	<b>{c.title}</b>                              <!-- a title is never marked -->
</Block>
<Text cms={cms.settings} field="contact.phone" value={settings.contact.phone} as="span" />
```

- `<Block cms={…}>` with a source context marks a sourced root (the card above): a click on
  it outside a field opens that document at its form's top. The page component wraps the
  page fields it draws (a case study's hero) in `<Block cms={cms} as="header">`.
- **Text the site draws differently from its value** (a heading whose full stop is a brand
  dot, an email with `<wbr>` breaks, a select drawn as its label) is marked without the
  package drawing it: `<Block cms={…} field="…" as="…">`, with the site's own markup inside.
  A click picks the field in the sidebar; nothing is typed on the page. Works with any
  context. The starter's footer:

  ```astro
  <Block cms={cms.settings} field="contact.email" as="a" href={link.href}>
  	{parts.map((part, i) => (i > 0 ? <><wbr />{part}</> : part))}
  </Block>
  ```
- **A document's title is never marked.** It's edited at the top of its form.
- **The site's name (`brand.name`) is Site Settings' own, not a field:**
  `<Block cms={cms.settings} field="brand.name">` fails the render. Draw it inside a
  Site Settings root instead, `<Block cms={cms.settings} as="span">{name}</Block>`, which a
  click opens and audit counts as held. A copyright line also holds a year from code, so
  give that root `data-cms-fixed` (below): `` {`© ${year} ${name}`} `` as one expression, since
  a component's slot drops the space between two.
- Links in the frame (a menu, footer columns) stay unmarked, so they keep following. A menu
  built in code is fine: its labels can be the slot's own text fields, drawn inside its
  `<a>`s and `<button>`s, and `caracms audit` counts words in the frame's links (and a
  control's `aria-label`) as on the page. The same words drawn again outside a link inside
  the slot (a no-JS panel's group heading) count too. Words in an attribute anywhere else
  (a `<nav aria-label>`, a script's `data-label-close`) still need marking:
  `<Block cms={cms} field="label" as="nav" aria-label={block.label}>`.
- **Words that are the site's code, on purpose** (a calculator's interface, a widget's
  labels): put `data-cms-fixed` on an element round them. `caracms audit` then leaves them
  out of "words no field holds". It's for words the agency has decided aren't content, not
  for words nobody got round to marking.

## Forms

```ts
forms: {
	contact: { label: 'Contact', email: { subject: 'New enquiry' }, fields: {
		name: { label: 'Your name', autocomplete: 'name' },
		email: { label: 'Email', type: 'email' },
		message: { label: 'Message', type: 'textarea', optional: true },
	} },
},
```

Field `type`s: `text` (default), `email`, `tel`, `textarea`, `select` (with `options`, a
`source`, or both), `files` and `rows` (below). A form's key is stored on every submission, so never rename it once it's live.
Draw it in a block with `<Form form="contact" preview={cms.preview} state={cms.state} />`
(`caracms/components/Form.astro`); a block can offer a choice with
`select({ options: [{ value: 'contact', label: 'Contact' }] })`. Submissions land in the
editor's inbox and are emailed to Site Settings' `formRecipients` for that form.

**A form's words are content, in Site Settings › Forms**: each field's label, placeholder,
help, error and "(optional)", a select's option labels, and the form's button, "Sending…",
sent heading and line, couldn't-send line and "Choose…". Where a word comes from: Site
Settings, then the site's code (`<Form>`'s props below), then the config, then the package.
So the config keeps `label`, `placeholder`, `help`, `error` and option labels as defaults,
and a site that sets nothing reads as it always did. The page, the endpoint's error
sentences, the email and the inbox all read the same words. In the editor's preview the
form's words are typed on the page (a click opens Site Settings over the page at that
word; a placeholder focuses its box in the sidebar), and the form never sends.

**Its states**: a block that shows a form declares `states: { sent: 'Sent', error:
'Couldn’t send', invalid: 'Invalid' }` and passes `state={cms.state}` (Block states,
above). `invalid` shows every required field's error line. With a sent heading (Site
Settings', or `sentHeading`), the form gives way after a send to `.cms-form-sent`, the
heading (`.cms-form-sent-heading`) and the thanks line (`.cms-form-sent-line`); without
one, the thanks line shows in the status line and the form stays.

**A form in the site's own markup** reads the same words with `await cms.formWords('contact')`:
every word resolved, each with the Site Settings field that holds it, so it's drawn
typed on the page under `cms.settings`:

```astro
---
const words = (await cms.formWords('contact', { submit: 'SUBMIT' }))!;
const name = words.fields.name;
---
<label for="name"><Text cms={cms.settings} field={name.label.field} value={name.label.value} as="span" /></label>
<Block cms={cms.settings} field={name.placeholder.field} as="input" id="name" name="name" placeholder={name.placeholder.value} />
<button><Text cms={cms.settings} field={words.submit.field} value={words.submit.value} as="span" /></button>
```

The shape: `{ form, label, fields: { <name>: { label, placeholder, help, error, optional,
options: { <value>: … } } }, submit, sending, sent: { heading, line }, failed, choose }`,
each word `{ value, field }` (`placeholder` null for a type with no box, `optional` null
for a required field). The second argument is the site code's defaults, as `<Form>`'s props.
A field has **one** error line, for left empty or filled in wrong. A site whose own markup
says those differently (an email that's missing, and one that isn't an address) keeps the
second as a field on its block, the one word Forms has no place for. Draw the form's states
on the server from `cms.state` (Block states, above), and keep the site's own form script
out of the preview, so nothing resets the state the editor asked for.
Your own form posts as the package's does: `method="post" action="/_caracms/form"`, the
hidden `form` (its key) and `return` (the page's path) fields, a hidden `fax` honeypot
left empty, and each field by its config name. Prefer `<Form>` with its hooks where the
look allows: it also gets the file limits, the thanks line and Turnstile.

A field can also take `help`, `placeholder` (text, email, tel, textarea; on a select, the
words of its blank first choice, else the form's "Choose…"), `prefix` and `suffix` (text,
tel: a fixed lead-in like "$", and a faint tail like "USD", hidden from screen readers;
config only, never a word), `error` (its own error line), `autocomplete`, and on a textarea
`rows` (its height in lines, 1 to 50; default 6).

**A select that lists a collection** takes `source: { collection: 'jobs' }`, optionally
with `where: '<a toggle field of it>'` (only documents with it on). Each document is a
choice after any fixed `options` (like "Any role"): its value is its path,
its words its title, in the collection's own order (a hand order holds); a fixed value
equal to a path is listed once. The endpoint checks a posted value against the content on
the server's disk at each submission, so a job closed since the page was built is refused
(`<label>: choose one of the options.`). A sourced choice has no word in Site Settings
(edit the document's title). The email and the inbox show a stored path by its document's
title, still after it's closed; one that's gone shows as stored.

**A rows field** holds a list of rows, each a few columns, like an order's product lines:

```ts
orderLines: {
	label: 'Order', type: 'rows', max: 10, rowLabel: 'Product',
	columns: {
		product: { label: 'Product', type: 'select', source: { collection: 'products' } },
		amount: { label: 'Amount', type: 'number', placeholder: 'e.g. 2.5' },
		unit: {
			label: 'Unit', type: 'select',
			options: [{ value: 'tin', label: '5L Tin' }, { value: 'l', label: 'L' }, { value: 'pack', label: 'Pack' }],
			from: { column: 'product', field: 'units', else: ['l', 'pack'] },
		},
	},
},
```

Columns are `select` (fixed `options`, a `source`, or narrowed), `number` (above 0, like 2
or 2.5) and `text`, at most 20, each required within a row; `max` is 1–50 (default 10).
**`from` narrows a column** to the choices the document picked in another column allows:
`field` is a list (of select or of text) on that collection; a listed value that isn't one
of the options is ignored, and `else` applies when none is left (left out: every option).
The server enforces it. A blank row is dropped, not refused; a required rows field needs
one row left. Each refusal names its row by the row word: `Product 2: Unit for Paint is one
of: L, Pack.` Stored, emailed and in the inbox the value is a real list,
`[{ product, amount, unit }]`, every cell text; the email and the inbox show one line per
row ("Paint — 2.5 L", "Primer — 4 × 5L Tin"). On the wire each cell is
`<name>[<i>][<column>]` (or JSON `"<name>": [{ … }]`). A rows field can't be named
`email`, and takes no placeholder or prefix of its own (its columns do).

`<Form>` draws it as a `<fieldset class="cms-form-rows">`: one `.cms-form-row` (its
`.cms-form-row-label`, "Product 1", then a `.cms-form-cell` per column), then
`.cms-form-add` and `.cms-form-at-most`. Without JavaScript it's one row whose narrowed
select offers every option; the package's script adds rows up to `max` (then the at-most
line), a `.cms-form-row-remove` on each from the second, and narrows a column to its row's
pick. Its words are Site Settings › Forms': each column's label, placeholder, error and
option labels, the row word, "Add another", "Remove" and the at-most line (config defaults
`rowLabel`, `add`, `remove`, `atMost`).

In `cms.formWords`, a rows field also has `rowLabel`, `add`, `remove`, `atMost` and
`columns: { <column>: { label, placeholder, error, options } }`; every select (a field or a
column) has `choices: { value, label }[]`, resolved and in order (sourced ones included);
a narrowed column has `allowed: { <document path>: string[] }` (its `else` already
applied) and `else`. So a form drawn in the site's own markup needs no second read of
the collection.

The markup's classes are `.cms-form`, `.cms-form-field`, `.cms-form-label`,
`.cms-form-help`, `.cms-form-error`, `.cms-form-submit` and `.cms-form-status`. For a
site that draws its own look, `<Form>` takes, each optional (left out, it renders as
without them):

- `class`, and any other attribute (`data-reveal`, `id`, `aria-*`), on the `<form>`. The
  form's own attributes (`action`, `method`, its `data-caracms-*`…) can't be replaced.
- `submitClass`: classes on the submit button, beside `cms-form-submit`
  (`submitClass="btn btn-primary"`).
- `submit` (default "Send"), `sending` ("Sending…"), `choose` ("Choose…") and `optional`
  ("(optional)"): the button's and the form's words, under Site Settings'.
- `thanks`: the line after a send, in place of "Thanks, we'll be in touch shortly."
  `sentHeading`: the sent panel's heading (none by default: no panel).
  `failed`: the line when a send fails, in place of "Something went wrong. Please email
  us directly." (when the endpoint gives its own sentence, that shows instead).
- `state`: the block's `cms.state`, so the editor's switch shows the form's states.
- `errors`: each field type's error line, in place of the package's wording:
  `errors={{ email: 'Please check your email address.' }}`. A field's own `error` still wins.
- `actions`: wraps the button and the status line in `<div class="cms-form-actions">`, so
  the site's CSS can set them in a row.
- `labelPlaceholders`: a field that can take a placeholder and sets none uses its label.

```astro
<Form form="contact" preview={cms.preview} class="contact-form" data-reveal
	submitClass="btn btn-primary" thanks="Thanks — we'll be in touch." actions labelPlaceholders />
```

## Scripts and the live preview

The editor shows the page in iframes, through the same page component with
`preview` on. When an editor changes something, the new render is **morphed into the
frame's `<body>`**: the page isn't reloaded, `<html>` and `<head>` stay, and the body's
elements are made to match the server's render (so classes and inline styles a script set
on them can be reset).

- **`<html data-preview>`**: set it in the page component from `preview` (as above), so
  scripts can tell: `document.documentElement.hasAttribute('data-preview')`.
- **Opening another document reloads the frames**, so that page loads as on the public
  site and its own module scripts run on arrival. Only an edit morphs.
- **`caracms:rendered`**: after each morph (an edit) the frame's `document` gets this
  event; never on a load, which runs the scripts as usual, and never on the public site:

  ```js
  document.addEventListener('caracms:rendered', () => { /* lay out the new elements again */ });
  ```

**In the preview, the page is its JS-off self: everything showing, nothing moving or
reacting.** Then a click there is always an edit, and every word is in reach.

1. **Read the flag once**, when the site's scripts start:
   `const preview = document.documentElement.hasAttribute('data-preview')`.
2. **Don't run what moves or reacts in the preview**: no intro, no entrance, no
   scroll-driven or scroll-scrubbed animation, no hover or click behaviour, no form
   validation. Return before setting it up when `preview` is set. A head script that plays an
   intro stays out altogether (the page component leaves it out when `preview` is set).
3. **Leave the scroll native**, since the editor scrolls the frames to the block being
   edited. With Lenis, keep the instance (other code may call it) but turn wheel smoothing
   off: `new Lenis({ smoothWheel: !preview })`.
4. **Show what an interaction would reveal with CSS**, since no script runs to open it:
   closed folders, an accordion's answers, tiles covered until hover, a second tab's panel.
   Write it for the page's JS-off state under `[data-preview]`:

   ```css
   [data-preview] .folder-body { display: block; height: auto; }
   [data-preview] .reveal { opacity: 1; transform: none; }
   ```
5. **A script that only lays things out may run** (a carousel placing its slides side by
   side, a grid measuring its rows), as long as nothing moves and nothing is hidden. Run it
   again on `caracms:rendered`, for the elements the edit brought:

   ```js
   const preview = document.documentElement.hasAttribute('data-preview');
   if (!preview) setUpMotion(); // the site's own: entrances, scroll effects
   layOutCarousels();           // layout only: positions slides, never moves them
   document.addEventListener('caracms:rendered', layOutCarousels);
   ```

   (`setUpMotion` and `layOutCarousels` stand for the site's own code; caracms provides only
   the flag and the event.)

Check it in `/admin`: scroll the whole page (nothing moves), and everything a visitor would
open is open.
