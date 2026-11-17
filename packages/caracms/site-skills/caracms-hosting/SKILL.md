---
name: caracms-hosting
description: Set up where a caracms site runs — choose its mode (CaraCMS Cloud or self-hosted, the `services` field in caracms.config.ts) and run `caracms init --cloud` or `--self-hosted`, put its server on a host (Railway through `init --railway`; Render, Fly or a VPS by hand), move a self-hosted site onto the cloud by following `init`'s move list in order, and read the cloud's refusals (a storage or video limit, the daily email limit, a switched-off team, a revoked key, the GitHub App not installed) with what to do for each. Use before a site's first deploy, when moving a site between modes, when changing its host, or when the cloud says no.
---

# Where a caracms site runs

A site makes three choices, and they're separate:

- **Where it starts** (Tina, an existing Astro site, …) decides which skill converts it:
  `caracms-tina`, `caracms-adopt`. Those skills hand over to this one before the first
  deploy.
- **Its mode**, where its services come from (GitHub access, media, forms and email,
  video): **CaraCMS Cloud** or **self-hosted**. Section 1.
- **Where its server runs**: a cloud site still runs its own Node server and Redis
  somewhere. Section 2.

**The config says the mode; the variables don't.** `services` in `caracms.config.ts`
(`'cloud'` or `'self-hosted'`, inside `defineSite({ … })`) is the one source of truth.
Variables from the other mode are leftovers to retire, never a second opinion: with the
field set, the site ignores them and says so once at build, once at the server's first
request and once from `media import`:

> S3_BUCKET is set, but this site runs on CaraCMS Cloud (caracms.config.ts): it's ignored.
> Remove it once the old bucket and imgproxy are retired.

