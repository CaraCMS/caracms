# create-caracms

`npm create caracms` makes a new [caracms](https://www.npmjs.com/package/caracms) site: a blank Astro site with caracms on it, ready to run.

```sh
pnpm create caracms
```

(or `npm create caracms`, `yarn create caracms`, `bun create caracms`: it uses whichever it was run with.)

It asks four things:

- **The site's folder.** Made new, beside where you ran the command.
- **Tailwind?** Yes by default.
- **Where it runs.** CaraCMS Cloud (sign-in, media, email and forms come from the cloud) or Standalone (the site brings its own GitHub access, buckets and imgproxy).
- **Where it's deployed.** Railway, which writes `.railway/railway.ts`, or decide later, which lists the variables any host needs.

Then it runs, in the new folder:

1. `create-astro` with the minimal template (no install, no git, no agent files).
2. An install of the newest published Astro, Tailwind if asked for, and caracms pinned to an exact version.
3. `git init` and a first commit.
4. `caracms init --write`, with your answers. This is the same command an existing site runs, so a new site gets the same config, page component, catch-all route, schemas, skills and `CLAUDE.md` block.
5. A Home page as a caracms document (`content/pages/index.json`) in place of Astro's `src/pages/index.astro`, and Tailwind's stylesheet imported in the page component.
6. A second commit.

When it's done, `pnpm dev` runs the site, with the editor at `/admin`. A Cloud site needs a key (`CARACMS_CLOUD_KEY` in `.env`, from app.caracms.com) before it will build.

## Flags

Every question has a flag, so a script or an agent can run it without a terminal. Outside a terminal nothing is asked: the folder and `--cloud` or `--standalone` are required, and the rest take their defaults.

```sh
pnpm create caracms my-site --cloud --deploy railway
```

- `--cloud` / `--standalone`
- `--deploy railway` (default) or `--deploy none`
- `--tailwind` (default) / `--no-tailwind`
- `--pm pnpm|npm|yarn|bun`: default, the one the command was run with
- `--dry-run`: print the commands and run nothing

With npm, flags go after a `--`: `npm create caracms my-site -- --cloud`.

## An existing site

Run inside an Astro site, it stops and points at `npx caracms init`, which adds caracms to the site that's there.

If a step fails, what was made so far stays in the folder, with the command that failed and what it printed.

MIT licensed. caracms is unsupported: use it as it is.

CaraCMS is a trademark of Caracode. The MIT license covers the code, not the name: a fork or a hosted service needs a name of its own.
