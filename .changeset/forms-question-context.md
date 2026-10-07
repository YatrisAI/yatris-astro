---
'@yatris/astro': minor
---

The forms contract gains question context and a sensitive marker, so reservations can reuse contact-form questions (YatrisCMS#418). Every input except `quiz` accepts `sensitive: true`; a `{{field.<key>}}` mail placeholder naming a sensitive field is rejected with the new `sensitive_placeholder` code, and consumers must keep sensitive answers off every outbound surface. The new `validateQuestions(fields, { context })` checks a bare node list with every node and condition rule of a declaration, and conditions may reference read-only context keys such as `booking.service_key`, which `evaluateActivity` and `validateSubmission` compare against consumer-supplied `contextValues`. Visitors can never set context values. Existing declarations validate and evaluate exactly as before; the new rules are covered by `fixtures/context.json` and two new declaration fixtures.
