# create-yatris 0.0.0-bootstrap.0: nonfunctional placeholder

**Do not use this version. It creates nothing, and running it prints an error and exits 1.**

It exists only because npm can configure trusted publishing for a package that
already exists, and for no other. This placeholder created the package once, by hand, under
the `bootstrap` dist-tag, so that every real release can be published by the
Yatris release workflow through npm trusted publishing (OIDC), with provenance
and without a stored token.

Real releases come only from `.github/workflows/release.yml` in
[YatrisAI/yatris-astro](https://github.com/YatrisAI/yatris-astro).
