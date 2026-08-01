# Design Decisions & Future Enhancements

This document explains the key decisions behind the annotation specification and the
enhancements I would pursue next. The normative rules live in [SPEC.md](SPEC.md); this
is the *why*.

---

## Design decisions

### 1. Form knowledge is data, not code

The central decision. All per-form facts — box positions, formats, which value goes
where — live in an annotation document; a single generic renderer consumes any of them.
Consequences: adding a form (or absorbing the IRS's yearly layout changes) is a JSON
edit by a tax-domain person, not an engineering release; and the renderer is written
once per organization, in any language, against the SPEC §7 contract.

### 2. JSON as the carrier format

Chosen over XML, YAML, and binary formats:

- Every language parses JSON natively — essential when the goal is "anyone can build a
  renderer with their own proprietary code."
- The caller's data is itself JSON-shaped, so the annotation and the data share one
  model (objects, arrays, scalars), and binding paths read naturally against both.
- JSON Schema gives free, standardized machine validation
  ([schema/annotation.schema.json](schema/annotation.schema.json)).
- Annotations must be human-reviewable — a tax expert should be able to diff this
  year's file against last year's. That rules out binary. YAML was rejected because its
  implicit typing (`no` → `false`) is a liability where a wrong value misfiles a
  return; XML would work but adds verbosity without adding capability.

### 3. Draw text on the page; don't fill AcroForm fields

Some IRS PDFs (including the 1040) are themselves fillable forms, so an obvious
alternative was to define annotations as "set AcroForm field `f1_47` to X." I chose
coordinate-based drawing instead:

- **Coverage.** Many forms — most state forms, older federal forms, anything scanned —
  are flat PDFs with no fields at all. A coordinate-based spec covers every form; a
  field-based spec covers only the lucky ones.
- **Fidelity.** Drawn output is identical everywhere and print-ready. AcroForm
  appearance is viewer-dependent, and filed returns need the form flattened anyway.
- **Decoupling.** Internal field names (`topmostSubform[0].Page1[0].f1_47[0]`) are
  undocumented and unstable across years; rectangles are ground truth.

Where AcroForm fields *do* exist, they're still useful — as a measurement source: the
example's coordinates were extracted programmatically from the official PDF's own field
rectangles, giving pixel-accurate output without manual measurement.

### 4. Top-left origin, in points

PDF's native coordinate system puts the origin at the *bottom*-left with y increasing
upward. The spec deliberately uses the **top-left** with y increasing downward, because
that is how humans, screenshots, and annotation tools measure a page. The renderer pays
a one-line conversion (`pdfY = pageHeight − y − h`, SPEC §3); the annotator — who does
the most manual work — gets the intuitive convention. Points (1/72") because that is
the PDF's own unit, making measurements transferable without scaling.

### 5. A deliberately tiny JSONPath subset for bindings

Bindings (`$.return.dependents[2].ssn`) support only dot-members and explicit numeric
indices — no wildcards, filters, or recursive descent. Rationale: every path names
exactly one value (no ambiguity about what prints in a box), and resolution is ~15
lines of code in any language, so no implementer needs a third-party JSONPath engine.
Computed values are handled by an explicit, enumerated transform pipeline (`sum`,
`concat`, `round`, … — SPEC §6.4) rather than a general expression language: powerful
enough for "total of box 1 across all W-2s," constrained enough to audit.

### 6. Field types model tax-form structure, not just "text at x,y"

The eight types were derived by walking the real Form 1040. One-character-per-box combs
(SSNs), one-answer-of-N radio groups (filing status), and repeating dependent
entries are *structural* features of tax forms. Making them first-class means the
annotation carries intent — "9 digits, one per box, error on 7" — instead of each
renderer re-inventing the same conventions on top of free text, differently.

### 7. Fail-loud defaults, because the domain is money

A silently truncated or dropped dollar amount is a mis-filed return. Hence: text that
cannot fit shrinks only to a legibility floor and then **errors**; unknown field types
and unknown transforms are errors, never no-ops; a comb value of the wrong length is an
error; a fifth dependent on a four-slot form is an error unless the annotator
explicitly opts into truncation or IRS-style continuation statements. Missing data
follows one three-way rule (required → error; `default` → use it; else → leave blank)
and renderers are forbidden from inventing fallbacks.

### 8. Table repetition is a 2-D offset — a lesson from testing against reality

My first table model repeated rows downward, like Schedule B. Rendering against the
actual 2025 Form 1040 revealed that its four dependents run **left-to-right** as grid
columns. Repetition became a generalized offset `repeat: {max, dx, dy}` (the dependents
grid is `dx: 108, dy: 0`). Similarly, combs gained `fit: "exact" | "left"` when the
1040's 17-box bank-account comb met a 10-digit account number. Both changes exist
because the spec was validated against the real artifact, not a remembered idealization
of it.

### 9. One annotation per (form, revision)

`form.id` + `form.revision` key every document, because the IRS moves boxes every year:
coordinates for the 2025 revision are simply facts about that revision. Yearly updates
are a new data file with a diff a reviewer can read. `specVersion` versions the format
itself separately, and a renderer must reject documents whose format it doesn't fully
understand — an old renderer can never silently mis-print a newer annotation.

### 10. Three redundant expressions of one contract

The format is defined three ways on purpose: prose (SPEC.md) for behavior that
structure can't express (rounding rules, overflow semantics); JSON Schema for
mechanical validation of annotation *files*; TypeScript types for compile-time safety
in implementers' *code*. Each guards a different failure mode for a different audience.

---

## Future enhancements

Roughly in the order I would build them. A property they all share: **none changes the
architecture.** Each is new vocabulary on the annotation document, consumed by the
same six-step pipeline — the sign that the core design is load-bearing.

### 1. Conditional fields — "print X only if Y"

Today every field always attempts to render, and "don't fill the spouse block for a
single filer" works only because the data happens to lack a spouse object. The
enhancement is a `when` predicate on any field:

```jsonc
"when": { "binding": "$.return.filingStatus", "equals": "mfj" }
```

so the *annotation itself* declares when a field applies, instead of relying on the
shape of the data. It would reuse the `checkedWhen` predicate grammar (`equals` /
`truthy`) so the spec grows no new concepts — a checkbox already is a conditional
mark; `when` generalizes the same idea to every field type.

### 2. Automatic continuation statements

Today a 5th dependent on the 4-slot form produces a *warning* — "1 item requires a
continuation statement" — and a human must build that attachment. The actual IRS
procedure is to attach an extra page listing the overflow entries. The next step: the
table's annotation defines an attachment template (a page layout with its own columns),
and the renderer *generates the attachment automatically* — overflow entries get
printed on an appended statement page instead of merely being reported as a problem.

### 3. Field-level data validation — fail before ink

The renderer currently validates *shape* (a currency value must be a number; an SSN
comb needs exactly 9 characters) but not *plausibility*: `999-99-9999` has nine
digits, so it renders — yet it isn't an issuable SSN, and routing numbers carry a
check digit that can be verified arithmetically. The enhancement is declarative rules
on bindings:

```jsonc
"validate": { "checksum": "aba-routing" }          // or:
"validate": { "pattern": "^[0-9]{5}(-[0-9]{4})?$" } // ZIP / ZIP+4
```

plus cross-field rules ("line 9 must equal the sum of lines 1z–8"). Bad data then
fails *before* any ink hits the page, with errors phrased in tax terms a reviewer
understands — extending the fail-loud principle (decision #7) one layer earlier.

### 4. A visual annotation editor

Annotating a form today means measuring coordinates and typing JSON — the most
tedious part of the whole system. The tool: render the blank PDF; the tax expert
*drags a rectangle* over a box, picks a type from a dropdown, clicks a value in a
sample-data tree — and the editor emits conforming JSON. Annotation drops from hours
of measuring to minutes of clicking, and the output is schema-validated by
construction. The renderer's `--debug` overlay (red outlines + field ids) is the seed:
it is already the "view" half of this tool; the editor adds the "click to create" half.

### 5. Richer typography

The PoC uses the 14 standard PDF fonts every viewer guarantees (why the demo needs no
font files). Some state forms mandate specific fonts, and signatures/foreign names
want more. The enhancement: let `style.font.family` reference a font *file* that the
renderer embeds into the output PDF, plus letter-spacing control and right-to-left
support.

### 6. Multi-copy and multi-part forms

W-2s print as Copies A/B/C/D — identical data at different page offsets. An
annotation-level "stamp this field set N times with per-copy offsets" is the table
`repeat {dx, dy}` mechanism reused at whole-form scale.

### 7. Barcode/OCR zones

Many state returns require 2-D barcodes (PDF417) encoding the return data. A
`barcode` field type bound to a *set* of paths fits the existing model cleanly — it
is one more entry in the type union, one more case in the renderer's switch.

### 8. Registry & tooling

A versioned repository of annotations keyed by (jurisdiction, form, revision), with CI
that schema-validates every file and golden-renders sample data on every change — so
annotations get the same review rigor as code, which decision #1 turned them into.
