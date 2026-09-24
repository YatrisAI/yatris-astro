# Changesets

Every user-visible change to `@yatris/astro` or `create-yatris` adds a
changeset (`npm run changeset`). The two packages are versioned together
(`fixed`), because each Yatris platform release pins one version of both.

`npm run version-packages` applies pending changesets and writes the
changelogs. Keep `platform/manifest.json` in step: a test fails if its package
versions differ from the workspace packages.

Publishing is not set up yet; it waits on the npm `@yatris` organisation
(YatrisAI/YatrisCMS#258).
