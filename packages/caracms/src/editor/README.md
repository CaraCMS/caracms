# The editor (`/admin`)

M3's editor: React, server-rendered, dev only.
(Decisions 2, 4, 5, 6, 13, 19, 20); design: `packages/caracms/test/mockups/m2-editor.html`.

**In dev and in the build (M4 Decision 1, reversing M3 Decision 4).** The integration
(`../index.ts`) injects these routes for every command; the mode (local, live or
unconfigured) is read at run time (`server/mode.ts` → `editorMode()`), and an
unconfigured server answers 503 on all of them (`middleware.ts`). Local mode is M3's,
on disk. Live mode (`../live/editor.ts`) needs a session, a tab header and Redis, and
adds `status`, `lock`, `publish`, `history`, `try-again` and `notice` (shapes:
`types.ts`, after `ENDPOINTS`):

| Route | Takes | Gives |
|---|---|---|
| `GET /admin`, `/admin/<collection>/<path>` | the address (Decision 19), the `caracms-ui` and `caracms-unsent-<site>` cookies | the shell, server-rendered, plus `#caracms-props` (JSON) to hydrate from |
| `GET /_caracms/preview?collection=&path=` | a document | the page from its file, with preview markers; `X-Preview-Version: 0` |
| `POST /_caracms/preview` | `{ version, collection, document }` | the page from that document; `X-Preview-Version: <version>` |
| `GET /_caracms/document?collection=&path=` | a document | `{ entry, text, document, mtimeMs, version }` (`text`: the serializer's base) |
| `GET /_caracms/documents` | | the list, with warnings and `mtimeMs` |
| `POST /_caracms/write` | `{ file, base, document }`, JSON | `{ ok, file, changed, mtimeMs, version }`, or `{ error }` with 400/403/404/405/413/415 |
| `POST /_caracms/create` | `{ collection, path, title, blockType? }`, JSON (M5a) | `{ ok, collection, path, file, url, version }`, or `{ error, code }` (`types.ts` → `CreateDeleteRefusal`) |
| `POST /_caracms/delete` | `{ collection, path }`, JSON (M5a) | `{ ok, collection, path, file }`, or `{ error, code }` |

**M5b Phase 2: the media routes**, `/_caracms/media/*` (one injected route, `routes/media.ts`,
over `server/media/handler.ts`), in both modes and with no lock: `POST upload` (an image's bytes,
its name in `X-Caracms-File-Name`), `GET images` (the library with signed thumbnails, where-used
and an alt already used), `GET thumbnail?key=&width=` (a 302 to the signed URL), and Mux's
`POST video-upload`, `GET video-upload/<id>`, `GET clips`, `GET clips/<id>`, `GET playback/<id>`.
Every shape is in `types.ts` → `MEDIA_ENDPOINTS`. `server/media/`: `sniff.ts` (the type and size
from the bytes), `upload.ts` (the 40 MB cap, the key rule, no overwrite), `bucket.ts` (S3 through
aws4fetch, and the in-memory bucket), `cloud-bucket.ts` (the same seam on CaraCMS Cloud's media
API, `CARACMS_CLOUD_KEY`), `library.ts` (the 60 s listing, metadata per key,
where-used), `mux.ts` (the template's Mux rules), `alt.ts` (`WaitingView.missingAlt`),
`config.ts` (503s, images and clips apart) and `memory.ts` (`CARACMS_MEDIA=memory`: `memoryMedia()`
to seed the bucket and the fake Mux in tests).

**M5b Phase 3: the media field and the library in the editor.** `client/media/store.ts` →
`mediaFor(editor)`: the library (`images`, `clips`, last-known while a refetch runs), `upload(files,
slot?)` (images through the upload route with XHR progress; clips straight to Mux with UpChunk,
then polled until `ready`), `place(slot, entry)` (Decision 3's value through `pickMedia`, written
with `doc.setField(scope, path, …)`), `showUnused` (localStorage), `slotNotes` (a refusal at a
slot) and `placed` (the last placement, for Phase 4's ask). `fields/MediaField.tsx`: the field
(`MediaField`) and its body (`MediaSlot`, also a gallery row's body in `ListField.tsx`); the slot's
wrapper is `[data-path="<path>"]` and its alt input `[data-alt="<path>"]`. The library is the
pane level `media` (`pane/levels/MediaLevel.tsx`), opened with `editor.openMedia({ pick?, item?,
tab? })`: browse from Site-wide → Media, or a slot's picker (`view.media.pick`, the block kept
selected and the slot ringed: `overlays/editor-marks.ts`). Browsing dims the stage, which becomes
the drop target (`media/LibraryStage.tsx`). `editor.mediaSetup` (from `AdminProps.media`) holds the
503 sentences, so an unconfigured server's fields say so in the first paint. Thumbnails are only
ever the server's signed URLs (`thumbnailSrc` → `GET thumbnail`, or the listing's).

The write route is M3's security boundary: `server/write.ts` says what it refuses
and why. Every route reads and writes through the drafts store
(`server/drafts-store.ts`: `list`, `read`, `write`, and M5a's `source`, `create` and
`delete`), the seam M4 swaps.

**M5a Phase 3: creating and deleting** (M5a Decisions 11
and 12). Two routes, a security boundary like the write route:
`server/create.ts` has the rules (the same in both stores, over the store's own
listing), the disk half (an exclusive create; a delete that removes the folders it
empties, up to the collection's) and why. Addresses come from names with `../slug.ts`
(`slugify`, `isSlug`, `addressProblem`; browser-safe, for the New page dialog). In
live mode a create is the creator's autosave with the lock, a delete a "gone" autosave
(`../live/drafts-store.ts`); the poll's `waiting[].change` says `new`, `deleted` or
`changed`, and `open.deleted` tells a viewer who deleted the document they have open.
The screens are Phase 5's (below).

**M5a Phase 2: every kind of document**.
The routes above take and give all four kinds: a section builder's `{ title, blocks }`,
a list-of-fields document `{ kind: 'fields', title, data }`, a shared block
`{ kind: 'shared', title, block }` and Site Settings `{ kind: 'settings', title, data }`
(`types.ts` → `AnyOpenedDocument`). The reserved collections `shared` and `settings`
are collections like any other in `site.collections` (after the site's own), so the
listing, `read`, `write`, the confinement and live mode's copy all take them. The
listing gives each document's `kind` and public `url` (null for the reserved two), a
page's shared entries (`uses`), and a shared block's `blockType` and `usedOn`. The
preview renders any kind but Site Settings, and reads other documents (shared blocks, a
case-study list) from `store.source()`. The brand's name and accent are Site Settings'
as committed (`server/settings.ts`, `brand.ts` → `brandFrom`); `editor.brand` is a
store the live poll keeps current.

**M5a Phase 5: the screens.** `EditorSite.collections` is every collection, of every
kind (`kind`, `fields`, `urlBase` null for `shared` and `settings`); `allCollections`
is the same list. `/admin/shared/<name>` and `/admin/settings` open.
- **The document store holds all four kinds as blocks** (`state/document-store.ts`):
  a section builder its blocks; a fields document and Site Settings one block, the
  form (`type` '', `known`, `data` = the document's data; `formKey(session)` is its
  key); a shared block one block, itself. `document.kind` says which; `wire()` gives
  each back in its own shape. So `setField(key, path, …)`, `removeItem`, Undo, the
  keeper (`holdsEdits` runs the kind's own writer, `applyDocumentEdits`) and the write
  path work the same for every kind. `addShared(name, at)` inserts `{ "shared": name }`.
- **A form's fields are picked at the document level**: `openBlock(key, field)` on a
  form goes to `level: 'document'` with `view.block` the form's key;
  `editor.fieldsOpen(view)` says whether fields are open (the block level, or a form's
  document level). Esc from a case study or a shared block goes up to its collection.
- **Preview markers** (`preview/markers.ts`): a fields document's root
  (`data-cms-document`) is block 0, so click to edit, the overlays, typing on the page,
  the lockup's warnings and the caret all find it with no block index.
- **Levels:** `pane/levels/FormLevel.tsx` (a fields document, a shared block, Site
  Settings; `DocumentLevel.tsx` picks by kind). Site Settings has no preview: the
  driver renders nothing for it and the stage dims the last page with "Back to …"
  (`shell/Stage.tsx`).
- **Creating and deleting** (`client/documents/`): `actions.ts` (the routes, then the
  list read again and the new document opened, or after a delete the level it was
  listed in), `dialogs.tsx` (New page with Inside and New group…, + New, New shared
  block, Delete and its variants, a shared block still in use), `DocMenu.tsx` (the
  head's menu: View on the live site, Delete …). A group row's menu creates a page at
  the group's address.
- **A page's shared entry** that renders is named by its shared block and marked
  Shared (`block-list/summary.ts → sharedOf`); its block level offers "Edit Footer
  (used on N pages)". Only a missing one, or one of an unknown type, is Skipped.
- The document list is read again when the poll's waiting files change (another tab
  created or deleted something, a Publish) and after this tab's changes are kept.

## Where things are

```
routes/        the injected routes
server/        server-only: the write route's logic, the drafts store, the admin props, the shell's render
client/        the browser (and the shell's server render)
  editor.ts      createEditor(): the stores and actions everything below uses
  context.tsx    useEditor(), useStore()
  state/         document-store.ts (editing), keeper.ts (keeping), live.ts (M4: the poll and the server calls), store.ts
  live/          M4's places, live mode only: publish.tsx (the bar's waiting count and Publish, their popovers,
                 history), session.tsx (the avatar and Sign out, signed out, the offline extras), notices.tsx
                 (the lock notes, Edit here, Use mine / Discard mine, the merge and published notices), marks.tsx
                 (presence, locks and waiting dots in navigation), format.ts (people, times in the site's zone)
  preview/       driver.ts (iframes, morph, latest-wins), selection.ts, warnings.ts, layout.ts, render-sequencer.ts,
                 page-edit.ts (click to edit, typing on the page), field-text.ts, markers.ts (the page's
                 contexts: blocks, page regions, sources), places.ts (edit in context: what an element on
                 the page belongs to, and where the open document is drawn)
  overlays/      the overlay layer (layer.ts), its CSS, the editor's marks, source-marks.ts (edit in
                 context's chips), OverlayMount
  fields/        the block level's fields: FieldFrame, Text, Select, Lockup, lockup-rules.ts
  shell/         App, Bar, Stage, Popovers, Toast, NarrowNote, Icons
  pane/          Pane.tsx (the frame), parts.tsx (shared pieces), switcher.tsx (Phase 4's seam), levels/*
  arrange/       Arrange pages: model.ts (the tree, the plan, the checks, the
                 re-plan; pure), store.ts (arrangeFor(editor): the screen's state, Apply), ArrangeStage.tsx (the
                 screen in the preview's place, mouse drag); its pane level is pane/levels/ArrangeLevel.tsx
styles/        tokens.css (the mockup's :root, as is), editor.css (the mockup's chrome CSS), fonts.css,
               levels/*.css (a level's own CSS, loaded by the admin route)
fonts/         Instrument Sans and Geist Mono (OFL, licences beside them)
```

## Extension points (Phases 3 and 4)

Phase 3 replaces `client/pane/levels/BlockLevel.tsx`; Phase 4 replaces
`DocumentsLevel.tsx`, `CollectionLevel.tsx`, `DocumentLevel.tsx` and
`client/pane/switcher.tsx`. The mockup's CSS for every component (block rows, the
field frame, the lockup field, the picker, popovers…) is already in
`styles/editor.css`; CSS a phase needs beyond it goes in its own file in
`styles/levels/` (the admin route loads them all), not in a shared one. Neither phase
needs to touch the shell, the pane frame, the stores or the driver.

**The editor** (`client/editor.ts`), from `useEditor()`:

```ts
editor.site                 // EditorSite: collections, blocks (schemas), textStyles, brand, home, host
editor.doc                  // DocumentStore (below)
editor.view                 // Store<View>: { level, collection, block, field, picked, width, pop, opening }
editor.documents            // Store<ListedDocument[]>; editor.refreshDocuments(): Promise<void>
editor.ui                   // Store<UiState>: { open, recent } (cookie); editor.toggleGroup(key, open?)
editor.keep                 // Store<KeepStatus>: { state: 'kept' | 'keeping' | 'offline' | 'refused' | 'held' | 'signedout', error, unsent?, retryAt?, held? }
editor.preview              // PreviewDriver | null (null in the server render)
editor.previewStatus        // Store<PreviewStatus>: { painted, failed, showing, opening, warnings }
editor.stageLayout          // Store<StageLayout | null>: each frame's box and scale
editor.openDocument(ref: DocRef, { history?: 'push' | 'replace' | 'none' }): Promise<void>
editor.openBlock(key: string, field?: string | null, { picked?: boolean }): void
editor.openCollection(name: string): void
editor.goTo(level: 'documents' | 'collection' | 'document' | 'block'): void
editor.goUp(): boolean      // Esc
editor.setWidth(width: 'desktop' | 'tablet' | 'phone'): void
editor.setPop(pop: string | null): void   // 'switcher' (Phase 4), 'preview-trouble', or a new one
editor.announce(text: string): void
editor.addressOf(ref: DocRef): string

// M4, live mode (local mode: mode 'local', access always editable, marks empty, these no-ops)
editor.mode                 // 'local' | 'live' (AdminProps.live: null in local mode, which never polls)
editor.you                  // Person | null
editor.liveSession          // LiveSession | null (state/live.ts): poll(), publish(), tryAgain(), history(), take(file)…
editor.liveState            // Store<LiveState>: { status: StatusResponse | null, reachable, signedOut, polled, seq }
editor.access               // Store<Access>: { lock, holder, held, signedOut, readOnly, veil } for the open document
editor.marks                // Store<Map<file, DocMarks>>: { editing, present, waiting, kept }
editor.editHere() / useMine() / discardMine() / publish() / tryAgain() / dismissNotice(id) / signOut() / signInAgain()
                            // publish() and tryAgain(): { ok, error? }; a failed Publish is said in its popover
editor.toast(text, icon?)   // a message in the toast (shell/Toast.tsx), e.g. a lock lapsing; editor.message is its store
```

**Read-only** (`access.readOnly`: someone else's lock, your own in another tab, held
edits, signed out): the document store refuses every change (`canEdit`), the block
level's fields sit in a disabled fieldset, the block list has no grips, menus or Add
block, the page takes no clicks or typing (page-edit.ts), and the overlays draw
nothing; a lock (`access.veil`) draws the veil over the whole page instead
(overlays/index.ts → `mode`). The lock lapsing, or Edit here, makes it editable again
without a reload, with the document read again (editor.ts → refreshOpen).

Read a store in a component with `useStore(store, selector?)`; a selector must
return a stable value (a primitive, or part of the state as stored).

**The document store** (`client/state/document-store.ts`), `editor.doc`. Blocks are
addressed by `key` (stable through moves, never written); `source` follows the
serializer's model.

```ts
doc.get(): DocumentSession            // { ref, entry, base, document: { title, blocks: EditorBlock[] }, revision, undo }
doc.state: Store<DocumentSession>
doc.subscribe((session, change: DocumentChange) => void): () => void
doc.block(key) / doc.indexOf(key) / doc.keyAt(index)
doc.setField(key, field, value, { origin?: 'sidebar' | 'page', undoLabel?: string }): void
doc.setTitle(title): void
doc.addBlock(type, index?): string    // the new block's key
doc.removeBlock(key, { label? }): UndoEntry | null
doc.moveBlock(key, toIndex): void
doc.restoreBlock(block, index): void
doc.undo(): UndoEntry | null          // Decision 18; the shell's toast and ⌘Z call it
doc.wire(): SiteDocument
```

Every change is written about a second later (the keeper) and rendered into the
preview (the driver). `origin: 'page'` is for text typed on the page: the driver
mirrors it into the other iframes instead of rendering, as M1 did. `undoLabel` puts
the old value on the Undo stack under that label (dropping a lockup's phone lines:
"Phone uses the main lines again").

**The preview driver** (`client/preview/driver.ts`), `editor.preview`:

```ts
preview.frames(): PreviewFrame[]      // { width, trueWidth, iframe, document, window }
preview.frame(width): PreviewFrame
preview.onLoad((frame) => void): () => void
preview.onMorph((event: { version, opened, frames }) => void): () => void
preview.registerFrameHook((frame, reason: 'load' | 'morph') => void | (() => void)): () => void
preview.mirrorText(blockIndex | contexts, field, text, except?: Document | null): void
preview.retry(): void
preview.status                        // = editor.previewStatus
```

A frame hook runs for each frame when it loads and after every morph; what it
returns runs before its next run for that frame. Overlays (Phase 3) and the block
list's hover link (Phase 4) go there. The phone's lockup sizes are in
`previewStatus.warnings: LockupWarning[]` (`{ block, field, set, px, minPx, tooLong, uncovered }`).
In the iframes, `data-cms-block` is the block's index in the rendered document.

**Edit in context**: a document can be open over a page
(`editor.over`: `{ page, block, field, blocks }`, or null). The store holds the opened document;
the preview keeps the page, rendered with the opened document as the preview POST's `overlay`.
`editor.openOver(ref, { field })` opens one from a click, `editor.backToPage(then?)` goes back
(the page's selection as it was left, or `then`), `editor.showOwnPage()` shows the opened
document on its own page. Site Settings always opens over the last page, a shared block when
that page draws it (`openDocument` decides). Everything that maps between the page and the
editor asks `preview/places.ts` (`claimOf`, `ownCtxs`): a page field is the store's `PAGE_SCOPE`,
a form's fields drawn as a source are its one block.

**Pane pieces** (`client/pane/parts.tsx`): `Trail`, `LevelTab`, `DocumentsTab`,
`CurrentHead`, `GlobalNotes`, `RecentStrip`, `parentLabel`. A level is
`<><Trail>…</Trail><div className="side-body"><GlobalNotes />…</div><RecentStrip /></>`.
Icons: `<Icon name="grip" />` (`shell/Icons.tsx`, the mockup's sprite).

## Overlays

What the editor draws over the preview (M2 Decision 6, M2 → Rules → Overlays):
`client/overlays/`. One shared layer per editor, inside each of the three iframes.
Phase 3's own marks and any other module's go through the same small API.

- **Preview renders only.** /admin creates the layer at run time in its own iframes.
  It's one `#cms-overlays` element appended to `<html>` (outside `<body>`, so the
  driver's body morph never touches it) and one `<style>` in `<head>`. Nothing of it
  is in any render, so the public build can't have it (Decision 17).
- **Positioning.** The layer is in document coordinates, so it scrolls with the
  page, and has `pointer-events: none`.
- **Constant size on screen.** `--k` is 1 / the frame's scale, and every size in
  the CSS (`overlays/overlay-css.ts`) is `calc(var(--k) * Npx)`.
- **Colours** come from the `--ov*` tokens, copied onto the layer as `--cms-*`.
- **Kept children.** A redraw replaces the layer's children, except one marked
  `data-cms-keep` (`KEEP` in layer.ts), which draws itself and stays on top: the
  formatting bar of rich text typed on the page (`overlays/rich-text-bar.ts`), whose
  link popover's search would lose focus if it were taken out.

```ts
import { overlaysFor } from '../overlays/index.ts';
const overlays = overlaysFor(editor);              // Overlays | null (null on the server)

overlays.set(channel: string, marks: readonly Mark[]): void   // replace that channel's marks
overlays.clear(channel: string): void
overlays.addPainter(painter: OverlayPainter): () => void      // your own elements; returns a remove
overlays.redraw(): void                                       // next frame (a painter's state changed)
overlays.flush(): void                                        // now
overlays.layerOf(frame: PreviewFrame): HTMLElement | null

interface Mark {
  kind: 'hover' | 'selected' | 'field-hover' | 'picked' | 'typing' | 'warn' | 'skipped';
  block: number;              // data-cms-block (the editor's index: editor.doc.indexOf(key))
  field?: string | null;      // data-cms-field in it; the whole block when absent
  label?: string;             // tag / chip / pill text
  tone?: 'phone';             // teal
  frames?: readonly Width[];  // default: all three
  onClick?: (e: MouseEvent) => void;   // makes the label a button
}

type OverlayPainter = (ctx: OverlayContext) => Node | Node[] | null | void;
interface OverlayContext {
  frame, width, visible /* the frame on screen */, doc, k,
  block(i): HTMLElement | null, field(i, name): HTMLElement | null, blocks(): HTMLElement[],
  rect(el, pad?): Rect        // document coordinates, pad in on-screen px
  place(rect): string         // "left:…;top:…;width:…;height:…"
  fitLeft(chip, left)         // sets a chip's left, shifted so it sits inside the frame's width
  el(tag, className?, style?) // an element in the frame's document
}
```

**Redraws.** The layer redraws on its own:

- when a frame loads and after every morph;
- when a frame's page changes size, or its fonts load;
- on input in a frame;
- when the stage's scale changes;
- when the width on screen changes.

Painters run on every redraw, once per frame. Call `redraw()` when state a painter
reads changes. What they draw goes above the block marks (skipped, hover, selected)
and under the field marks (field hover, picked, typing, warn), as the mockup layers
them.

**Drawing your own elements.** Painters build them with the CSS classes in
`overlay-css.ts`, for example:

- `cms-empty` with `cms-add`: the empty page's invitation.
- `cms-box` with `cms-hov`, `cms-sel` or `cms-pick`.

Only buttons take the pointer (`pointer-events: auto`). Put your own listeners on
the elements you create.

**The editor's own marks** (`overlays/editor-marks.ts`, the `editor` channel) are
drawn from the editor's state. There are none while the preview shows another
document.

| Mark | When | Where |
|---|---|---|
| `selected` | a block is open in the block level, or selected in the block list | that block |
| `hover` | `blockHover(editor)` holds a block (`block-list/link.ts`) | that block, unless it's the selected one |
| `field-hover` | the pointer is over a field of the open block | that field |
| `picked` | a field is picked | that field, ringed with its name; teal "· Phone lines" in the phone frame when the lockup has phone lines |
| `typing` | a field is being typed on the page | that field: "Typing on the page" |
| `warn` | a lockup is too long for mobile | phone frame only |
| `skipped` | a block is unknown | at its placeholder; the pill opens the block |

`blockHover` is set by the block list's rows (Phase 4), and also by hovering a
block on the page. So a hovered row outlines its block, and a hovered block lights
up its row.

**Editing from the page** (`client/preview/page-edit.ts`, `pageEditFor(editor)`):

- **Click to edit**, in the frame on screen. It opens the block and picks the field
  (`openBlock(key, field, { picked: true })`). A lockup also focuses its sidebar
  field.
- **Typing on the page.** Plain text fields only, with `origin: 'page'`. One-line
  fields take no breaks.
- **Esc in the page** leaves the field, then goes up a level.
- **Following the sidebar.** A block or field picked in the sidebar scrolls into
  view.
- **Stores:** `typing` (the field being typed) and `hover` (block and field under
  the pointer).

**Skipped blocks.** In preview renders only, `Blocks.astro` leaves a comment,
`<!--cms-skipped i type=…-->` (`src/skipped.ts`), where an unknown block would be, and no
element, so a site's sibling CSS (`+`, `:has(+ …)`) matches across it as on the public
page. `data-cms-block` indexes are still the editor's block indexes, unknown blocks
included (a skipped index just has no element). The overlay layer draws its amber line
between the elements either side of the comment (`preview/markers.ts` → `skippedTop`).

## The look (Phase 5)

The chrome is the mockup's CSS (`styles/editor.css`, lifted as is) on its tokens
(`styles/tokens.css`), so how it looks comes from markup: the same elements, in the
same order, with the same classes as the mockup. Two checks keep it so:

- `node --experimental-strip-types packages/caracms/test/mockup-diff.ts [state…] [--all]`
  compares every M3 state of the mockup with /admin by computed style, and lists the
  accepted differences with their reasons (also `test/mockup-m3.visual.test.ts`, and
  `-m4`/`-m5a` for the later states).
- `test/chrome.visual.test.ts` (live mode: `chrome-live-contrast` and `chrome-live`):
  contrast with both sample accents, the accent only in its slots, no side rails,
  nothing moving under reduced motion, focus rings.
  `test/chrome.test.ts`: no raw colour outside `tokens.css`.

**The brand slot** (`shell/Brand.tsx`): Site Settings' logo (a signed URL, M5b Decision
11; set in Site Settings' Logo and Tab icon slots, `FormLevel.tsx → BrandSlot`), or, with
none, its initial on its accent (ink and edge by contrast, `brand.ts`, which reads its
inks from `tokens.css`); the tab icon (`EditorBrand.tabIcon`) is the icon, else the logo,
else the same initial, and follows the poll (`editor.ts`). **"Not in the preview yet"**
(`fields/stale.ts`): a field changed since the last render, shown while the preview
can't render.

## Keeping (Decisions 5 and 6; M4 Decisions 4, 9 and 11)

`client/state/keeper.ts`. In live mode every write carries `X-Caracms-Tab` and a rising
`X-Caracms-Seq` (the server never lets a lower one replace that tab's newer autosave), the closing
tab's last write `X-Caracms-Release: 1` (and a tab with nothing unsent sends a keepalive
release of its locks), a 409 `locked` is `held`, a 401 is `signedout`, and a retry timer
runs only while offline (the countdown, Try now, the unsent count). Whether held edits
are re-sent is the server's call: `verdict()` uses the document's `lastChange` (another
editor's change since holds them for Use mine / Discard mine). The rest is M3's: A second after the last change the whole document goes to
the write route with its base. The bar: Kept, Keeping, "can't reach the server"
(a network failure or a 5xx) until a write succeeds, or "Not kept" with the server's
own message in the pane's note when it answers with a 4xx (the edits don't fit their
base, the file was renamed or deleted while open); either way the edits stay held,
and the next change or a reload retries (no timer). Unsent
edits are held in `localStorage` per document (`caracms:unsent:<site>:<collection>/<path>`:
`{ file, base, document, fileVersion }`) until the file has them, and sent with
keepalive on `pagehide`. **On load, a held copy is dropped only when the file already
holds those edits**: if the file is still at the version they were made against
(`fileVersion`, a hash of the file's text) they're re-sent; if it has moved on, the
keeper runs the serializer in the browser (`applyEdits(base, document)`, as the write
route does) and compares with the file's text: equal, the copy is dropped; otherwise
it's re-sent (the keepalive write never updates `fileVersion` and may have been
refused, and an earlier write can land after a later one). A cookie (`caracms-unsent-<site>`) tells the server some are
held, so the bar paints as Keeping from the first frame after a reload.

## Left for later

- M4 Phase 5: the pixel match of the M4 states against the mockup.
- M5a Phase 6: the look of the M5a states against the mockup (`mockup-diff`).
