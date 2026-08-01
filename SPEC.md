# Tax Form Annotation Specification

**specVersion 1.0**

This document is the normative specification for annotating fields and boxes on U.S. tax
forms. An *annotation document* describes, for one revision of one form, where every
fillable box is, how values must be formatted inside it, and which value from a caller's
nested data set belongs there. Given an annotation document, a data set, and the blank
form PDF, an application with no knowledge of the specific form can print a completed
return.

Machine-validatable structure: [`schema/annotation.schema.json`](schema/annotation.schema.json)
(JSON Schema, draft 2020-12). Language bindings: [`types/annotation.ts`](types/annotation.ts).
A complete worked example is in [`examples/`](examples/).

The key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as in RFC 2119.

---

## 1. Design goals

1. **Separation of roles.** The *annotator* measures a form once; the *implementer* writes
   a renderer once; the *caller* supplies data. None needs to know about the others'
   internals. The annotation document is the entire contract.
2. **Implementable in an afternoon, in any language.** Everything a renderer must do —
   path resolution, formatting, layout — is specified closed-form. The binding language is
   deliberately a small JSONPath subset so no third-party JSONPath engine is required.
3. **Faithful to real IRS forms.** The field-type set was chosen by walking real forms:
   whole-dollar money lines, one-character-per-box SSN combs, mutually exclusive filing
   status boxes, and repeating dependent rows are all first-class, not conventions layered
   on top of "text".
4. **Fail loudly where money is involved.** Silent truncation of a dollar amount is worse
   than an error. Defaults are chosen accordingly (see §7.4, §5.8).

## 2. Document model

An annotation document is a single JSON object:

| Property      | Req | Meaning |
|---------------|-----|---------|
| `specVersion` | ✓   | Always `"1.0"` for this spec. Renderers MUST reject other values. |
| `form`        | ✓   | Identity: `id` (e.g. `"f1040"`), `revision` (e.g. `"2025"`), optional `title`, `jurisdiction`, `sourcePdf`. |
| `pages`       | ✓   | One entry per annotated page; establishes the coordinate space (§3). |
| `defaults`    |     | Document-wide style defaults (§4). |
| `fields`      | ✓   | The annotated boxes (§5). |

**Form identity.** Coordinates are only meaningful against one printing of one form. The
pair (`form.id`, `form.revision`) MUST uniquely identify the annotation; the IRS moves
boxes between years, so the 2025 and 2026 Form 1040 are two separate annotation documents.
`sourcePdf` SHOULD name the exact blank PDF the coordinates were measured against.

## 3. Coordinate system

* **Unit:** PDF points, 1 pt = 1/72 inch. US Letter is 612 × 792 pt.
* **Origin:** the **top-left corner of the page**, x increasing rightward, y increasing
  **downward**.
* Every field names its `page` (1-based index into the source PDF).

The top-left origin is deliberate: humans and annotation tools measure forms from the top,
and screen coordinates work the same way. PDF's native coordinate system has a
bottom-left origin with y increasing upward; renderers drawing with a PDF library MUST
convert:

```
pdf_x = x
pdf_y = page.height − y − h      # y of the rect's bottom edge, in PDF space
```

A **rect** `{x, y, w, h}` describes a box: `(x, y)` is its top-left corner. Rects SHOULD
trace the printed box on the form; the renderer handles insetting via `padding` (§4).

## 4. Styles

Style properties may appear in `defaults` (document-wide) and in any field's `style`
(field-level). Resolution order for each individual property: **field → defaults → spec
default**, where the spec defaults are:

| Property      | Default       | Meaning |
|---------------|---------------|---------|
| `font.family` | `"Helvetica"` | Font family name. Renderers MUST substitute a metrically similar font if unavailable. |
| `font.size`   | `9`           | Point size. |
| `font.weight` | `"normal"`    | `normal` \| `bold`. |
| `font.color`  | `"#000000"`   | `#rrggbb`. |
| `align`       | `"left"`      | Horizontal alignment within the padded rect. |
| `vAlign`      | `"middle"`    | Vertical alignment within the padded rect. |
| `padding`     | `2`           | Inset in points applied to all four rect edges before layout. |
| `overflow`    | `"shrink"`    | See §7.4. |
| `minFontSize` | `5`           | Floor for `shrink`. |
| `lineHeight`  | `1.15`        | Line-height multiplier for multiline text. |

Type-level defaults override these where noted (e.g. `currency` fields default to
`align: "right"`, §5.3).

## 5. Field types

