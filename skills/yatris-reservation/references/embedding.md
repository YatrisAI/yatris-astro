# Embedding, theme and preview

## `<ReservationEmbed>`

The booking flow runs on the Yatris-hosted page (`book.yatris.jp`). The site
shows it with the `<ReservationEmbed>` component of `@yatris/astro`
(YatrisCMS#421):

```astro
<ReservationEmbed setupKey="consultation" />
```

- Read the component's documentation in the installed package
  (`node_modules/@yatris/astro/`) for its exact import path, props and
  preview flag before using it. If the installed version has no
  `ReservationEmbed`, stop after the declaration and report the embed as
  pending a package update (`npm run yatris:update`, only when asked). Never
  build the iframe, the messaging or a booking form yourself.
- The component carries only public Website identity, the setup key and
  validated theme tokens. Never pass a Delivery key, MCP token, OAuth or SMTP
  value, or visitor data to it.
- It handles the iframe title, loading, unavailable and retry states, its
  own height and a direct-link fallback to the hosted page. Style around it;
  never hide those states.
- Put it inside the site's layout at the content width, outside any
  fixed-height or `overflow: hidden` box, so its height can grow.
- **Unavailable is expected** while the site is unpaired or the setup is not
  published in Yatris. Report the pending step; never replace it with a fake
  booking or a "coming soon" form that collects bookings.

The page around the embed is site design: a heading, a short introduction
(what is booked, how long it takes, in person or online, whether staff
confirm requests) and the direct link if `embed.direct_link` asked for one.
Use only confirmed facts. Never print bookable hours or capacity on the page:
they change in Yatris without a deploy.

## Theme tokens

The theme contract (YatrisCMS#421) accepts only these tokens. There is no
arbitrary CSS and no script; the declaration has no theme.

| Token | Use |
| --- | --- |
| `primary` | Buttons, the selected date and time |
| `onPrimary` | Text and icons on `primary` |
| `background` | Page background inside the frame |
| `surface` | Panels and cards |
| `text` | Body text |
| `mutedText` | Secondary text, hints |
| `border` | Field and panel borders |
| `error` | Validation and error messages |
| `focus` | The keyboard focus ring |
| `fontFamily` | Body font stack |
| `headingFontFamily` | Heading font stack |
| `spacing` | `compact`, `comfortable` or `spacious` |
| `radius` | Corner radius, an integer from 0 to 24 |

- Derive the values from `src/styles/global.css` (`@theme`) and the layout;
  record them as `theme.tokens` in the brief and show them in the review.
- Fonts are **stacks only**, never font URLs, so the site's web font may
  not be available inside the frame. End every stack with a generic family
  (`sans-serif`, `serif`).
- Keep text readable: `text` on `background` and `surface`, and `onPrimary`
  on `primary`, at a contrast ratio of at least 4.5:1; `focus` clearly
  visible against `background`.
- The component validates the tokens and reports invalid ones. Fix the
  value; never work around it with CSS aimed at the frame.

## Preview

The embed has an explicit synthetic preview for `astro dev` (see its
documentation for the flag). It renders the local declaration against
**clearly labelled synthetic** hosts and availability.

- Every host, practitioner, table and free time in the preview is
  synthetic. Say so whenever you describe or show the preview, and never
  treat it as evidence that the setup works or that a slot exists.
- `astro build` refuses the preview, and synthetic data never reaches
  `dist/` or Yatris. Never set the preview flag in `.env` or the build
  environment, and never copy synthetic data into the declaration.
- Check in the preview: the visitor sequence of the mode (time slot: date →
  time → details; service: service → practitioner → date and time →
  details; party: party size → date and time → details), every question
  condition, required and format errors, the pending or confirmed outcome
  copy, keyboard use and a narrow screen. If you cannot open a browser, say
  the preview was not checked visually.

## Embedding origins and the direct link

- The booking page only renders inside origins Yatris staff registered for
  the Website. Discover the production origin (`site` in `astro.config.*`)
  and any preview origin, record them as `embed.origins`, and keep
  `embedding_origins` in `pending` until staff confirm the registration.
- The hosted page also works on its own, at the direct link the component
  uses for its fallback. Link to it elsewhere (a header button, a LINE
  message) only if `embed.direct_link` asked for it, and only on a paired
  site.
