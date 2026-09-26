# One-time npm bootstrap (owner only)

npm can configure trusted publishing only for a package that already exists
([npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/)). These two
**nonfunctional placeholders** create `@yatris/astro` and `create-yatris` once,
by hand, so that every real release can be published by
`.github/workflows/release.yml` through trusted publishing (OIDC), with
provenance and no stored token (YatrisAI/YatrisCMS#258).

| Package | Version | dist-tag | What it does |
|---|---|---|---|
| `@yatris/astro` | `0.0.0-bootstrap.0` | `bootstrap` | Importing it throws an error that says it is a placeholder |
| `create-yatris` | `0.0.0-bootstrap.0` | `bootstrap` | Running it prints that it is a placeholder, creates nothing, exits 1 |

Neither has install scripts or dependencies. `yatris update` and Yatris's
update PRs never select them: they are prereleases, they have no provenance,
and they carry no `released` marker. A unit test keeps it that way
(`packages/astro/src/update/bootstrap.test.ts`).

Nothing here is part of the build, the tests' packages or the release. Run
these commands only when you decide to, from this directory of a checkout.

## 0. Before you start

- npm **11.15.0 or later** (`npm trust` needs it): `npm install --global npm@11.20.0`
- Two-factor authentication enabled on your npm account.

```sh
npm --version
npm login --auth-type=web
npm whoami
```

## 1. Create the organisation (npmjs.com)

On npmjs.com: your avatar → **Add Organization** → name `yatris` (free plan,
public packages). There is no npm CLI command for this. The organisation owns
the `@yatris` scope, which `@yatris/astro` needs.

## 2. Review exactly what would be published

```sh
cd bootstrap/yatris-astro
npm pack --dry-run
node -e "import('./index.js').catch((e) => { console.log('fails as intended:', e.message); })"
npm publish --tag bootstrap --dry-run

cd ../create-yatris
npm pack --dry-run
node cli.js; echo "exit code $?"
npm publish --tag bootstrap --dry-run
```

Each `npm pack --dry-run` should list exactly `package.json`, `README.md` and
`index.js` (or `cli.js`). Each dry-run publish must print
`Publishing to https://registry.npmjs.org/ with tag bootstrap and public access (dry-run)`
and `+ <package>@0.0.0-bootstrap.0`.

## 3. Publish the placeholders under `bootstrap`

```sh
cd bootstrap/yatris-astro
npm publish --tag bootstrap --access public

cd ../create-yatris
npm publish --tag bootstrap --access public
```

**Always pass `--tag bootstrap`.** Without it npm publishes to `latest`: a dry
run without `--tag` reports `with tag latest` on both npm 11.6.2 and 11.20.0.
npm does not reliably honour a `publishConfig.tag`, so the placeholders do not set one. Before each
real publish, the step 2 dry run must print `with tag bootstrap`. npm asks for
your one-time password on each publish.

Then check the tags:

```sh
npm view @yatris/astro dist-tags
npm view create-yatris dist-tags
```

Expect `bootstrap: '0.0.0-bootstrap.0'`. npm's documentation does not say
whether the registry also creates `latest` for a package's very first version.
If it does, `latest` points at the placeholder until the first real release
(the release workflow publishes to `latest`, which moves it). Anything that
resolves the placeholder fails immediately with the placeholder message, so
nothing can use it by accident.

## 4. Trust the release workflow, then disallow tokens

```sh
npm trust github @yatris/astro --file release.yml --repo YatrisAI/yatris-astro --env npm-release --allow-publish --dry-run
npm trust github @yatris/astro --file release.yml --repo YatrisAI/yatris-astro --env npm-release --allow-publish
npm trust github create-yatris --file release.yml --repo YatrisAI/yatris-astro --env npm-release --allow-publish
npm trust list @yatris/astro
npm trust list create-yatris
```

Then, on npmjs.com, for **each** package: **Settings → Publishing access →
Require two-factor authentication and disallow tokens**. Trusted publishing
keeps working, and a token can no longer publish either package.

Optionally, move `create-yatris` (unscoped, so owned by your account) into the
organisation's maintainers so it does not depend on one person.

## 5. Stop here

The first real release (0.1.0) happens only after the stack is merged to
`main` and you run **Release** and approve the `npm-release` environment.