A config with no `services` field behaves as caracms did before the field existed (the
key decides, and the key beside the site's own variables is refused). The next `init`
with a mode adds the field.

Detail lives in the caracms README (`node_modules/caracms/README.md`): **Hosting** (what
every host needs, the variables, each host) and **Hosting → CaraCMS Cloud** (the key,
images, forms and email, video, `media push`, working locally). This skill is the order
to do things in; read those sections for the rest, rather than guessing.

Commands run from the site's root: `npx caracms …`, or `pnpm caracms …` in a pnpm site.

## 1. Choose the mode and run `init` with it

| Mode | The site's server needs | On its host |
|---|---|---|
| **CaraCMS Cloud** | `CARACMS_CLOUD_KEY`, plus the site's own `SITE_URL`, `REDIS_URL`, `CARACMS_SECRET`, sign-in (`CARACMS_ALLOW` and/or the backup sign-in), Turnstile | the site and Redis |
| **Self-hosted** | a GitHub token or App and `GITHUB_REPO`, the media bucket and imgproxy, a submissions bucket, Resend, Mux, plus everything in the row above but the key | the site, Redis, two buckets, imgproxy |

The full list, per variable, is the README's *Hosting → The variables*.

**CaraCMS Cloud** is for a site CaraCMS runs: it has a team and a site in
app.caracms.com, its repo linked there, and the caracms GitHub App installed on that
repo. **Self-hosted** is for a site that keeps its own buckets, imgproxy, Resend and
GitHub credential. If the brief or the person hasn't said which, ask. Don't pick one
from what variables happen to be in `.env`.

**Always pass the flag.** `init` asks for the mode only when a person is at a terminal;
run by an agent or a script, it won't pick one. On a new site it writes nothing, exits 1
and says to run it again with `--cloud` or `--self-hosted`; on a site already set up it
does everything else, leaves the field out and says "Mode not set: run
`caracms init --cloud` or `--self-hosted`."

```sh
npx caracms init --cloud            # the dry run: read it
npx caracms init --cloud --write    # writes services: 'cloud' and the rest
```

(`--self-hosted` the same way. Both flags at once is a problem.)

- `init` writes the field as the first property of the `defineSite({` literal, or
  replaces an existing `services` property. If the config's `defineSite` argument isn't
  a literal, it writes nothing and names the line to add by hand: add it, then run `init`
  again.
- A second `init` reads the mode from the config and asks nothing; it re-links the
  skills and refreshes the CLAUDE.md block (whose first line says where the site runs)
  and the schemas. Run it after every caracms update.
- **A flag that contradicts the field is a move**, not an error: `--cloud` on a
  self-hosted site prints the move list (section 3); `--self-hosted` on a cloud site
  prints the way back (section 3, the end).
- **`init --cloud` checks the key** when it finds one (the environment, then `.env`): it
  shows the site and team the key belongs to, the linked repo, and whether the App is
  installed on it, or the cloud's own sentence for a refused key (section 4). No key: it
  says where to make one and carries on. **Never print, paste or commit a key.**

**One key per place the site runs**, each labelled in app.caracms.com: "Railway" for
the host, "the developer's laptop" for a laptop's `.env`, "staging" for a staging deploy.
Revoking one never touches the others. Leave `CARACMS_CLOUD_URL` unset (it's only for
working on CaraCMS Cloud itself). On a laptop `astro dev` edits content on disk, with or
without a key; the key shows, imports and uploads images in the site's real folder. Only
the key with `CARACMS_CLOUD_URL` (the cloud's dev deployment) makes `astro dev` live.

**A production build needs the key.** With `services: 'cloud'` and no
`CARACMS_CLOUD_KEY`, `astro build` (and `pnpm build` on a laptop, which is a production
build) fails, and a production server's `/admin` answers 503, with:

> This site runs on CaraCMS Cloud (caracms.config.ts), but CARACMS_CLOUD_KEY isn't set.
> Make a key for it in app.caracms.com.

It never falls back to self-hosted variables that happen to be set.

## 2. Where the server runs

Every host needs what the README's *Hosting* opens with: one instance, HTTPS, a deploy
whenever `main` changes, `SITE_URL` the same at build and run time, and the server
started with `caracms start`. The mode only changes which variables go on it (section 1).
Off Railway, Fly and Render, `CARACMS_CLIENT_IP_HEADER` is required too (*Hosting → The
visitor's IP*).

Each host below is its own section. **A new host is a new section here**, written the
same way: how it's set up, the variables per mode, anything it does differently. The
rest of this skill doesn't change for it.

### Railway

**Set up by `init`.** `init --railway` writes `.railway/railway.ts`, the file that
describes the whole Railway project, when the site has none:

- `--cloud --railway`: the site and Redis, nothing else.
- `--self-hosted --railway`: the site, Redis, the media and submissions buckets, and
  imgproxy.

Then the README's *Hosting → Railway* (the IP header and commit come by default; "Try
again" uses `CARACMS_RAILWAY_TOKEN`). Set `CARACMS_CLOUD_KEY` (the "Railway" key) on the
site's service on a cloud site.

**`init` never rewrites an existing `.railway/railway.ts`.** `railway config apply`
makes the project match the file, deleting what the file no longer declares. So:

- **Never run `railway config apply` on a file cut down to the site and Redis before
  `caracms media push` has finished** (section 3, step 3): it would delete the media
  bucket the images are still being copied from.
- Never apply a file you haven't read against the environment it would change. A
  production file a template wrote (a Tina template site's) can switch its CDN off; set
  production's variables with `railway variables --set` instead.
- Before any apply, `railway config plan` shows what it would create, change or delete.
  Read it.

**After the first `railway config apply`, connect the repo again in Railway's
dashboard** (the site's service → Settings → Source: disconnect, then connect the same
repo and branch). An editor's Publish is a commit by the CaraCMS GitHub App, not by a
member of the Railway workspace. On a service whose source only `config apply` connected,
Railway holds those deploys at "needs approval", approving them in the dashboard doesn't
take, and the published change stays off the site until a member next pushes. A
member's own pushes deploy either way, so nothing looks wrong until the first Publish.
*Check:* publish one small edit from `/admin`; Railway starts building it within a
minute, with no approval asked. (Found on a docs site, 2026-11-09; fixed by the reconnect,
checked 2026-11-11.)

### Render

By hand, from the README's *Hosting → Render*: one instance (no autoscaling), the IP
default to check, the commit Render sets. Put the mode's variables (section 1) on the
web service, Redis beside it (*Hosting → Redis*). A self-hosted site also needs its two
buckets and an imgproxy somewhere the server can reach.

### Fly

By hand, from the README's *Hosting → Fly*: one machine, a GitHub Action to deploy on a
push to `main`, the IP header. The mode's variables as Fly secrets; Redis (Upstash works,
in the site's region). A self-hosted site needs its buckets and imgproxy elsewhere.

### A VPS

By hand, from the README's *Hosting → A VPS, behind Caddy or nginx*: the proxy,
`CARACMS_CLIENT_IP_HEADER` set to match it, a deploy on a push to `main`, Redis. The
mode's variables in the server's environment.

## 3. The move: self-hosted to CaraCMS Cloud

**Follow the list `init --cloud` prints, in its order.** On a site that's self-hosted
(the field says so, or there's none and the site has a `.railway/railway.ts` with
buckets or imgproxy, or media, video, forms or GitHub variables in `.env`),
`npx caracms init --cloud --write` writes `services: 'cloud'` and prints the steps to
finish the move, each with the check that says it worked. Only steps that apply are
printed. Don't reorder them, skip a check, or fit a list of your own to the site.

**`init` only sees the repo.** The list names every variable the cloud replaces and marks
the ones it found in `.env` or `railway.ts`; the host may have more. Open the host's
variables page and check it against the full list.

The replaced variables:

- media: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`, `IMGPROXY_KEY`, `IMGPROXY_SALT`, `CARACMS_MEDIA_URL`
- video: `MUX_TOKEN_ID`, `MUX_TOKEN_SECRET`
- forms and email: `SUBMISSIONS_S3_BUCKET`, `SUBMISSIONS_S3_ACCESS_KEY_ID`,
  `SUBMISSIONS_S3_SECRET_ACCESS_KEY`, `RESEND_API_KEY`, `FORMS_FROM`
- GitHub: `CARACMS_GITHUB_TOKEN`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_REPO`

(`GITHUB_WEBHOOK_SECRET` isn't on it: the cloud has no webhook, so it's unused and
harmless.)

The list's steps, for orientation (what `init` prints is the one to follow):

1. The site and a key in app.caracms.com, the App on the repo, then open the site's page
   in app.caracms.com (the cloud refreshes the install state only when that page opens, a
   repo is linked or the site mints a token). Set the site's domains on its page there too
   (each address the editor is opened at: the live domain, a branch environment's): the
   cloud sends no sign-in link until they're set, nor one to an address not among them
   (section 4). *Check:* `init --cloud` again shows "App installed".
2. Commit and push the field. **The host's build then fails with "CARACMS_CLOUD_KEY isn't
   set" until step 4.** That's expected: the old deployment keeps serving. Don't "fix"
   it by reverting the field.
3. Copy the images: `caracms media push`, with the old bucket's `S3_*` on its command line
   (README: *Moving a site's images in*). *Check:* `failed: 0`, and a second run skips
   everything. A key not of the upload shape (`uploads/<12 hex>/<name>.<ext>`) is `left`,
   named on its own line, not failed: on a site moved from Tina those are its old
   originals, which the conversion copied to upload-shaped keys (caracms-tina skill). Check
   no content still names one (`rg '"uploads/[^"]*"' content/` shows only upload-shaped
   keys). It stops at the storage limit with the cloud's sentence (section 4).
4. Set `CARACMS_CLOUD_KEY` on the host and **leave the old variables in place** (they're
   ignored). *Check:* the deploy's logs name them as ignored; the editor signs in; an
   upload lands in the cloud.
5. Video, if `MUX_TOKEN_*` was found: each clip uploaded again in the editor and placed
   where the old one was (no copy command; old clips keep playing until replaced).
   *Check:* no page plays from the old account.
6. Remove the replaced variables from the host, one by one. *Check:* the next deploy logs
   no "ignored" lines.
7. Retire, **only once 4–6 hold**: imgproxy, the media bucket, the GitHub token or App on
   this repo, Resend. **Keep the submissions bucket** until its old submissions are
   exported or no longer wanted (the cloud doesn't copy them, and its inbox doesn't show
   them), and **keep the old Mux account** until step 5 is finished.
8. Cut `.railway/railway.ts` down to the site and Redis (what `--cloud --railway` writes,
   keeping the site's own names). *Check:* `railway config plan` shows nothing to create
   or change.

**Retiring can't be undone by git.** Deleting a bucket, a service or an account is the
person's call: say what's ready to go and let them do it, or do it when they say so.
Everything before step 7 can be reverted with git and the host's variables.

**The way back** (cloud to self-hosted): `npx caracms init --self-hosted --write` writes
the field and prints the README's leaving notes: copy the site's cloud folder to a bucket
of your own (the keys in content stay the same), set the self-hosted variables, and stand
up what the mode needs on the host (section 2).

## 4. When the cloud says no

The cloud refuses in its own sentence, and caracms shows that sentence as it is: in the
build log, on `/admin` (a 503, with the public site still serving), in the editor while
it's open, in `media push` / `media import` output, or on a submission in the inbox.
**Never answer a refusal by setting the site's own variables:** with
`services: 'cloud'` they're ignored.

Who's who: **CaraCMS** runs the cloud (staff, in admin.caracms.com); the **site's team**
owns the site in app.caracms.com (its keys, its repo). Limits and switching a team on
are CaraCMS's; keys and the repo are the team's.

| The sentence (its code) | What to do |
|---|---|
| "This site has reached its storage limit in CaraCMS Cloud (…). Ask CaraCMS to raise it." (`upload_limit`) | Uploads and `media push` stop there. Tell the person: CaraCMS raises the limit. Then run `media push` again (it skips what's copied). Don't delete images to make room. |
| "This site has reached its video limit in CaraCMS Cloud (…). Ask CaraCMS to raise it." (`video_limit`) | New clips are refused; existing ones play. CaraCMS raises it. A clip counts once Mux has finished it, so one upload can go past the limit. |
| "Not emailed: this site reached its daily email limit in CaraCMS Cloud (…). Ask CaraCMS to raise it." (on a submission in the inbox) | The submission is stored and readable in the inbox; its email is never sent later. The limit is 50 a day (UTC) unless CaraCMS has set another, and CaraCMS can raise it. For a test, a laptop never emails (submissions go to `.caracms/submissions/`, emails to the log). |
| "This site has no domains set in CaraCMS Cloud yet, so sign-in links can't be sent. A team owner can add them in app.caracms.com." (`wrong_address`) | The cloud sends no sign-in link until the site's domains are set. A team owner adds every address the editor is opened at (the live domain, each branch environment's) on the site's page in app.caracms.com. The backup sign-in (`CARACMS_BACKUP_USER` / `_PASSWORD`) still works, if it's set. |
| "This sign-in link goes to <host>, which isn't one of the site's domains in CaraCMS Cloud, so it wasn't sent. …" (`wrong_address`) | The editor was opened at an address not in the site's domains (a new environment, a preview URL). A team owner adds that domain in app.caracms.com, or sign in at one that's listed. |
| "This site has sent the most sign-in emails CaraCMS Cloud sends in a day. Try again tomorrow." (`sign_in_limit`) | Sign-in links stop until the next day. The backup sign-in (`CARACMS_BACKUP_USER` / `_PASSWORD`) still works, if it's set. |
| "This site's team is switched off. Ask CaraCMS to switch it back on." (`team_off`) | Builds fail, `/admin` answers 503, the running site's public pages keep serving. Only CaraCMS can switch it back on; tell the person. |
| "That site key was revoked. Make a new one in app.caracms.com." (`revoked_key`) | Make a new labelled key for that place (host, laptop, staging), set it where the old one was (the host's variable or `.env`), redeploy or restart. Don't reuse another place's key. |
| "That site key isn't one we know." (`unknown_key`) | A mistyped or truncated key, a key for a deleted site, or `CARACMS_CLOUD_URL` pointing at another cloud. Check the variable's value has no stray quotes or spaces, unset `CARACMS_CLOUD_URL`, else make a new key. |
| "The caracms GitHub App isn't installed on <repo>, or that repo doesn't exist. Install the App on it: <link>" (`app_not_installed`) | Install the App from the link on that repo only. The cloud refreshes its record of the install only when the site's page in app.caracms.com opens (or a repo is linked, or the site mints a token), so open the site's page there, then run `init --cloud` again: it shows "App installed". The next visit to `/admin` tries again. If it is installed, the repo linked in app.caracms.com is the wrong one: the team fixes it there (a changed repo reaches the site at its next start). |
| "This site has no GitHub repo in CaraCMS Cloud yet. A team owner can pick one in app.caracms.com." (`no_repo`; what `/admin` shows) | A team owner links the repo in app.caracms.com, then the App goes on it. The site still builds meanwhile. |
| "CaraCMS Cloud couldn't be reached, so the site can't be built. Try again in a minute." (`unreachable`) | Retry the build. A running site keeps serving. If it persists, tell the person; don't switch the mode. |
| "This site runs on CaraCMS Cloud (caracms.config.ts), but CARACMS_CLOUD_KEY isn't set. Make a key for it in app.caracms.com." | Not the cloud refusing: the key is missing where the site is built or runs (section 1). Expected during the move's steps 2–3. |

The README's *Hosting → CaraCMS Cloud* has each of these in context.
