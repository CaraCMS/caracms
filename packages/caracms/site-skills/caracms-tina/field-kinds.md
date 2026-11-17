# Tina field kinds → caracms

How `tina-to-caracms.mjs` maps each kind of Tina field. The script reads Tina's own generated schema (`tina/__generated__/_schema.json`) and applies this table to every field it finds, so nothing is written per block. The same table drives the content it writes and the starting config `--scaffold-config` writes.

"Schema path" below is how the script's adapt table names a field: `blocks.<template>.<field>` for a block's, `<collection>.<field>` for a collection's, `siteSettings.<field>` for Site Settings', with dots for nesting (`blocks.columns.items.media`).

## Fields

| Tina field | caracms field | Stored value |
|---|---|---|
| `string` | `text()` | copied as it is |
| `string`, `ui.component: 'textarea'` | `text({ multiline: true })` | copied (`\n` between lines) |
| `string` whose name is in the adapt table's `headingFields` (in a block) | `text({ heading: true, … })` | copied |
| `string` with `options` | `select({ options })` (Tina's labels kept) | copied. A blank or unknown value is left out, so caracms's default applies (the first option, as Tina's "blank reads as the first option"), or the adapt table's `fieldDefaults` value |
| `string`, `list`, with `options` | `list(select({ options }))` | copied |
| `string`, `list` | `list(text())` | copied |
| `string` named `href`, or listed in `addressFields` | `link({ addressOnly: true })` | `{ "href": "…" }` |
| `number` | `number()` | copied |
| `boolean` | `toggle()` | copied; `fieldDefaults` fills a missing one (a default that lived in the mapper's code) |
| `datetime` | `date()` | copied |
| `image` with a sibling `<name>Alt` string | `media({ only: 'image' })` | `{ key, alt, w, h }`: the pair becomes one value, the `…Alt` field goes |
| `image` with no alt sibling | `media({ only: 'image' })` | `{ key, alt: "", decorative: true, w, h }`, or the document's title as alt when listed in `docTitleAlt` |
| `object` with `kind` and an image `src` (the template's `media()`) | `media()`, or `media({ only: 'image' })` when it has no `playbackId` | an image: `{ key, alt, focal, w, h }` (Tina's whole-percent `focusX`/`focusY` become `focal` 0–1). A Mux clip: `{ video, play, poster, name, duration }` (`playAs` → `play`, `posterTime` → `poster`) |
| `linkLabel` + `href` side by side | one `link()` named `link`, where `linkLabel` stood | `{ label, href }` |
| `object` list of `{ label, href, style }` | `buttons({ styles })` | `[{ label, href, style }]` |
| `object` list of `{ label, href }` | `list(link())` | `[{ label, href }]` |
| `object` list of one field (after the pairs merge) that is text, a reference or an image | a list of that field | flattened: `[{ line: "a" }]` → `["a"]`, `[{ game: "content/products/x.json" }]` → `["x"]`, `[{ image, imageAlt }]` → `[{ key, alt, w, h }]` |
| `object` list (anything else) | `list({ … })`, `itemLabel` the first text field | a list of objects, keys in schema order |
| `object` | `group({ … })` | an object, keys in schema order |
| `reference` | `reference({ to })` | the document's path in its collection: `content/products/x.json` → `x` (Tina's home file → `index`) |
| `rich-text` | `richText({ headings, links })`: headings from Tina's `overrides.headingLevels` (h2 and h3 only), links on when the toolbar has `link`; Tina's default (no overrides) is h2, h3 and links | caracms's rich text (below) |
| `displayOnly` | — | dropped |
| a collection's `isTitle` field | the document's own `title` | copied |

Every label and help (`description`) is carried into the scaffolded config. A template's own description (`ui.description`) becomes its block's `help`, cut to a sentence or two; where the site also put it in front of a field's help ("About this block: …"), the field keeps only its own.

## Rich text

Tina stores Markdown in a JSON string. Each blank-line-separated chunk becomes caracms blocks:

- a line starting `## ` or `### ` → `{ "h2": … }` / `{ "h3": … }`; any other heading level becomes a paragraph, with a warning (caracms never holds an `h1`);
- runs of `* `, `- ` or `+ ` lines → `{ "ul": [ … ] }`, runs of `1. ` lines → `{ "ol": [ … ] }`; an indented item is flattened into its list, with a warning (caracms has no nested lists);
- everything else → `{ "p": … }`.

Inline, `**bold**`, `*italic*` and `[text](href)` carry over (Tina's `__bold__` and `_italic_` become `**`/`*`). Tina's two forms of a line break, a trailing `\` or two spaces before a newline, become `\n`, and so does a bare newline inside a paragraph. **Tina's escapes are undone** (`R\&D` → `R&D`, `mailto\:` → `mailto:`) except before `*`, `[`, `]` and `\`, the only characters caracms escapes. Units are trimmed, so a rich heading's trailing `\n` goes, and an empty value becomes `[]`.

## Documents and collections

- A Tina collection with a list of templates (a section builder) → `kind: 'sections'`: `_template` → `type`, the templates list (`sections`) → `blocks`, its other fields are page fields (stored after `title`, before `blocks`). Any other collection → `kind: 'fields'`.
- The collection's key and folder are its Tina folder in kebab case (`content/clientLogos` → `client-logos`).
- Tina's `home.json` (the adapt table's `homeFile`) → `index.json`. Folders under a collection are kept.
- **Block types** take the adapt table's `blockRenames`, and otherwise go from camelCase to kebab case (`textMedia` → `text-media`).
- `seo { metaTitle, metaDescription, ogImage, ogImageAlt }` → caracms's `seo { title, description, image }`.
- **Hidden:** a section builder's boolean `hidden` → `"hidden": true` at the top level of the document, beside `title` and `blocks` (absent means shown). The home page can't be hidden: it's left shown, with a warning.
- **Holds:** the page the adapt table's `holders` names for a collection (`products: 'products'`, `posts: 'blog'`; the table is the only source, with no default from names) gets `"holds": "<collection>"` after `title` and `hidden`, and the scaffolded config gives that collection `heldBy: 'pages'` in place of `urlBase`. The home page never holds one. A table entry whose page doesn't exist is a warning. For each sections collection with a same-named page that isn't in the table, the script prints a hint line saying what to add (a fields collection is never suggested).
- Every file starts with its `$schema` (`../../schemas/<collection>.schema.json`), as `caracms schemas` stamps it.
- A key in a Tina file that its schema no longer has is left out, with a warning.

## Site Settings

| Tina (`siteSettings`) | caracms (`content/site-settings.json`) |
|---|---|
| `adminAccess.allow[].entry` | `editors` |
| `adminBranding { name, accent }` | `brand { name, accent }`. The logo and favicon aren't carried (a warning says so): upload them in the editor |
| `defaultSeo` | `seo` |
| `googleTag` | `googleTag` |
| `formNotifications.<form>[].address` | `formRecipients.<form>`; `--recipients <address>` makes every form's list that one address |
| `submissionsLink` | dropped (caracms's inbox is in the editor) |
| everything else | Site Settings' own fields, by the table above |

## Images and files

- **Images and files take new keys, by their bytes.** An image's Tina key is the URL's part after `s3://<bucket>/` (`https://img…/unsafe/plain/s3://site-media/uploads/photos/a.jpg` → `uploads/photos/a.jpg`); an image URL that isn't in the bucket is left out, with a warning. Each key the content uses is read from the bucket once and given the upload route's key, `uploads/<first 12 hex of the bytes' SHA-256>/<slugified name>.<ext>` (an image's extension is its sniffed type), the only shape `caracms media push` and the cloud take. The object is copied within the bucket to that key; the copy is skipped when the key exists, and nothing is ever deleted or overwritten (the live Tina site keeps serving the old keys).
- **The key map**, `scripts/tina-media-keys.json`: each Tina key → `{ key, w, h }` (an image, sized by caracms's own sniffer, EXIF orientation included) or `{ key }` (a file), sorted, one per line. It's read first; a key it lacks is read from the bucket (the site's `S3_*` settings). Commit it: with every key in it, a run needs no bucket. A key whose bytes can't be read (not in the bucket, no `S3_*` settings, or not an image where one is used) fails the run, named with where it's used, before anything is written.
- **File links** the Tina site served itself (`/files/<name>`, from `uploads/<name>`; the adapt table's `fileLinks`) become caracms file addresses, `/files/<hex>/<name>`, by the key map, wherever an address can be: links, buttons, address fields and rich text. Site Settings' `redirects` sends each old address to its new one.

## The adapt table

At the top of the script, under "ADAPT HERE". Everything else is generic.

| Entry | What it's for |
|---|---|
| `blockRenames` | the approved block table: a Tina template's caracms key where it isn't the kebab-case rule |
| `fieldDefaults` | a value Tina's files leave out but the site's mapper code reads as set: a per-block background default that isn't the first option, a toggle that reads as on |
| `addressFields` | strings that are addresses but aren't named `href` (social links, a privacy link, a YouTube link). Tina's schema doesn't say which strings are links |
| `headingFields` | text field names that are headings (scaffold only) |
| `docTitleAlt` | bare images whose alt is the document's title (a client's logo) |
| `fileLinks` | the Tina site's own file route and the bucket key behind it |
| `homeFile` | Tina's home page file |
| `holders` | a collection key → the page file that holds it (`products: 'products'`, `posts: 'blog'`); the only source of holding, so a collection not listed keeps its `urlBase` |
| `shared` | shared blocks (`content/shared/<name>.json`): Site Settings fields that are one piece's own (`{ from: 'footer.columns' }`, moved out of Site Settings; a group left empty goes), and words the Tina site's code drew (`{ text: 'Contact' }`, `{ link: { label, href \| hrefFrom } }`), each now a field. `slot: 'header'` or `'footer'` makes the block that slot's default. The scaffold adds each to `blocks` |
| `formWords` | Site Settings › Forms: only the words the Tina site's code said differently from caracms's defaults, by form id |
| `redirects` | addresses the Tina site served that caracms doesn't (`/sitemap-index.xml` → `/sitemap.xml`), after each file link's, which the script writes |
| `formsConfig` | the Tina site's forms config (`forms.config.mjs`, its `FORMS`), which `--scaffold-config` turns into the config's `forms` |
