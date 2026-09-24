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

Nothing is published yet (YatrisAI/YatrisCMS#258).

## Branches

- All work happens on `development`.
- `main` advances only through `development → main` pull requests, merged
  with a merge commit (never squash or rebase). One issue per pull request.
