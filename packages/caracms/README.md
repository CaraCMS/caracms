# caracms

A visual CMS for Astro sites, with the content in git. Editors change a site in its own
pages, at `/admin`; what they publish is JSON files in the site's repository, which the
site builds from.

**caracms is unsupported.** It's published so that the sites built on it can be installed
and run by whoever looks after them. There's no issue tracker and no support: use it as it
is, under the MIT license.

CaraCMS is a trademark of Caracode. The MIT license covers the code, not the name: a fork
or a hosted service needs a name of its own.

## Start

Two steps: create an Astro site, then add caracms to it with `npx caracms init`.
(`npm create caracms` says the same.)

**1. Create the Astro site** (Astro 7, on Node 22.12 or later), or use one you have:

```sh
npm create astro@latest
```

**2. In it, add caracms.** From the site's root, in a clean git checkout, install it and
commit the install:

```sh
npm install caracms --save-exact
git add package.json package-lock.json
git commit -m "Add caracms"
```

That commit matters: installing changes `package.json` and the lockfile, and
`init --write` refuses while tracked files have uncommitted changes, so its own change is
one diff to review. Then look at what `init` would do:

```sh
npx caracms init
```

It asks where the site will run, [CaraCMS Cloud](#caracms-cloud) or self-hosted, then
prints every file it would add and every edit it would make, as a diff, and changes
nothing. (It asks only in a terminal: an agent or a script passes `--cloud` or
`--self-hosted`.) When it looks right, apply it and install what it added:

```sh
npx caracms init --write
npm install
```

`init` adds the plumbing (the Node adapter, the integration, a minimal `caracms.config.ts`
and page component, the one catch-all route that serves every document with an address,
the schemas) and copies caracms's
skills into `.claude/skills/`. It doesn't touch the site's pages. Bringing them in is the
job of the `caracms-adopt` skill, one page at a time.

## Commands

Run from the site's root:

- `caracms init [--write] [--railway] [--cloud | --self-hosted]`: add caracms to an Astro
  site, or bring a set-up site's skills, schemas and CLAUDE.md block up to date.
  `--cloud` or `--self-hosted` says where the site runs, written into `caracms.config.ts`
  as `services` ([Where the site runs](#where-the-site-runs-services)); `--cloud` on a
  self-hosted site also prints the steps of the move. `--railway` also writes a Railway
  setup; without it, `init` prints the variables any host needs (Hosting, below).
- `caracms validate [--fix] [--json]`: check the content against `caracms.config.ts`.
  Exits 1 when there are errors. `--fix` runs `caracms schemas` first, then lays each
  content file out as the editor saves it (two-space JSON; only whitespace changes).
- `caracms schemas`: write `schemas/` from the config, and give each content file its
  `$schema`.
- `caracms media import <files…>`: put local images into the site's media bucket (or, with
  `CARACMS_CLOUD_KEY`, its folder in CaraCMS Cloud); prints `[{ file, key, w, h, existed }]`.
- `caracms media push`: copy a site's originals from its own bucket into CaraCMS Cloud,
  keeping every key ([Moving a site's images in](#moving-a-sites-images-in)).
- `caracms start`: serve the built site (Hosting, below).

The skills (`caracms-content`, `caracms-blocks`, `caracms-adopt`, `caracms-tina`,
`caracms-hosting` and `caracms-upgrade`, in `site-skills/`) say how the rest works.
`caracms-upgrade` has the steps for moving a site onto a newer release, and what each
release asks of a site. `init` copies them into the site, and brings
them up to date after an upgrade; `astro dev` and `caracms validate` say when they're behind.

## Collections and addresses

A collection that has pages of its own gets its address from exactly one of three places:

| Source | In the config | In the content | A document's address |
|---|---|---|---|
| **Pageless** | no `urlBase` | none | none: records other pages list (a team, awards, logos) |
| **A prefix in code** | `urlBase: '/tags/'` | none | `urlBase` + slug: `/tags/<slug>`, with no page at `/tags` |
| **Held by a page** | `heldBy: 'pages'` | the page's file says `"holds": "journal"` | the page's address + `/` + slug: posts at `/journal/<slug>`, and at `/blog/<slug>` once the page moves |

`heldBy` and `urlBase` are exclusive, and a held collection is flat. A page holds at most
one collection (never Home), and `caracms validate` reports a `holds` that doesn't match a
`heldBy`.

One catch-all route, `src/pages/[...path].astro`, serves all three. It lists what to build
with `addressedDocuments(site)` from `caracms/content` (`{ collection, path, url }` for
every public page, leaving out hidden ones and files that can't be opened), and a site that
renders on demand uses `documentAt(site, pathname)`. A collection needs no route of its
own; a prefix collection whose base keeps its own route file is left out of the reader,
and a route with parameters left at a held collection's address is a `validate` error.

## Arranging pages

The editor's Pages tree reads Home first, then the pages and groups with pages (or a held
collection) under them, then the rest, each A–Z. To change that, "Arrange pages…" in the
tree's header opens a screen at `/admin/arrange`: drag pages to order them, nest one under
a page or group, make and rename groups, then review every old → new address and apply it
as one change, with one tick for redirects from the old addresses. Nothing changes until
Apply, and if the pages change underneath it, Apply refuses and shows the review again.

The order is saved in Site Settings as `pageOrder` (each parent's path → its children's
slugs), so no site field can use that name. It orders the editor's tree, the Inside picker
and `listDocuments(site, 'pages')`; the site's menus stay lists in Site Settings.
`caracms validate` warns on an entry that names no page, and `--fix` prunes it.

## Rich text: heading ids

Every `<h2>` and `<h3>` that `<RichText>` draws has an `id`, so a page can have a table of
contents and anyone can link to a heading. The id is GitHub's slug of the heading's text
(lower case, spaces to `-`, punctuation dropped, `**bold**` and link syntax read as their
text), made unique on the page with `-1`, `-2`… in page order, counted across all of the
page's blocks. Page order is the document's: its blocks in order, each block's fields in
schema order, list items in order. The ids are render-only; the stored rich text never
holds them. A page field the page component draws itself, Site Settings and a slot's block
get no ids.

Two functions from `caracms/content` give a site the same ids:

- `pageHeadings(site, document, { collection, read })` → `{ depth: 2 | 3, slug, text }[]`,
  the page's headings in order, exactly the ids the rendered page carries (the shape
  Starlight's `<StarlightPage headings>` takes). In the page component, pass its own
  `document`, `collection` and `read` props.
- `headingId(text, seen)`, the slug rule itself, for writing anchors elsewhere (a Markdown
  twin of the page): `seen` is a `new Map()` per page, and each call returns the next
  unique id. `headingText(runs)` is a heading's plain text from its rich-text runs.

```astro
---
import { pageHeadings } from 'caracms/content';
import { site } from 'virtual:caracms/config';
import Blocks from 'caracms/components/Blocks.astro';
const { document, collection, preview, read } = Astro.props;
const headings = await pageHeadings(site, document, { collection, read });
---
<StarlightPage frontmatter={{ title: document.title }} headings={headings}>
	<Blocks document={document} collection={collection} preview={preview} />
</StarlightPage>
```

## Vivid feedback attributes

Set `vivid: true` in `defineSite({ … })` and every field drawn through the package's
components (`<Text>`, `<RichText>`, `<Lockup>`, `<Buttons>`, `<Link>`, `<Media>`, and
`<Block field>`) carries two attributes on public pages, for Vivid, the on-site feedback
widget: a reviewer's pin then names the exact field and links to it in the editor.

- `data-vivid-field="<document>#<field path>"`: the document is `<collection>/<path>`, or
  `settings` for Site Settings; the field path is where the field sits in the document's
  JSON file, list indexes included.

  | Where the field is | Example |
  | --- | --- |
  | a block on a section-builder page | `pages/services/branding#blocks.2.heading` |
  | a row of a block's list | `pages/about#blocks.1.credits.1.name` |
  | a button's or link's words | `pages/index#blocks.0.buttons.0.label` |
  | a page field (the page component's `cms`) | `journal/my-post#date` |
  | a list-of-fields document | `case-studies/high-street-coffee#summary` |
  | Site Settings (`cms.settings`) | `settings#contact.phone` |
  | a shared block (a slot, a `{ "shared": … }` entry) | `shared/footer#block.address` |
  | an entry a block read (`cms.of(entry)`) | `case-studies/high-street-coffee#cover` |

  A value over 200 characters (Vivid's limit) is left out, with a build warning.
- `data-vivid-edit`: the document in the site's own editor, as an absolute address:
  `https://<site>/admin/<collection>/<path>`, `/admin/settings`, `/admin/shared/<name>`, and
  `/admin` for Home. In `astro dev` the origin is the dev server's; in a build it's the
  site's public address, as sign-in links have it: Astro's `site`, else `SITE_URL`, else
  Railway's public domain. A build with none of those leaves `data-vivid-edit` out, with a
  warning.

Never in the editor's preview. Off (the default), the public HTML is unchanged. The page's
route must read its document with `readDocument` (as the starter's does), which is how a
render knows the document's collection and path; a document built in code, like the 404's,
leaves its own fields untagged.

## Hosting

caracms runs on any host that keeps one Node server running behind HTTPS: Railway,
Render, Fly, or a VPS. What every host needs:

- **One instance.** The site runs as one server process (two for a moment during a
  deploy). The drafts and several caches live in its memory. On Fly that means one
  machine; on Render, no autoscaling.
- **HTTPS.** Editors' sessions only travel over https, so signing in needs it.
  `http://` works for `localhost` only, and then in a Chromium browser: Safari won't
  keep the session cookie on `http://localhost`.
- **A deploy whenever `main` changes.** A Publish commits to `main`; caracms never
  deploys anything itself. Railway, Render and Coolify deploy on a push. On Fly or a
  plain VPS, add a GitHub Action (or Coolify, or similar) that deploys on a push to
  `main`.
- **`SITE_URL`, the same value at build and at run time.** Set it where the site is
  built and where it runs. A www address at one and the bare domain at the other is
  the likeliest setup mistake.
- **Started with `caracms start`** (the site's `npm start`). It decides each visitor's
  IP for the limits on signing in, forms and downloads. A site started any other way
  answers those routes with a 503:

  > This site wasn't started with `caracms start`, so it can't tell its visitors apart
  > for the limits on signing in, forms and downloads. A developer can start it with
  > `caracms start` (the site's start script).

### The variables

These go on the site's server. `caracms init` prints the same list.

| Name | Needed | What it's for |
|---|---|---|
| `CARACMS_CLOUD_KEY` | instead of the GitHub, image, form and email variables | The site's key from CaraCMS Cloud (`cck_…`). It replaces the token or App, `GITHUB_REPO`, the image variables, and the form and email ones: see [CaraCMS Cloud](#caracms-cloud). |
| `GITHUB_REPO` | required, but not with the cloud key | The site's repository, as owner/name. |
| `CARACMS_GITHUB_TOKEN` | required, or the App, or the cloud key | A fine-grained token (`github_pat_…`) on that one repo: Contents read and write, Metadata read (Deployments read is optional). Never `GITHUB_TOKEN`. |
| `GITHUB_APP_ID` | instead of the token | The GitHub App's ID, for anyone setting up many sites. Set the token or the App, not both. |
| `GITHUB_APP_PRIVATE_KEY` | with `GITHUB_APP_ID` | The App's private key. |
| `SITE_URL` | required | The site's public address, https://. The same value at build and at run time. |
| `REDIS_URL` | required | The editor's drafts and sessions: `redis://` or `rediss://` (Upstash works, in the site's region). |
| `CARACMS_SECRET` | required | Signs the editors' sessions. A long random string. |
| `CARACMS_CLIENT_IP_HEADER` | required off Railway, Fly and Render | Where the visitor's IP comes from: `x-real-ip` for nginx with `proxy_set_header X-Real-IP $remote_addr`, `x-forwarded-for` for Caddy, or `socket` if nothing sits in front of this server. `caracms start` won't start without it. |
| `CARACMS_ALLOW` | for email sign-in | Who may sign in, comma-separated: addresses (`aoife@example.com`) or whole domains (`@example.com`). The client adds their own people in Site Settings. |
| `RESEND_API_KEY` | for email sign-in, but not with the cloud key | Sends the sign-in links (and form notifications) through Resend. |
| `FORMS_FROM` | for email sign-in, but not with the cloud key | The address those emails come from, on a domain verified in Resend. |
| `CARACMS_BACKUP_USER` | for the backup sign-in | The backup sign-in, for when email sign-in links can't arrive. Both or neither. |
| `CARACMS_BACKUP_PASSWORD` | for the backup sign-in | The backup sign-in's password. |
| `CARACMS_RUNNING_COMMIT` | optional | The commit this server runs, where the host doesn't say (Railway and Render do). |
| `CARACMS_DEPLOY_HOOK_URL` | optional | Try again on a publish POSTs here to redeploy the site (the host's deploy hook). |
| `GITHUB_WEBHOOK_SECRET` | optional | For a webhook added in the repo's settings. Without it, a check once a minute does the same job. |

Set email sign-in, the backup sign-in or both, or nobody can sign in.

A site that uses images, video or forms needs these as well. The image variables and
`TURNSTILE_SITE_KEY` are read at build too, so set them in both places.

| Feature | Variables |
|---|---|
| Images (the media bucket and imgproxy) | `CARACMS_MEDIA_URL` (imgproxy's address), `IMGPROXY_KEY`, `IMGPROXY_SALT`, `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`; on CaraCMS Cloud, none of them: `CARACMS_CLOUD_KEY` alone |
| Video | `MUX_TOKEN_ID`, `MUX_TOKEN_SECRET`; on CaraCMS Cloud, none of them: `CARACMS_CLOUD_KEY` alone |
| Form submissions (a second bucket, at the media bucket's endpoint and region) | `SUBMISSIONS_S3_BUCKET`, `SUBMISSIONS_S3_ACCESS_KEY_ID`, `SUBMISSIONS_S3_SECRET_ACCESS_KEY`; on CaraCMS Cloud, none of them: `CARACMS_CLOUD_KEY` alone |
| Form emails | `RESEND_API_KEY`, `FORMS_FROM` (as above); on CaraCMS Cloud, none of them |
| Spam checks on forms | `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` |
| A password on the whole site before launch | `CARACMS_PRELAUNCH` |
| Try again through Railway's API | `CARACMS_RAILWAY_TOKEN` (Railway sets the rest) |

When something required is missing or wrong, the public site still serves and `/admin`
answers 503 with a sentence saying what to fix. For example:

> Both a GitHub App (GITHUB_APP_ID) and a token (CARACMS_GITHUB_TOKEN) are set: set one
> of them, not both.

> The site's public address isn't known: set SITE_URL to it, like https://example.com,
> both when the site is built and when it runs. Without it, sign-in links can't be sent
> and the editor's saves are refused.

> Both CARACMS_DEPLOY_HOOK_URL and CARACMS_RAILWAY_TOKEN are set: Try again redeploys
> through one of them, so set only one.

If the site is opened at an address other than `SITE_URL` (say `https://example.com`
when `SITE_URL` is `https://www.example.com`), signing in and saving are refused with:

> This site's address is set to https://www.example.com (SITE_URL), but it was opened at
> https://example.com, so signing in and saving are refused here. Open it at
> https://www.example.com, or set SITE_URL to https://example.com where the site is built
> and where it runs.

### The visitor's IP

`caracms start` takes each visitor's IP from one source, set by
`CARACMS_CLIENT_IP_HEADER`, one of five values: a header the nearest proxy sets and
overwrites (`x-real-ip`, `fly-client-ip` or `cf-connecting-ip`), `x-forwarded-for` (its
last entry, the one the nearest proxy added), or `socket` for a server visitors reach
directly. Any other value is refused. On Railway, Fly and Render it has a
default, and a set value always wins. Anywhere else it won't start without it:

> Set CARACMS_CLIENT_IP_HEADER to the header your proxy sets: x-real-ip for nginx with
> `proxy_set_header X-Real-IP $remote_addr`, x-forwarded-for for Caddy, or socket if
> nothing sits in front of this server.

It prints where the IP comes from when it starts.

### Railway

- IP: `x-real-ip`, by default.
- Commit: `RAILWAY_GIT_COMMIT_SHA`, which Railway sets.
- `caracms init --railway` writes `.railway/railway.ts`, which describes the whole
  project (the site, Redis, the buckets, imgproxy). Railway's own variables cover the
  repo, so `GITHUB_REPO` isn't needed. With `--cloud` it writes only the site and Redis:
  the cloud brings the rest.
- Try again: `CARACMS_RAILWAY_TOKEN`, a project token. Railway has no deploy hook.

### Render

- IP: `x-forwarded-for`'s last entry, by default. Render documents no header it
  overwrites, and this default hasn't been checked against a running Render service
  yet. Check it before relying on the sign-in limits. `*.onrender.com` sits behind
  Cloudflare: if the last entry there is a Cloudflare address, every visitor to the
  `onrender.com` address shares one bucket (caracms never reads `CF-Connecting-IP` on a
  host's own address). On the site's own domain it's read as usual.
- Commit: `RENDER_GIT_COMMIT`, which Render sets.
- One instance: don't turn on autoscaling.
- A web service with build command `npm ci && npm run build` and start command
  `npm start`. Render's environment variables are there at build and at run time.
- Try again: set `CARACMS_DEPLOY_HOOK_URL` to the service's deploy hook. Render's hook
  takes a bare POST.

### Fly

- IP: `fly-client-ip`, by default. Fly's proxy sets it and replaces a forged one.
- Commit: Fly sets none. Pass it as a build argument, and declare it in the Dockerfile
  before the build step (`ARG CARACMS_RUNNING_COMMIT`), so the build bakes it in:

  ```sh
  fly deploy --build-arg CARACMS_RUNNING_COMMIT=$(git rev-parse HEAD)
  ```

  In a GitHub Action, use `${{ github.sha }}`.
- `SITE_URL` at build: the variables in `fly.toml`'s `[env]` and Fly's secrets are
  for run time only. Pass `SITE_URL` (and the image variables, if the site has images)
  as build arguments too, declared with `ARG`.
- One machine: `fly launch --ha=false` (or `fly scale count 1` later). Fly starts two
  by default.
- Deploys: Fly doesn't deploy on a push. Add a GitHub Action that runs `fly deploy` on
  a push to `main`.

### A VPS, behind Caddy or nginx

- IP: Caddy adds the visitor's address to `X-Forwarded-For`, so set
  `CARACMS_CLIENT_IP_HEADER=x-forwarded-for`. With nginx, set
  `CARACMS_CLIENT_IP_HEADER=x-real-ip` and pass the headers on:

  ```nginx
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
  ```

  Caddy passes the host and the scheme on by itself: `reverse_proxy 127.0.0.1:8080`.
- Commit: a build in a git checkout bakes in `git rev-parse HEAD`. Otherwise set
  `CARACMS_RUNNING_COMMIT`. Coolify sets `SOURCE_COMMIT`, which caracms reads.
- Keep the server running with systemd or similar. `caracms start` listens on `PORT`
  (default 8080).
- Deploys: Coolify, or a GitHub Action that pulls, builds and restarts on a push to
  `main`.
- If the running commit isn't one in the repo (a server built from a commit that was
  never pushed), no publish can ever show as live on it: each one reads as "taking
  longer than usual".

### Redis

Any Redis works by URL: Railway's, Render Key Value, a local one, or Upstash. For
Upstash, use its `rediss://` URL as `REDIS_URL`, with the database in the same region
as the site.

### GitHub: a token or an App

caracms writes to the site's repo with one of two credentials. Set one, not both.

**A fine-grained token** is the easy one:

1. On GitHub: Settings → Developer settings → Personal access tokens → Fine-grained
   tokens → Generate new token.
2. Resource owner: whoever owns the site's repo. Repository access: only that one repo.
3. Permissions: Contents, read and write. Metadata, read (GitHub adds it). Deployments,
   read, if the host writes GitHub Deployments (Railway does): it lets the editor show
   a failed deploy.
4. Pick an expiry (a year at most; an organisation may set less) and set the token as
   `CARACMS_GITHUB_TOKEN`.

caracms never reads `GITHUB_TOKEN` (the `gh` CLI and GitHub Actions set it), and refuses
a classic token:

> CARACMS_GITHUB_TOKEN is a classic token, which reaches every repo its owner can: use a
> fine-grained token (it starts with github_pat_) with access to this site's repo only.

What a token costs:

- Its rate limits belong to the person, shared by every site on their tokens: 5,000
  requests an hour, and 80 commits a minute and 500 an hour. A few sites edited hard at
  the same moment can reach the hourly cap. Past a handful of sites on one person's
  tokens, use the App.
- Commits show as the token's owner, not the App. Commit messages still carry the
  editor's name.
- Publish's commits on `main`, and merges from `main`, are unsigned (GitHub signs only
  the drafts' commits). A "require signed commits" rule on `main` needs the App.
- No webhook comes with it. Add one by hand in the repo's settings (`POST
  /_caracms/github`, with `GITHUB_WEBHOOK_SECRET`), or leave it: a check once a minute
  does the same job.
- It expires, and it's tied to a person's account. The editor warns 14 days before it
  expires, and says so if GitHub refuses it or a permission is missing.

**A GitHub App** (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`) has its own rate limit per
site, signs every commit, and isn't tied to a person. Use it for anyone running more than
a handful of sites, or a repo that requires signed commits. Install it on the site's repo
only, with the same permissions as the token.

**Protect `drafts` from deletion.** It holds every change saved since the last Publish,
and to a branch tidy-up it looks like any stale branch. In the repo's Settings → Rules →
Rulesets, add a branch ruleset that targets `drafts` and turns on "Restrict deletions"
only (leave "Block force pushes" off: Publish moves `drafts` with a forced update). If
`drafts` goes anyway, the next start makes it again from the last commit the server
recorded, while GitHub still has that commit; when it can't, the editor says what was lost.

**Roll the site back with `git revert`, never a force-push.** A revert is a new commit on
`main`, which `drafts` takes in like any push; resetting `main` to an older commit and
force-pushing leaves the rolled-back content waiting in the editor, so the next Publish puts
it back (the editor warns everyone when it sees one).

### CaraCMS Cloud

#### Where the site runs: `services`

`caracms.config.ts` says where the site's services (GitHub access, images, forms and
email, video) come from, and nothing else decides it:

```ts
export default defineSite({
	services: 'cloud', // or 'self-hosted'
	collections: { … },
	…
});
```

- **`'cloud'`**: everything comes through `CARACMS_CLOUD_KEY`. The self-hosted variables
  (the GitHub token or App and `GITHUB_REPO`, the image, video, and form and email ones
  below) are **ignored**, never read, and each is named once in the build log and once
  when the server starts:

  > S3_BUCKET is set, but this site runs on CaraCMS Cloud (caracms.config.ts): it's ignored. Remove it once the old bucket and imgproxy are retired.

  So a site can move with its old variables still set, and remove them afterwards. A
  production build or server with no key fails with "This site runs on CaraCMS Cloud
  (caracms.config.ts), but CARACMS_CLOUD_KEY isn't set. Make a key for it in
  app.caracms.com." (the build fails; a running server's `/admin` answers 503 with it, and
  the public site keeps serving). It never falls back to the self-hosted variables.
  `astro dev` is local mode, with or without the key (see [working locally](#working-locally)).
- **`'self-hosted'`**: the site's own variables, as [the variables](#the-variables) list
  them. A `CARACMS_CLOUD_KEY` beside them is ignored the same way.
- **Not set** (a site from before caracms 0.8.0): the key decides, and setting it beside
  the site's own variables is refused, as each section below says. The next `caracms init`
  adds the field.

`caracms init --cloud` or `--self-hosted` writes the field (as the first line inside
`defineSite({`). With neither, `init` asks in a terminal and, run by an agent or a script,
leaves a set-up site's mode unset (and says so) or stops on a new one. Once the field is
there, `init` reads it and never asks again.

**Moving a self-hosted site onto the cloud.** `caracms init --cloud` on a self-hosted site
writes the field and prints the steps of the move, in order, each with the check that it
worked: make the site, its key and the App's install in app.caracms.com; push the field
(the host's build fails until the key is set: the old deployment keeps serving); copy the
images in with [`caracms media push`](#moving-a-sites-images-in); set the key on the host;
upload the video clips again; remove every variable the cloud replaces (it names them all,
marking the ones it found in `.env` and `.railway/railway.ts`; it can't see the host's own
page, so check that too); retire what the cloud replaced; and, last, cut
`.railway/railway.ts` down to the site and Redis. `init` never edits an existing
`.railway/railway.ts`: `railway config apply` would remove the buckets with it. With a key
in the environment or `.env`, `init --cloud` also checks it, showing the site, its team,
the linked repo and whether the App is installed on it, or the cloud's reason for refusing
it (it never prints the key). The `caracms-hosting` skill walks through all of this.

**Leaving.** `caracms init --self-hosted` on a cloud site writes the field back and prints
the way back: set up the site's own services ([Hosting](#hosting)), copy the site's folder
from the cloud's media bucket to a bucket of your own (the keys in content stay the same),
set the variables, then remove the key.

#### GitHub access on CaraCMS Cloud

A site run by CaraCMS can take its GitHub access from CaraCMS Cloud instead of a token or
an App of its own. The cloud gives the site's server a short-lived token for the site's
repo, and only that repo, about once an hour.

1. CaraCMS sets the site's repo in CaraCMS Cloud.
2. Install the caracms GitHub App on that repo, choosing only that repo. The site's page in
   app.caracms.com says whether it's installed, and links to the App's install page when
   it isn't.
3. Make a key for the site in app.caracms.com and set it as `CARACMS_CLOUD_KEY` on the
   site's server.

The key replaces `CARACMS_GITHUB_TOKEN` (or `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`)
and `GITHUB_REPO`: the repo comes from the cloud when the server starts. With `services: 'cloud'`
they're ignored; on a site whose config doesn't say, setting `GITHUB_REPO` beside the key is
refused, and so is setting a token or an App as well. It
also replaces the image variables ([Images](#images-on-caracms-cloud), below), the
video ones ([Video](#video-on-caracms-cloud)), and the form and email ones
([Forms and email](#forms-and-email-on-caracms-cloud)).
Everything else in [the variables](#the-variables) is still the site's own: `SITE_URL`,
`REDIS_URL`, `CARACMS_SECRET`, `CARACMS_ALLOW`, the backup sign-in, and Turnstile.
There's no webhook: a check once a minute keeps the editor's Publish status up to date.

If the cloud says no when the server starts (the App isn't installed on the repo, the
site has no repo yet, the key was revoked), `/admin` answers 503 with the cloud's own
sentence, and the public site still serves. The next visit to `/admin` tries again. If it
says no later, while the editor is open, the editor shows the same sentence until the
cloud gives a token again. A repo changed in CaraCMS Cloud reaches the site at its next
start.

#### Images on CaraCMS Cloud

With the key, the site's images live in its own folder of CaraCMS Cloud's media bucket and
are served, resized and signed, from `img.caracms.cloud`. Set none of `S3_ENDPOINT`,
`S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `IMGPROXY_KEY`,
`IMGPROXY_SALT` or `CARACMS_MEDIA_URL`. With `services: 'cloud'` they're ignored; on a site
whose config doesn't say, setting any of them beside the key is refused with

> Set CARACMS_CLOUD_KEY or the site's own media variables, not both: remove S3_BUCKET.

The image host, the bucket, the site's folder and its signing key come from the cloud:
once when the site is built, and once when its server starts (on its first request). The
signing key is never in a variable, a log or anything sent to a browser. Uploads go to the
cloud through short-lived links the cloud makes for the site's server, and count towards
the site's storage limit; a full site's uploads are refused with the cloud's sentence. The
keys in content are the same `uploads/<hash>/<name>.<ext>` as anywhere else, so leaving
the cloud is copying the folder to a bucket of your own.

**A build needs the cloud.** If it says no (a revoked key, a team switched off), the build
fails with its sentence; if it can't be reached, with "CaraCMS Cloud couldn't be reached,
so the site can't be built. Try again in a minute." A site with no repo linked yet still
builds. A running site keeps serving whatever the cloud does.

`caracms media import <files…>` works with the key too (from the environment or the
site's `.env`), with the same rules and output, and its uploads count like any other.

#### Forms and email on CaraCMS Cloud

With the key, the site needs no submissions bucket and no Resend account. Set none of
`SUBMISSIONS_S3_BUCKET`, `SUBMISSIONS_S3_ACCESS_KEY_ID`, `SUBMISSIONS_S3_SECRET_ACCESS_KEY`,
`RESEND_API_KEY` or `FORMS_FROM`. With `services: 'cloud'` they're ignored; on a site whose
config doesn't say, setting any of them beside the key is refused, at build and when the
server starts, with

> Set CARACMS_CLOUD_KEY or the site's own forms and email variables, not both: remove RESEND_API_KEY and FORMS_FROM.

The site's server still makes every check on a submission (the fields, the honeypot, the
rate limit, Turnstile) and writes its email, as before. The cloud stores the submission
and its attachments, and sends the email once it's stored. The editor's inbox reads them
from the cloud, unchanged.

- **Form emails** come from `forms@notify.caracms.com`, named "<brand name> – <form label>"
  (for example "CaraCMS – Contact"), with Reply-To the visitor. They go to the form's
  recipients in Site Settings, at most the first ten (the server log says when some were
  left off).
- **Each site sends at most 50 form emails a day** (UTC) unless CaraCMS raises it. Past
  that, a submission is still stored, and the inbox shows it as "Not emailed: this site
  reached its daily email limit in CaraCMS Cloud (50). Ask CaraCMS to raise it." It isn't
  sent later.
- **Sign-in links** come from `no-reply@accounts.caracms.com`, in the same words as before.

**On a laptop**, or anywhere that isn't a production server (`NODE_ENV=production`),
nothing goes to the cloud, even with the key: submissions are kept in
`.caracms/submissions/` and both emails are written to the server log, so a test enquiry
never reaches a client's inbox.

A site on an older caracms keeps its own bucket and Resend until it updates and removes
them.

#### Moving a site's images in

`caracms media push` copies everything under `uploads/` in the site's own bucket into its
CaraCMS Cloud folder, under the same keys, so the content doesn't change. It's the one
command that takes both credentials. The old bucket's `S3_*` can stay in `.env` once the
config says `services: 'cloud'` (the running site ignores them); on a site whose config
doesn't say, give them on its command line instead (it refuses both):

```bash
S3_ENDPOINT=https://t3.storageapi.dev S3_REGION=auto S3_BUCKET=… S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… npx caracms media push
```

It checks each file's bytes against the hash in its key, skips anything already in the
cloud (so it can be stopped and run again), carries over each file's size, name and
uploader, and never changes the source bucket. It prints `{ copied, skipped, left, failed }`
and exits 0 when nothing failed. A key not of the upload shape (`uploads/<12 hex>/<name>.<ext>`)
is left, not failed, each named on its own line: the cloud takes only that shape. On a site
moved from Tina those are its old originals, which the conversion script copied to
upload-shaped keys (the caracms-tina skill), so push sends the copies and leaves the rest.
A site bigger than its storage limit stops at the limit with the cloud's sentence: ask
CaraCMS to raise it, then run it again.

#### Video on CaraCMS Cloud

With the key, the site's clips are uploaded to CaraCMS Cloud's Mux and listed from the
site's own clips there; the editor works exactly as it does with a Mux account of your
own. Set neither `MUX_TOKEN_ID` nor `MUX_TOKEN_SECRET`. With `services: 'cloud'` they're
ignored; on a site whose config doesn't say, setting either beside the key is refused with

> Set CARACMS_CLOUD_KEY or the site's own Mux variables, not both: remove MUX_TOKEN_ID.

Clips play on the site straight from Mux (`stream.mux.com`, `image.mux.com`), as before:
the public pages never call the cloud. The minutes a site stores count towards its video
limit (60 minutes unless CaraCMS has set another), and once it's reached, a new upload is
refused with the cloud's sentence: "This site has reached its video limit in CaraCMS
Cloud (60 minutes). Ask CaraCMS to raise it." A clip counts once Mux has finished with
it, so one upload can take a site past its limit; the next is refused.

**Moving a site's video in** means uploading its clips again in the editor and placing
them where the old ones were. There's no copy command. Until a clip is replaced, the old
one keeps playing on the site from the site's old Mux account: the page only needs its
playback ID. In the editor it shows its poster and "A clip" (it isn't in the cloud's
library), and saving other changes on the page leaves it as it is. Remove `MUX_TOKEN_ID`
and `MUX_TOKEN_SECRET` when you set the key; keep the old Mux account until every clip
has been replaced.

#### Working locally

**Anyone working on a real site, wherever they are, uses that site's CaraCMS Cloud**: your
laptop, a colleague's, a client's developer, a staging deploy. Each gets **its own key**
for the site, labelled ("the developer's laptop", "staging") in app.caracms.com, so revoking one
never touches the live site. Leave `CARACMS_CLOUD_URL` unset: images render from
`img.caracms.cloud` and the library lists the site's real folder. `astro dev` stays in
local mode, editing the files on disk: live mode on a laptop never points at the site's
real repo, so the key alone never turns it on (the App's variables still do). Uploads
from a laptop land in the real folder and count towards its storage, which is harmless:
nothing is overwritten or deleted, and nothing is live until it's published.
`CARACMS_CLOUD_URL` is only for working on CaraCMS Cloud itself, against its dev deployment;
with it, `astro dev` is live on that deployment's throwaway repos.

### Behind Cloudflare

caracms sees through Cloudflare's proxy (the orange cloud) by itself: when the address
from the host's header is one of Cloudflare's and the request came in on the site's own
domain, it uses `CF-Connecting-IP` instead. On a host's own address (`*.up.railway.app`,
`*.onrender.com`, `*.fly.dev`), localhost or a bare IP it never does. Watch for:

- **`CF-Connecting-IP` can be forged around Cloudflare.** Render and Fly give the site its
  own address too (`*.onrender.com`, `*.fly.dev`), and anyone calling it directly can set
  the header. caracms only trusts it on requests that came from Cloudflare's addresses,
  so leave `CARACMS_CLIENT_IP_HEADER` alone: never set it to `cf-connecting-ip` unless
  the server accepts Cloudflare's traffic alone.
- **Cloudflare Workers.** A Worker on any Cloudflare account can call a server that isn't
  itself on Cloudflare, from Cloudflare's addresses, and set `CF-Connecting-IP` to
  anything. So put the site's own domain on Cloudflare's proxy: a Worker fetching a
  proxied domain goes through your zone, where Cloudflare sets the header itself, and
  one fetching the host's own address is ignored (above). A domain that isn't proxied
  (the grey cloud) can be reached this way. On a VPS, also accept only your own zone's
  traffic: Authenticated Origin Pulls with your zone's own certificate, or a Cloudflare
  Tunnel.
- **No "Cache Everything" rule over `/admin` or `/_caracms/*`.**
- **Bot Fight Mode** (the free plan's) can't exempt a path, so it may challenge GitHub's
  webhook. The once-a-minute check covers it.
- **Cloudflare gives up on an answer after 100 seconds.** Publish answers within 60
  seconds and carries on if it needs longer; the editor follows it.
