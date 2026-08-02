/**
 * Proof-of-concept renderer for the Tax Form Annotation Specification (v1.0).
 *
 * Implements the SPEC.md §7 pipeline over pdf-lib:
 *   resolve → required/default → transform → validate → format → lay out & draw
 *
 * Written in TypeScript against types/annotation.ts, so the compiler enforces
 * the same field shapes on this code that the JSON Schema enforces on
 * annotation files (e.g. the switch on field.type narrows the Field union:
 * inside `case "comb"` the compiler knows cellOrigin exists and rect doesn't).
 *
 * Deliberately form-agnostic: the string "1040" appears nowhere below. All
 * form knowledge arrives in the annotation document; hand this same program a
 * W-2 annotation and it renders W-2s.
 *
 * Usage (via `npm run demo`, which compiles first):
 *   node dist/renderer/render.js <annotation.json> <data.json> <blank.pdf> <out.pdf> [--debug]
 *
 * --debug additionally outlines every annotated rect / comb cell in red with
 * the field id, which is how an annotator calibrates coordinates against the
 * blank form.
 */
import * as fs from "fs";
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";
import type {
  AnnotationDocument,
  Column,
  Field,
  NumberFormat,
  Page,
  Rect,
  Style,
  Transform,
} from "../types/annotation";

// ---------------------------------------------------------------- CLI ------
const args = process.argv.slice(2).filter((a) => a !== "--debug");
const DEBUG = process.argv.includes("--debug");
if (args.length !== 4) {
  console.error("usage: node dist/renderer/render.js <annotation.json> <data.json> <blank.pdf> <out.pdf> [--debug]");
  process.exit(2);
}
const [annPath, dataPath, pdfPath, outPath] = args;

// Parse as unknown first: the file only EARNS the AnnotationDocument type
// after the version gate (schema validation is a separate, earlier step).
const annRaw: unknown = JSON.parse(fs.readFileSync(annPath, "utf8"));
const data: unknown = JSON.parse(fs.readFileSync(dataPath, "utf8"));

if ((annRaw as { specVersion?: unknown }).specVersion !== "1.0") {
  console.error(`unsupported specVersion: ${(annRaw as { specVersion?: unknown }).specVersion}`);
  process.exit(2);
}
const ann = annRaw as AnnotationDocument;

const warnings: string[] = [];

// ------------------------------------------------- binding resolution (§6) -
// The entire binding grammar as one regex: "$" or "@", then any number of
// ".member" segments, each optionally followed by one "[index]".
const PATH_RE = /^[$@](\.[A-Za-z_][A-Za-z0-9_]*(\[[0-9]+\])?)*$/;

/**
 * Follow a binding path into the nested data and return the value it names.
 *   resolvePath("$.return.taxpayer.ssn")        → data.return.taxpayer.ssn
 *   resolvePath("@.ssn", oneDependent)          → oneDependent.ssn
 * "$" starts at the whole data set; "@" starts at `rowItem` (the current table
 * entry) and is an error anywhere else. A path that runs into anything missing
 * returns `undefined` — "no value" is a normal, specified outcome that the
 * required/default rule handles later, not an exception.
 */
function resolvePath(binding: string, rowItem?: unknown): unknown {
  if (!PATH_RE.test(binding)) throw new Error(`invalid binding grammar: ${binding}`);
  if (binding[0] === "@" && rowItem === undefined) throw new Error(`"@" used outside a table column: ${binding}`);
  let cur: unknown = binding[0] === "$" ? data : rowItem;
  const segs = binding.slice(1).match(/\.[A-Za-z_][A-Za-z0-9_]*(\[[0-9]+\])?/g) || [];
  for (const seg of segs) {
    const m = seg.match(/^\.([A-Za-z_][A-Za-z0-9_]*)(?:\[([0-9]+)\])?$/)!;
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[m[1]];
    if (m[2] !== undefined) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(m[2])];
    }
  }
  return cur === null ? undefined : cur;
}

// ------------------------------------------------------- transforms (§6.4) -
/**
 * Run the field's transform pipeline: each step takes the previous step's
 * output as input, left to right. This is how a printed value that exists
 * nowhere in the data gets computed — e.g. line 1a binds to the w2s ARRAY and
 * `sum {path: "@.box1"}` collapses it to one number ("@" here means each array
 * element in turn). An unrecognized transform name throws: silently passing a
 * value through un-transformed would print a wrong number on a tax form.
 */
