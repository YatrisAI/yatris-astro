---
'@yatris/astro': patch
---

`yatris update` now adds `.yatris/forms.plan.json` to `.gitignore` when Git does not already ignore it (YatrisCMS#395). New sites get that rule from the template, but sites created before contact forms did not, so a local forms sync plan could be committed or deployed. `--dry-run` lists the rule; a site that already ignores the file is left alone.
