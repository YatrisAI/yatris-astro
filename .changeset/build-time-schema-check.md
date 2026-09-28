---
'create-yatris': minor
'@yatris/astro': minor
---

A paired site's production build now enforces its schema contract (YatrisCMS#304). It reads `GET {yatris}/api/v1/sites/{id}/schema` and, when the Website is in revisioned schema mode, fails unless `.yatris/schema.lock.json` names the active revision and digest (or the pending one whose deployment precedes its activation) and the generated files verify against the lock. A build that cannot read Yatris fails too. Immediate-mode sites are not checked, and unpaired projects and `astro dev` make no request. Yatris lets a Website switch to revisioned mode only once its repository is on this release.