All fields share the base properties: `id` (unique in the document; convention is the
form's own line label, e.g. `"line-1a"`), `label`, `page`, `binding` (§6), `required`,
`default`, `transforms`, `style`, `notes`.

`required`/`default` semantics: if the binding resolves to *missing* (§6.3):
with `required: true` the render MUST fail with an error naming the field; otherwise, if
`default` is present that value is used, else the field is **skipped** (nothing printed —
the correct behavior for, say, an absent spouse SSN).

### 5.1 `text`

Free text in a rect. `multiline: true` enables word-wrapping (§7.3); `case: "upper"`
uppercases after transforms; `maxLength` caps the character count, with excess handled by
the overflow policy.

```json
{ "id": "first-name", "type": "text", "page": 1,
  "rect": { "x": 36, "y": 130, "w": 190, "h": 14 },
  "binding": "$.taxpayer.firstName", "required": true }
```

### 5.2 `number`

A general numeric value (percentages, counts, years). Format options: `decimals` (default
0), `thousands` (default true), `negative` (`"parens"` default \| `"minus"`), `zero`
(`"print"` default \| `"blank"` \| `"dash"`). Default `align` is `"right"`.

### 5.3 `currency`

A dollar amount. Same options as `number`, constrained to IRS practice:

* `decimals`: `0` (default) or `2`. With `0`, the renderer MUST round **half away from
  zero** (the IRS "round half up" rule: 50¢ rounds to the next dollar, −$1.50 to −$2).
* `symbol` (default `false`): leading `$`. IRS boxes pre-print the symbol, so leave false.
* `negative` default `"parens"` — the IRS-preferred loss notation: `(1,234)`.
* Default `align` is `"right"`; `vAlign` `"middle"`.

The value after transforms MUST be a JSON number. Renderers MUST NOT accept numeric
strings silently; that is a data error.

```json
{ "id": "line-1a", "type": "currency", "page": 1,
  "rect": { "x": 500, "y": 330, "w": 76, "h": 14 },
  "binding": "$.income.wages.w2Box1Total", "required": true }
```

### 5.4 `date`

Input MUST be an ISO-8601 date string (`YYYY-MM-DD`) after transforms. `pattern` (default
`"MM/DD/YYYY"`) is the output template; the tokens `YYYY`, `YY`, `MM`, `DD` are replaced
(zero-padded), all other characters are literal. Forms with separate month/day/year boxes
are annotated as multiple `date` fields with patterns `"MM"`, `"DD"`, `"YYYY"` bound to
the same path.

### 5.5 `comb`

One character per printed box — SSNs, EINs, ZIP codes, routing numbers. Instead of one
rect, a comb gives:

* `cells` — number of boxes;
* `cellOrigin` — top-left of the **first** cell;
* `pitch` — distance between left edges of adjacent cells;
* `cellSize` — `{w, h}` of each cell;
* `gaps` — optional extra spacing after given cells (SSN forms leave hyphen gaps after
  cells 3 and 5);
* `strip` — regex of characters to remove from the value first (default strips everything
  non-alphanumeric, so `"123-45-6789"` and `"123456789"` annotate identically);
* `fit` — `"exact"` (default): after stripping, the value's length MUST equal `cells`; a
  mismatch is a render error (a 7-digit "SSN" must never print). `"left"`: the length
  MUST be ≤ `cells`; cells fill from cell 1 and the remainder stay blank — the right
  behavior for bank account numbers, which the 1040 gives 17 boxes.

Layout: cell *i* (1-based) has left edge
`x_i = cellOrigin.x + (i−1)·pitch + Σ gaps.extra for gaps with afterCell < i`.
Each character is drawn centered in its cell.

```json
{ "id": "taxpayer-ssn", "type": "comb", "page": 1,
  "binding": "$.taxpayer.ssn", "required": true,
  "cells": 9, "cellOrigin": { "x": 480, "y": 96 },
  "pitch": 12, "cellSize": { "w": 11, "h": 14 },
  "gaps": [ { "afterCell": 3, "extra": 5 }, { "afterCell": 5, "extra": 5 } ],
  "strip": "[^0-9]" }
```

### 5.6 `checkbox`

A single box marked or left empty. `checkedWhen` holds exactly one predicate:
`{ "equals": v }` (strict equality against the resolved value — type-sensitive, `1` ≠ `"1"`)
or `{ "truthy": true }`. `mark` is `"X"` (default), `"check"` (✓), or `"fill"` (solid
fill at 70% of the rect). Marks are drawn centered in the rect, sized to ~80% of
`min(w, h)`. An unchecked box prints nothing.

A yes/no question with two printed boxes (e.g. the 1040 digital-assets question) *can*
be expressed as two `checkbox` fields on the same binding — `equals: true` and
`equals: false` — but SHOULD be one `radio-group` (option values may be any JSON
scalar, including booleans): the radio-group type guarantees at most one mark, whereas
a checkbox pair is only exclusive if the annotator's predicates happen to be. Reserve
`checkbox` for genuinely independent boxes — and for table columns, where `radio-group`
is not permitted (§5.8).

### 5.7 `radio-group`

One binding, several mutually exclusive boxes; the option whose `value` strictly equals
the resolved value is marked, all others stay empty. If no option matches: `required:
true` → error; otherwise nothing is marked. This is the natural shape for filing status:

```json
{ "id": "filing-status", "type": "radio-group", "page": 1,
  "binding": "$.filingStatus", "required": true,
  "options": [
    { "value": "single",  "rect": { "x": 40, "y": 78, "w": 9, "h": 9 }, "label": "Single" },
    { "value": "mfj",     "rect": { "x": 88, "y": 78, "w": 9, "h": 9 }, "label": "Married filing jointly" }
  ] }
```

### 5.8 `table`

Repeating entries bound to an **array** (dependents on the 1040, payers on Schedule B).

* `repeat` — `{max, dx, dy}`: the form provides `max` printed entries; entry *i*
  (1-based) is drawn with every column offset by `((i−1)·dx, (i−1)·dy)` from its stated
  position. A classic top-to-bottom table sets `dy` to the row height and `dx: 0`.
  Repetition is a 2-D offset rather than "next row down" deliberately: the 2025
  Form 1040 lays its four dependents out **left-to-right** as columns of a grid
  (`dx: 108, dy: 0`), which a rows-only model cannot express. At least one of
  `dx`/`dy` MUST be non-zero when `max > 1`.
* `columns` — an array of ordinary fields (any type except `table` and `radio-group`),
  positioned **for entry 1**. Columns omit `page` (inherited from the table).
* Inside columns, bindings use `@` — the current entry's array element (§6.2).
* `overflow` — when the bound array is longer than `repeat.max`:
  * `"error"` (default): fail. Safe default; overflowing dependents silently is a filing error.
  * `"truncate"`: print the first `repeat.max` items. The renderer MUST surface a warning.
  * `"continuation"`: print the first `repeat.max` items and report the remainder (item
    indices + table id) to the caller, who is responsible for producing an attachment
    statement, per IRS practice ("see attached statement").

An empty or missing array with `required: false` simply prints no entries.

## 6. Data binding

### 6.1 Path grammar

A binding is a string conforming to:

```
binding  = root segment*
root     = "$" | "@"
segment  = "." name index?
name     = [A-Za-z_][A-Za-z0-9_]*
index    = "[" [0-9]+ "]"
```

`$` is the root of the caller's data set; `@` is the current row element and is valid
**only** inside table columns. Examples:

```
$.taxpayer.ssn
$.income.interest.schedule[0].amount
@.relationship
```

This is intentionally a subset of JSONPath — descendant search (`..`), wildcards (`[*]`),
filters, and slices are excluded, so resolution needs ~20 lines of code in any language
and every path names exactly one value. Annotators who need "the third W-2's box 1" write
`$.w2s[2].box1` — explicit index, zero ambiguity.

### 6.2 Resolution

Starting from the root object (`$`) or current row element (`@`), apply each segment:
member access by `name`, then, if present, element access by zero-based `index`. Member
access on a non-object, index access on a non-array, an absent member, or an out-of-range
index all resolve to **missing** (not an error at resolution time — see §6.3). A resolved
JSON `null` is treated as missing.

### 6.3 Missing values

Missing flows into the `required`/`default` logic of §5: error if `required`, else
`default` if present, else skip the field. This three-way rule is the entire
error-handling model; renderers MUST NOT invent additional fallbacks (e.g. printing
`"undefined"`).

### 6.4 Transforms

`transforms` is an ordered pipeline applied to the resolved value before formatting. A
step is either a name (`"abs"`) or `{ "fn": ..., "args": {...} }`. Within transform
arguments, path strings are resolved with `$` = the data-set root and `@` = the
transform's **input value** (for `sum`, each element of the input array in turn) — this
lets one field bind an object or array and derive its printed value from several members.
Conforming renderers MUST implement:

| fn | Args | Effect |
|----|------|--------|
| `abs` | — | Absolute value of a number. |
| `negate` | — | Multiply by −1. |
| `round` | `decimals` (default 0) | Round half away from zero. |
| `sum` | `path` | Value must be an array; sums `path` (an `@`-rooted binding) over its elements. `{"fn":"sum","args":{"path":"@.box1"}}` on `$.w2s` totals wages. |
| `count` | — | Length of an array. |
| `concat` | `paths`, `separator` (default `" "`) | Joins the values at several `$`/`@`-rooted paths, skipping missing ones. Used for "First name and middle initial" boxes. |
| `uppercase` / `lowercase` | — | Case-map a string. |
| `trim` | — | Strip surrounding whitespace. |
| `sliceString` | `start`, `end` | Substring, zero-based, end-exclusive. E.g. last-4-of-SSN = `{"start":5}` after stripping. |

Unknown transform names MUST be a render error, not a no-op — a skipped `abs` changes a
number's meaning. Transforms that receive an inapplicable type (e.g. `abs` of a string)
are render errors. Note `transforms` runs on the *resolved* value, so a field whose value
is computed from several inputs binds the nearest common ancestor and transforms from
there (see `line-1a` vs. `sum` example above).

## 7. Rendering contract

Given (annotation document, data set, blank PDF), a conforming renderer MUST, for each
field, in order:

1. **Resolve** the binding (§6.2) — for tables, resolve the array, then process each row.
2. **Apply** `required`/`default` (§6.3); skip the field if it comes up empty.
3. **Transform** (§6.4).
4. **Validate the type** expected by the field (`currency`/`number` → JSON number,
   `date` → ISO date string, `comb` → string of exactly `cells` chars after strip,
   `checkbox`/`radio-group` → any scalar, `table` → array).
5. **Format** to a string (§7.2) — not applicable to checkbox/radio/fill marks.
6. **Lay out and draw** within the padded rect (§7.3–§7.4), converting coordinates to the
   PDF library's space (§3).

Fields are independent; render order doesn't matter. All errors mandated by this spec
MUST identify the field `id` and, for table rows, the row index.

### 7.1 Text measurement

"Fits" means: rendered width ≤ `rect.w − 2·padding` and height ≤ `rect.h − 2·padding`,
using the actual metrics of the font the renderer selected.

### 7.2 Formatting

* **number/currency:** round to `decimals` (half away from zero), group thousands with
  `,` if `thousands`, render the fraction with `.`. Negative: wrap the whole rendered
  amount, symbol included, in parentheses for `"parens"` (`($1,234)`), or prefix `-` for
  `"minus"`. Exact zero: per `zero`
  policy — `"print"` → `0` (or `0.00`), `"blank"` → skip the field, `"dash"` → `—`.
* **date:** apply `pattern` tokens (§5.4).
* **text:** apply `case`, then `maxLength` check (overflowing `maxLength` follows the
  overflow policy, where `shrink` is meaningless and treated as `truncate`).

### 7.3 Layout

Single-line text is placed in the padded rect per `align`/`vAlign`. Multiline text
(`multiline: true`) word-wraps greedily at spaces to the padded width, with baseline
spacing `font.size × lineHeight`; `vAlign` positions the resulting block.

### 7.4 Overflow

When formatted text does not fit (§7.1) at the effective font size:

* `"shrink"` (default): reduce the font size in 0.25 pt steps until it fits or
  `minFontSize` is reached; if it still doesn't fit at `minFontSize`, escalate to an
  error. Numbers stay legible; nothing is ever silently lost.
* `"truncate"`: cut characters off the end until it fits. The renderer MUST surface a
  warning. SHOULD only be used on cosmetic fields (e.g. occupation).
* `"error"`: fail immediately. Use for fields where a partial value would be filed
  incorrectly.

## 8. Conventions & versioning

* Field `id`s SHOULD mirror the form's printed labels (`line-1a`, `line-16`,
  `dependents`), making annotations reviewable against the paper form.
* Annotation files SHOULD be named `<form.id>.annotation.json` and stored per revision.
* This spec is versioned by `specVersion`. Additions of new field types or transforms
  will bump the minor version; renderers encountering an unknown `type` under a
  same-major version MUST error (never skip a box silently).

## 9. Conformance checklist

A renderer conforms if it: validates documents against the JSON Schema (or equivalent);
implements §3 coordinate conversion; resolves the full §6.1 grammar; implements all §6.4
transforms; implements every §5 field type with the §7 pipeline; and reports every
MUST-level error with the offending field id.
