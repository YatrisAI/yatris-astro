# Condition grammar

Authoritative: `contracts/forms/v1/README.md` §3 in `@yatris/astro`. No
JavaScript, regular expressions or code anywhere: conditions are data.

## Where conditions go

- `visibleWhen` on any node (input, display node or `group`): the node is
  shown only while the condition holds. A node inside a group is shown only
  while the group is too.
- `requiredWhen` on an input: the field becomes required while the
  condition holds (and the field is shown). It never shows or hides
  anything.
- `required: true` applies only while the field is shown.

## Expression tree

```text
{ "all": [ <expr>, ... ] }        every item holds (1–20 items)
{ "any": [ <expr>, ... ] }        at least one holds (1–20 items)
{ "not": <expr> }
{ "field": "<input key>", "operator": "<op>", "value": <value> }
```

Nesting is at most 5 levels deep; an `in` list holds 1–50 values.

## Operators by referenced field

| Referenced field type | Operators |
| --- | --- |
| `text`, `textarea`, `email`, `tel`, `url`, `hidden` | `eq` `neq` `in` `contains` `isEmpty` `isNotEmpty` |
| `radio`, `select` | `eq` `neq` `in` `isEmpty` `isNotEmpty` |
| `checkboxes`, `multiselect` | `contains` `isEmpty` `isNotEmpty` |
| `number`, `range` | `eq` `neq` `in` `gt` `gte` `lt` `lte` `isEmpty` `isNotEmpty` |
| `date`, `time`, `datetime` | `eq` `neq` `gt` `gte` `lt` `lte` `isEmpty` `isNotEmpty` |
| `checkbox`, `acceptance` | `eq` (value `true` or `false`) |
| `file`, `quiz`, display nodes | cannot be referenced |

Values:

- `isEmpty` and `isNotEmpty` take no `value`.
- Choice fields compare option **values**, never labels.
- Numbers are decimals (`10`, `"10.5"`); dates `YYYY-MM-DD`, times `HH:MM`.
- `contains` takes a non-empty string: an option value for choice lists, a
  substring for text.

## How it evaluates

- A hidden field has no value. Its stale answer never satisfies anything,
  and it is never stored or mailed.
- Empty means absent, `""` or `[]`. `false` and `"0"` are values.
- `eq`, `in`, `contains`, `gt`… are false on an empty value; `neq` is true.

## Rejected (from `yatris forms validate`)

| Code | Cause |
| --- | --- |
| `unknown_reference` | The `field` key does not exist. |
| `self_reference` | A node refers to itself. |
| `reference_not_allowed` | A `file`, `quiz` or display node is referenced. |
| `invalid_operator` | The operator does not fit the referenced type. |
| `invalid_condition_value` | A choice value that is not an option, a bad decimal or date, a value on `isEmpty`. |
| `condition_cycle` | Fields depend on each other in a loop through `visibleWhen`. |
| `invalid_condition`, `condition_too_deep` | Malformed tree, or deeper than 5. |

## Patterns

Show a field for one choice:

```json
{ "field": "customer_type", "operator": "eq", "value": "business" }
```

Show "Other" text when the "other" checkbox is ticked:

```json
{ "field": "services", "operator": "contains", "value": "other" }
```

Require a phone number only when the visitor wants a call:

```json
{ "field": "contact_method", "operator": "eq", "value": "phone" }
```

Show a group for either of two choices, unless a box is ticked:

```json
{
  "all": [
    { "field": "topic", "operator": "in", "value": ["repair", "warranty"] },
    { "not": { "field": "already_customer", "operator": "eq", "value": true } }
  ]
}
```

Confirm each branch with the user as a concrete sentence before writing it
("修理か保証を選び、既存のお客様でない場合だけ、この項目を表示します").
