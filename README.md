# caracms

A visual CMS for Astro sites, with content in the site's own git repo. MIT.

| Folder | What it is |
|---|---|
| `packages/caracms` | The package: the editor, its server routes, sign-in, Publish, and the skills a site's agent reads |
| `packages/create-caracms` | `npm create caracms`, which says how to add caracms to an Astro site |
| `starter` | The starter site, a small site about CaraCMS itself. It uses the package from this workspace |

To use caracms on a site, start with [`packages/caracms/README.md`](packages/caracms/README.md).

## Run it

```sh
pnpm install
pnpm dev          # the starter at http://localhost:4326, the editor at /admin
pnpm build        # builds the package's dependents and the starter
pnpm start        # serves the built starter
```

`AGENTS.md` says which tests to run when.

## Contributing

Pull requests aren't being taken for now. Bug reports are welcome as issues.

Planning notes (the spec, the milestone plan, each feature's decisions) are kept privately
and aren't in this repo. Code comments name a feature and a decision number ("runs-anywhere
Decision 17") so the reasoning can be asked about; they don't point at a file here.

## Licence and name

The code is MIT-licensed: see [`LICENSE`](LICENSE).

CaraCMS is a trademark of Caracode. The MIT license covers the code, not the name: a fork
or a hosted service needs a name of its own.