function applyTransforms(val: unknown, transforms: Transform[] | undefined, fieldId: string): unknown {
  for (const t of transforms || []) {
    const fn = typeof t === "string" ? t : t.fn;
    const a: Record<string, unknown> = (typeof t === "object" && t.args) || {};
    switch (fn) {
      case "abs":
        mustBeNumber(val, fieldId, fn); val = Math.abs(val); break;
      case "negate":
        mustBeNumber(val, fieldId, fn); val = -val; break;
      case "round": {
        mustBeNumber(val, fieldId, fn);
        val = roundHalfAway(val, (a.decimals as number | undefined) ?? 0); break;
      }
      case "sum": {
        if (!Array.isArray(val)) throw fieldError(fieldId, `sum: input is not an array`);
        const path = a.path as string;
        val = val.reduce<number>((acc, el) => {
          const v = path[0] === "@" ? resolvePath(path, el) : resolvePath(path);
          if (typeof v !== "number") throw fieldError(fieldId, `sum: ${path} resolved to a non-number`);
          return acc + v;
        }, 0);
        break;
      }
      case "count": {
        if (!Array.isArray(val)) throw fieldError(fieldId, `count: input is not an array`);
        val = val.length; break;
      }
      case "concat": {
        const parts = ((a.paths as string[] | undefined) || [])
          .map((p) => (p[0] === "@" ? resolvePath(p, val) : resolvePath(p)))
          .filter((v) => v !== undefined);
        val = parts.join((a.separator as string | undefined) ?? " ");
        break;
      }
      case "uppercase": val = String(val).toUpperCase(); break;
      case "lowercase": val = String(val).toLowerCase(); break;
      case "trim": val = String(val).trim(); break;
      case "sliceString": val = String(val).slice((a.start as number | undefined) ?? 0, a.end as number | undefined); break;
      default:
        throw fieldError(fieldId, `unknown transform "${fn}"`); // MUST error, never no-op
    }
  }
  return val;
}

/**
 * Guard for numeric transforms: money math on a string is always a bug.
 * (An assertion function — after calling it, the compiler narrows v to number.)
 */
function mustBeNumber(v: unknown, id: string, fn: string): asserts v is number {
  if (typeof v !== "number") throw fieldError(id, `${fn}: input is not a number`);
}
/**
 * Round half away from zero (the IRS convention): 0.5 → 1, -0.5 → -1.
 * JavaScript's Math.round rounds -0.5 UP to 0, which is wrong for tax values.
 */
function roundHalfAway(n: number, d: number): number {
  const f = 10 ** d;
  return (Math.sign(n) || 1) * Math.round(Math.abs(n) * f) / f;
}
/** Every error carries the field id, so a failure names the annotation entry to fix. */
function fieldError(id: string, msg: string): Error {
  return new Error(`[${id}] ${msg}`);
}

// ------------------------------------------------------- formatting (§7.2) -
/**
 * Turn a raw number into the string that gets printed, per the field's
 * `format` options: round, add thousands commas, wrap negatives in parens
 * — 189690.74 → "189,691", -3000 → "(3,000)". Returns null for zero with
 * `zero: "blank"`, which tells the caller to draw nothing at all.
 */
function formatNumber(v: number, format: NumberFormat & { symbol?: boolean } = {}, isCurrency = false): string | null {
  const dec = format.decimals ?? 0;
  const v2 = roundHalfAway(v, dec);
  if (v2 === 0) {
    const zero = format.zero ?? "print";
    if (zero === "blank") return null; // caller skips the field
    if (zero === "dash") return "—";
  }
  let s = Math.abs(v2).toLocaleString("en-US", {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
    useGrouping: format.thousands ?? true,
  });
  if (isCurrency && format.symbol) s = "$" + s;
  if (v2 < 0) s = (format.negative ?? "parens") === "parens" ? `(${s})` : `-${s}`;
  return s;
}

/**
 * Reformat an ISO date ("2026-04-10") into the form's pattern ("04/10/2026").
 * Input that isn't YYYY-MM-DD is an error — guessing at ambiguous dates
 * (is 04/10 April or October?) is exactly what a tax renderer must not do.
 */
