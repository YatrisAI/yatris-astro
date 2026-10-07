# yatris-astro

The Yatris managed Astro platform: the `create-yatris` initializer and the
`@yatris/astro` integration used by every Yatris-managed Astro website.

These packages exist to build and operate websites managed by Yatris. The
programme map, decisions and delivery order live in
[YatrisAI/YatrisCMS#188](https://github.com/YatrisAI/YatrisCMS/issues/188).

## Layout

| Path | Contents |
| --- | --- |
| `packages/astro` | `@yatris/astro`: the Astro integration, platform-manifest parsing, and the `yatris` CLI |
| `packages/create-yatris` | `create-yatris`: the project initializer |
| `platform/manifest.json` | The Yatris platform release: package, template, skill-pack and framework versions tested together |
| `template/` | Source of the generated managed-site project |
| `skills/` | Canonical agent skill pack, generated into both Codex and Claude locations |

`platform/manifest.json`, `template/` and `skills/` are the single sources;
`scripts/stage-package.mjs` copies them into each package at build time.

## Reading content

A site reads published content at build time with `getYatrisList`,
`getYatrisSingleton` and `getYatrisItem` from `@yatris/astro/delivery`. Each
item carries `position`: its 1-based place in an Ordered Content Type, or
`null` for every other structure (and from servers that predate Ordered
types). `getYatrisList` orders its result as follows:

- `sort` given: that order. `sort: 'position'` fails the build if any item
  has no position.
- No `sort`, every item has a position: lowest position first, ties by ID.
- Otherwise: most recently updated first.

## Contact forms

A site places a Yatris form with `<YatrisForm form="contact" />` from
`@yatris/astro/YatrisForm.astro`; the browser loads the published definition
from Yatris and submits to Yatris. `yatris forms validate` checks
`src/forms/*.json` offline, and `astro dev` with `YATRIS_FORMS_PREVIEW=1`
previews them locally without sending anything (builds refuse preview).
`yatris forms plan`, `apply --plan` and `pull` synchronize declarations with
Yatris drafts through the Product MCP (never publishing), recording the
baseline in `.yatris/forms.lock.json`; `yatris mail sync --env-file .env`
imports customer SMTP settings as a pending profile without ever printing
them. The contract, renderer, styling classes, CLI and exit codes are
documented in
[`contracts/forms/v1/README.md`](contracts/forms/v1/README.md).

## Development

Requires Node.js 22.19 or later (the pinned Astro stack depends on undici 8).

```sh
npm ci
npm run check   # build, unit tests, then pack-and-install smoke test
```

`npm run smoke` packs both packages as npm would publish them, installs the
tarballs offline into a throwaway project, and runs their entry points.

`npm run e2e` (after a build; needs network) runs the packed `create-yatris`
to generate a site, lets it install and build, then checks the output: Tailwind
and Alpine work, nothing loads from a CDN, no credentials leak, and Astro's own
`astro add tailwind alpinejs` finds nothing left to configure. Set
`E2E_KEEP=1` to keep the generated site in `.e2e/site` for inspection.

Nothing is published yet (YatrisAI/YatrisCMS#258).

## Platform releases

A platform release is made only by `.github/workflows/release.yml`, run on
`main` after a reviewer approves the `npm-release` environment. It runs the
compatibility matrix (`npm run check`, then the end-to-end create-and-update
run against the pinned versions), marks the release (`scripts/mark-released.mjs`
sets `yatrisPlatform.status` and the manifest `status` to `released` in its
own workspace; the repository always says `unreleased`), and publishes both
packages with npm provenance.

`yatris update` and Yatris's update PRs take the newest stable version whose
marker says `released` **and** whose npm provenance attestation names exactly
that workflow on `main`, for the exact tarball the registry serves, with the
signatures verified by `npm audit signatures`. A marker set any other way, a
version published by hand, or one built by another workflow or branch is
skipped. npm dist-tags such as `latest` are never read.

Publishing uses npm trusted publishing (OIDC), so no npm token is stored in
GitHub. npm can only trust a workflow for a package that already exists, so
each package needs a one-time bootstrap before the first release:

1. On npmjs.com, with two-factor authentication: create the `yatris`
   organisation (owning `@yatris`), and publish a placeholder of
   `@yatris/astro` and `create-yatris` by hand, for example
   `0.0.0-bootstrap.0`. A placeholder has no provenance and is a prerelease,
   so `yatris update` never selects it.
2. For each package, add a trusted publisher: GitHub Actions, repository
   `YatrisAI/yatris-astro`, workflow `release.yml`, environment
   `npm-release`. Then set publishing access to "Require two-factor
   authentication and disallow tokens".
3. Run the Release workflow on `main` and approve the `npm-release`
   environment. The first real release then becomes `latest`.

The alternative is a short-lived, package-scoped publish token that exists
only for the first run: add `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` to the
two publish steps, then configure trusted publishing, revoke the token and
remove the secret. The updater's provenance check holds either way.

## Branches

- All work happens on `development`.
- `main` advances only through `development → main` pull requests, merged
  with a merge commit (never squash or rebase). One issue per pull request.
