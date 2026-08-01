# Tax Form Annotation System

A specification for annotating fields and boxes on U.S. tax forms, so that any
application — using its own proprietary code — can print values from a deeply nested
data set into exactly the right boxes on the form.

## What's here

| Path | What it is |
|------|------------|
| [`SPEC.md`](SPEC.md) | **The specification.** Normative prose: coordinate system, field types, formatting rules, data-binding grammar, and the rendering contract an implementation must follow. |
| [`DESIGN.md`](DESIGN.md) | The *why*: key design decisions, trade-offs considered, and future enhancements. |
| [`schema/annotation.schema.json`](schema/annotation.schema.json) | JSON Schema (draft 2020-12) for validating annotation documents. |
| [`types/annotation.ts`](types/annotation.ts) | TypeScript definitions mirroring the schema — the shape an implementation consumes. |
| [`examples/f1040.annotation.json`](examples/f1040.annotation.json) | A worked annotation of Form 1040 (2025) exercising every field type. |
| [`examples/sample-data.json`](examples/sample-data.json) | A nested taxpayer data set the example annotation binds against. |
| [`examples/f1040--2025.pdf`](examples/f1040--2025.pdf) | The official blank IRS Form 1040 the annotation was measured against. |
| [`renderer/render.ts`](renderer/render.ts) | Proof-of-concept renderer (TypeScript + pdf-lib) implementing the SPEC §7 pipeline, typed against `types/annotation.ts`. |
| [`out/`](out/) | Rendered demo output: the filled 1040 and a debug version with field outlines. |

> The example's coordinates were measured from the field positions of the official
> fillable IRS PDF, so the demo output lines up with the real 2025 form.

## The idea in one diagram

```
┌────────────────────┐     ┌──────────────────────┐     ┌────────────────┐
│ Annotation document │     │ Caller's data set    │     │ Blank form PDF │
│ f1040.annotation    │     │ (any nested JSON)    │     │ f1040--2025    │
└─────────┬──────────┘     └──────────┬───────────┘     └───────┬────────┘
          │      where + how               what                  on what
          └──────────────┬────────────────┴─────────────────────┘
                         ▼
              ┌─────────────────────┐
              │  Renderer           │   (anyone's proprietary code,
              │  resolve → transform │    written once, form-agnostic —
              │  → format → draw     │    per the contract in SPEC.md §7)
              └─────────┬───────────┘
                        ▼
               Completed Form 1040
```

The annotation document is the entire contract between the three parties. A tax expert
annotates each form revision once; engineers never hard-code a form; the caller's data
model stays whatever shape it already is.

## Sixty-second tour

Positioning is in PDF points from the **top-left** of the page (SPEC §3). A wage line is
one field:

```json
{ "id": "line-1a", "type": "currency", "page": 1,
  "rect": { "x": 498, "y": 430, "w": 78, "h": 14 },
  "binding": "$.return.income.w2s",
  "transforms": [ { "fn": "sum", "args": { "path": "@.box1" } } ],
  "required": true }
```

* **`binding`** reaches into the caller's nested data with a tiny JSONPath subset —
  `$.return.income.w2s`, `$.dependents[2].ssn` (SPEC §6).
* **`transforms`** derive printed values (here: total box 1 across all W-2s).
* **`type`** selects formatting + layout behavior: `text`, `number`, `currency` (IRS
  whole-dollar rounding, `(1,234)` negatives), `date`, `comb` (one character per box,
  for SSNs), `checkbox`, `radio-group` (filing status), and `table` (repeating entries
  offset by `(dx, dy)` — down for classic tables, rightward for the 2025 1040's
  dependents grid) — SPEC §5.
* Overflow, missing data, and too-many-dependents all have specified, fail-loud
  behaviors (SPEC §5.8, §6.3, §7.4).

## Running the demo

```bash
npm install                # once; installs pdf-lib + TypeScript for the PoC renderer

# validate the annotation document against the schema
npx ajv-cli validate --spec=draft2020 --strict=false -s schema/annotation.schema.json -d examples/f1040.annotation.json

# fill the real 2025 Form 1040 with the sample data
npm run demo               # → out/f1040-filled.pdf

# same, plus red outlines around every annotated box (coordinate calibration view)
npm run demo:debug         # → out/f1040-debug.pdf
```

## Building a real renderer

`renderer/render.ts` is a working reference (~400 lines of TypeScript, importing
`types/annotation.ts` so the compiler enforces the field shapes), but any
implementation just follows SPEC §7: the six-step pipeline (resolve → default →
transform → validate → format → draw) over your PDF library of choice, converting
y-coordinates per SPEC §3. The conformance checklist is SPEC §9.