function formatDate(v: unknown, pattern: string | undefined, id: string): string {
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw fieldError(id, `date value "${v}" is not ISO-8601 (YYYY-MM-DD)`);
  return (pattern ?? "MM/DD/YYYY")
    .replace("YYYY", m[1])
    .replace("YY", m[1].slice(2))
    .replace("MM", m[2])
    .replace("DD", m[3]);
}

// ------------------------------------------------------------ styles (§4) --
/** A style with every property resolved — what the cascade produces. */
interface EffectiveStyle {
  font: { family: string; size: number; weight: "normal" | "bold"; color: string };
  align: NonNullable<Style["align"]>;
  vAlign: NonNullable<Style["vAlign"]>;
  padding: number;
  overflow: NonNullable<Style["overflow"]>;
  minFontSize: number;
  lineHeight: number;
}

// The spec's built-in defaults — the bottom layer of the style cascade.
const SPEC_STYLE: EffectiveStyle = {
  font: { family: "Helvetica", size: 9, weight: "normal", color: "#000000" },
  align: "left", vAlign: "middle", padding: 2,
  overflow: "shrink", minFontSize: 5, lineHeight: 1.15,
};

/**
 * Compute a field's effective style by cascading three layers:
 *   field's own `style`  >  annotation-level `defaults`  >  SPEC_STYLE.
 * `typeDefaults` slots in a per-type preference (number/currency pass
 * {align: "right"}) that still loses to anything the annotator wrote.
 */
function effStyle(field: Field | Column, typeDefaults: { align?: Style["align"] } = {}): EffectiveStyle {
  const d = ann.defaults || {};
  const f = field.style || {};
  return {
    font: { ...SPEC_STYLE.font, ...(d.font || {}), ...(f.font || {}) },
    align: f.align ?? typeDefaults.align ?? d.align ?? SPEC_STYLE.align,
    vAlign: f.vAlign ?? d.vAlign ?? SPEC_STYLE.vAlign,
    padding: f.padding ?? d.padding ?? SPEC_STYLE.padding,
    overflow: f.overflow ?? d.overflow ?? SPEC_STYLE.overflow,
    minFontSize: f.minFontSize ?? d.minFontSize ?? SPEC_STYLE.minFontSize,
    lineHeight: f.lineHeight ?? d.lineHeight ?? SPEC_STYLE.lineHeight,
  };
}

/** "#rrggbb" → pdf-lib's 0..1 rgb() color. */
function hexToRgb(hex: string) {
  return rgb(
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255
  );
}

// ------------------------------------------------------------- drawing -----
/**
 * Load the blank PDF, embed the fonts once, then render every field in the
 * annotation on top of it and save the result. All the drawing helpers live
 * inside main() because they need the loaded document/fonts in scope.
 */
