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

## Development

Requires Node.js 22.12 or later.

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

A platform release is an `@yatris/astro` version whose `yatrisPlatform.status`
(in `packages/astro/package.json`) and `platform/manifest.json` `status` are
both `released`; a unit test keeps the two identical. Publishing alone does not
make a release: `yatris update` and Yatris's automatic update PRs pick the
newest *approved* stable version, skip published versions that are not
approved, and never read npm dist-tags such as `latest`. Flip the status only
in a release pull request whose CI — unit tests, the pack smoke test and the
end-to-end create-and-update run against the pinned matrix — has passed.

## Branches

- All work happens on `development`.
- `main` advances only through `development → main` pull requests, merged
  with a merge commit (never squash or rebase). One issue per pull request.