async function main(): Promise<void> {
  const pdf = await PDFDocument.load(fs.readFileSync(pdfPath));
  const fonts: Record<string, PDFFont> = {
    "Helvetica/normal": await pdf.embedFont(StandardFonts.Helvetica),
    "Helvetica/bold": await pdf.embedFont(StandardFonts.HelveticaBold),
    dingbats: await pdf.embedFont(StandardFonts.ZapfDingbats),
  };
  const pickFont = (style: EffectiveStyle): PDFFont =>
    fonts[`Helvetica/${style.font.weight}`] || fonts["Helvetica/normal"];

  const pageMeta = new Map<number, Page>(ann.pages.map((p) => [p.number, p]));
  const pdfPages = pdf.getPages();

  /** Look up page n, checking it exists both in annotation.pages and in the PDF. */
  function getPage(n: number | undefined, id: string): { page: PDFPage; meta: Page } {
    const meta = n !== undefined ? pageMeta.get(n) : undefined;
    if (!meta) throw fieldError(id, `page ${n} not declared in annotation.pages`);
    const page = pdfPages[n! - 1];
    if (!page) throw fieldError(id, `page ${n} not present in the blank PDF`);
    return { page, meta };
  }

  // The one-line price of the spec's human-friendly coordinates (§3): the
  // annotation measures y DOWN from the page top; PDF measures y UP from the
  // bottom. Given a box's top y and height, return the PDF y of its bottom edge.
  const toPdfY = (meta: Page, y: number, h: number): number => meta.height - y - h;

  /** --debug mode: outline a rect in red with its field id, for calibrating coordinates. */
  function debugRect(page: PDFPage, meta: Page, r: Rect, id: string): void {
    if (!DEBUG) return;
    page.drawRectangle({
      x: r.x, y: toPdfY(meta, r.y, r.h), width: r.w, height: r.h,
      borderColor: rgb(0.85, 0.1, 0.1), borderWidth: 0.5,
    });
    page.drawText(id, {
      x: r.x, y: toPdfY(meta, r.y, 0) + 1, size: 3.5,
      font: fonts["Helvetica/normal"], color: rgb(0.85, 0.1, 0.1),
    });
  }

  /**
   * Fit and draw a formatted string inside a rect (§7.3–7.4): inset by
   * padding, word-wrap if the field is multiline, then check it fits. If it
   * doesn't, the style's overflow policy decides — "shrink" steps the font
   * down to minFontSize then ERRORS, "truncate" cuts chars with a warning,
   * "error" throws immediately. There is no path where text silently
   * disappears. Finally apply align/vAlign and draw each line.
   */
  function drawTextInRect(
    page: PDFPage,
    meta: Page,
    rect: Rect,
    text: string,
    style: EffectiveStyle,
    field: { id: string; multiline?: boolean }
  ): void {
    const font = pickFont(style);
    const p = style.padding;
    const inner = { x: rect.x + p, y: rect.y + p, w: rect.w - 2 * p, h: rect.h - 2 * p };
    let size = style.font.size;

    const wrap = (sz: number): string[] => {
      if (!field.multiline) return [text];
      const words = text.split(/\s+/);
      const lines: string[] = [];
      let line = "";
      for (const w of words) {
        const cand = line ? line + " " + w : w;
        if (font.widthOfTextAtSize(cand, sz) <= inner.w || !line) line = cand;
        else { lines.push(line); line = w; }
      }
      if (line) lines.push(line);
      return lines;
    };

    const fits = (sz: number): boolean => {
      const lines = wrap(sz);
      const wOk = lines.every((l) => font.widthOfTextAtSize(l, sz) <= inner.w);
      const hOk = ((lines.length - 1) * sz * style.lineHeight + sz) <= inner.h;
      return wOk && hOk;
    };

    if (!fits(size)) {
      if (style.overflow === "shrink") {
        while (size > style.minFontSize && !fits(size)) size -= 0.25;
        if (!fits(size)) throw fieldError(field.id, `text does not fit at minFontSize (${style.minFontSize}pt): "${text}"`);
      } else if (style.overflow === "truncate") {
        while (text.length > 1 && !fits(size)) { text = text.slice(0, -1); }
        warnings.push(`[${field.id}] truncated to "${text}"`);
      } else {
        throw fieldError(field.id, `text does not fit: "${text}"`);
      }
    }

    const lines = wrap(size);
    const blockH = (lines.length - 1) * size * style.lineHeight + size;
    let topOffset: number;
    if (style.vAlign === "top") topOffset = 0;
    else if (style.vAlign === "bottom") topOffset = inner.h - blockH;
    else topOffset = (inner.h - blockH) / 2;

    lines.forEach((line, i) => {
      const lw = font.widthOfTextAtSize(line, size);
      let tx = inner.x;
      if (style.align === "right") tx = inner.x + inner.w - lw;
      else if (style.align === "center") tx = inner.x + (inner.w - lw) / 2;
      // baseline ≈ top of line + ascent (~0.8em)
      const baselineTopSpace = inner.y + topOffset + i * size * style.lineHeight + size * 0.8;
      page.drawText(line, {
        x: tx, y: meta.height - baselineTopSpace, size,
        font, color: hexToRgb(style.font.color),
      });
    });
  }

  /**
   * Draw a checkbox/radio mark centered in its box, sized to ~80% of the
   * box's smaller side: "X" (Helvetica letter), "check" (ZapfDingbats — its
   * "3" glyph is a checkmark), or "fill" (solid rectangle, inset 15%).
   */
  function drawMark(page: PDFPage, meta: Page, rect: Rect, mark: "X" | "check" | "fill", style: EffectiveStyle): void {
    const s = Math.min(rect.w, rect.h);
    if (mark === "fill") {
      const m = s * 0.15;
      page.drawRectangle({
        x: rect.x + m, y: toPdfY(meta, rect.y + m, rect.h - 2 * m),
        width: rect.w - 2 * m, height: rect.h - 2 * m,
        color: hexToRgb(style.font.color),
      });
      return;
    }
    const glyph = mark === "check" ? "3" : "X"; // "3" = ✓ in ZapfDingbats
    const font = mark === "check" ? fonts.dingbats : pickFont(style);
    const size = s * 0.8;
    const gw = font.widthOfTextAtSize(glyph, size);
    page.drawText(glyph, {
      x: rect.x + (rect.w - gw) / 2,
      y: toPdfY(meta, rect.y, rect.h) + (rect.h - size * 0.72) / 2,
      size, font, color: hexToRgb(style.font.color),
    });
  }

  /**
   * Render ONE field from the annotation — the heart of the program, running
   * the SPEC §7 pipeline:  resolve → required/default → transform → validate
   * → format → draw.
   *
   * Called plain (renderField(field)) for top-level fields. A `table` field
   * doesn't draw anything itself: it resolves its array and calls renderField
   * AGAIN for each column of each entry, passing three extras that make the
   * recursion work:
   *   rowItem — the current array element, which "@" bindings resolve against
   *   ox, oy  — (i·dx, i·dy), shifting the column's entry-1 coordinates to entry i+1
   * So a column is rendered by the exact same code as any other field; tables
   * add no drawing logic of their own.
   */
  function renderField(field: Field | Column, rowItem?: unknown, ox = 0, oy = 0, pageNum = field.page): void {
    const { page, meta } = getPage(pageNum, field.id);
    const off = (r: Rect): Rect => ({ ...r, x: r.x + ox, y: r.y + oy });

    // Table branch: resolve the array, apply the too-many-entries policy,
    // then recurse into the columns once per entry with the (dx, dy) shift.
    if (field.type === "table") {
      const arr = resolvePath(field.binding);
      if (arr === undefined) {
        if (field.required) throw fieldError(field.id, "required table binding is missing");
        return;
      }
      if (!Array.isArray(arr)) throw fieldError(field.id, "table binding did not resolve to an array");
      const max = field.repeat.max;
      if (arr.length > max) {
        const mode = field.overflow ?? "error";
        if (mode === "error") throw fieldError(field.id, `array has ${arr.length} items but the form has ${max} entries`);
        const rest = arr.length - max;
        if (mode === "truncate") warnings.push(`[${field.id}] truncated ${rest} item(s)`);
        else warnings.push(`[${field.id}] ${rest} item(s) (indices ${max}..${arr.length - 1}) require a continuation statement`);
      }
      const dx = field.repeat.dx ?? 0;
      const dy = field.repeat.dy ?? 0;
      arr.slice(0, max).forEach((item, i) => {
        for (const col of field.columns) renderField(col, item, i * dx, i * dy, pageNum);
      });
      return;
    }

    // Scalar branch — the six pipeline steps for every non-table type.
    // Step 1: resolve — follow the binding into the data (or the table row).
    let v: unknown = field.binding !== undefined ? resolvePath(field.binding, rowItem) : undefined;
    // Step 2: required/default — the one three-way rule for missing values:
    // required → error; a `default` → use it; otherwise skip (leave box blank).
    if (v === undefined) {
      if (field.required) throw fieldError(field.id, "required value is missing from the data set");
      if ("default" in field) v = field.default;
      else return; // skip
    }
    // Step 3: transform — compute the derived value (sum, concat, ...).
    v = applyTransforms(v, field.transforms, field.id);

    // Steps 4–6: validate / format / draw — these depend on the field type,
    // so each case does its own version of them.
    switch (field.type) {
      case "text": {
        const style = effStyle(field);
        let s = String(v);
        if (field.case === "upper") s = s.toUpperCase();
        if (field.maxLength && s.length > field.maxLength) {
          if (style.overflow === "error") throw fieldError(field.id, `exceeds maxLength ${field.maxLength}: "${s}"`);
          s = s.slice(0, field.maxLength);
          warnings.push(`[${field.id}] cut to maxLength: "${s}"`);
        }
        debugRect(page, meta, off(field.rect), field.id);
        drawTextInRect(page, meta, off(field.rect), s, style, field);
        break;
      }
      case "number":
      case "currency": {
        if (typeof v !== "number") throw fieldError(field.id, `${field.type} value is not a number (got ${typeof v})`);
        const s = formatNumber(v, field.format, field.type === "currency");
        if (s === null) return; // zero:"blank"
        const style = effStyle(field, { align: "right" });
        debugRect(page, meta, off(field.rect), field.id);
        drawTextInRect(page, meta, off(field.rect), s, style, field);
        break;
      }
      case "date": {
        const s = formatDate(v, field.pattern, field.id);
        const style = effStyle(field);
        debugRect(page, meta, off(field.rect), field.id);
        drawTextInRect(page, meta, off(field.rect), s, style, field);
        break;
      }
      case "comb": {
        // Strip punctuation ("123-45-6789" → "123456789"), enforce the fit
        // policy against the cell count, then draw one centered character per
        // cell, advancing x by pitch (+ any configured gaps between groups).
        const stripped = String(v).replace(new RegExp(field.strip ?? "[^0-9A-Za-z]", "g"), "");
        const fit = field.fit ?? "exact";
        if (fit === "exact" && stripped.length !== field.cells)
          throw fieldError(field.id, `value has ${stripped.length} chars after strip; comb requires exactly ${field.cells}`);
        if (fit === "left" && stripped.length > field.cells)
          throw fieldError(field.id, `value has ${stripped.length} chars after strip; comb has only ${field.cells} cells`);
        const style = effStyle(field);
        const font = pickFont(style);
        let x = field.cellOrigin.x + ox;
        for (let i = 1; i <= field.cells; i++) {
          const cell: Rect = { x, y: field.cellOrigin.y + oy, w: field.cellSize.w, h: field.cellSize.h };
          debugRect(page, meta, cell, i === 1 ? field.id : "");
          const ch = stripped[i - 1];
          if (ch !== undefined) {
            const size = Math.min(style.font.size, cell.h * 0.85);
            const cw = font.widthOfTextAtSize(ch, size);
            page.drawText(ch, {
              x: cell.x + (cell.w - cw) / 2,
              y: toPdfY(meta, cell.y, cell.h) + (cell.h - size * 0.72) / 2,
              size, font, color: hexToRgb(style.font.color),
            });
          }
          x += field.pitch;
          for (const g of field.gaps || []) if (g.afterCell === i) x += g.extra;
        }
        break;
      }
      case "checkbox": {
        const checked = "equals" in field.checkedWhen ? v === field.checkedWhen.equals : !!v;
        debugRect(page, meta, off(field.rect), field.id);
        if (checked) drawMark(page, meta, off(field.rect), field.mark ?? "X", effStyle(field));
        break;
      }
      case "radio-group": {
        // One value, N boxes: mark exactly the option whose value === v.
        const hit = field.options.find((o) => o.value === v);
        for (const o of field.options) debugRect(page, meta, off(o.rect), `${field.id}=${o.value}`);
        if (!hit) {
          if (field.required) throw fieldError(field.id, `no option matches value ${JSON.stringify(v)}`);
          return;
        }
        drawMark(page, meta, off(hit.rect), field.mark ?? "X", effStyle(field));
        break;
      }
      default: {
        // With the full Field union handled above, this arm is unreachable to
        // the compiler (field: never) — but annotations arrive as runtime
        // JSON, so keep the §8 fail-loud check for types the compiler can't see.
        const unknownType = (field as { type: string; id?: string });
        throw fieldError(unknownType.id ?? "?", `unknown field type "${unknownType.type}"`); // §8: never skip silently
      }
    }
  }

  // The whole render is just: every field in the annotation, once.
  for (const field of ann.fields) renderField(field);

  fs.writeFileSync(outPath, await pdf.save());
  console.log(`wrote ${outPath}${DEBUG ? " (debug outlines on)" : ""}`);
  for (const w of warnings) console.log(`warning: ${w}`);
}

main().catch((e: unknown) => {
  console.error(`render failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
