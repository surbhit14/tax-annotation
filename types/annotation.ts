/**
 * Tax Form Annotation Specification — TypeScript definitions
 * specVersion 1.0
 *
 * These types mirror schema/annotation.schema.json. The JSON Schema is the
 * validation source of truth; these types are what an implementation consumes.
 * Normative behavior (binding resolution, formatting, overflow) is defined in
 * SPEC.md.
 */

/** Root document: one annotation per (form id, revision). */
export interface AnnotationDocument {
  specVersion: "1.0";
  form: FormIdentity;
  pages: Page[];
  /** Document-wide style defaults; any field may override any property. */
  defaults?: Style;
  fields: Field[];
}

export interface FormIdentity {
  /** Stable form identifier, e.g. "f1040", "w2". */
  id: string;
  /** Form revision, normally the tax year, e.g. "2025". Coordinates are only valid for this revision. */
  revision: string;
  title?: string;
  /** Issuing authority, default "US-IRS". */
  jurisdiction?: string;
  /** Blank-form PDF these coordinates were measured against. */
  sourcePdf?: string;
}

/**
 * Coordinate space: points (1/72 inch), origin at the TOP-LEFT of the page,
 * y increasing downward. (PDF's native origin is bottom-left; convert with
 * pdfY = page.height - y - h.)
 */
export interface Page {
  /** 1-based page number in the source PDF. */
  number: number;
  /** Points. US Letter = 612. */
  width: number;
  /** Points. US Letter = 792. */
  height: number;
  unit?: "pt";
  origin?: "top-left";
}

export interface Rect {
  /** Points from the page's left edge to the box's left edge. */
  x: number;
  /** Points from the page's top edge to the box's top edge. */
  y: number;
  w: number;
  h: number;
}

export interface Style {
  font?: {
    family?: string; // default "Helvetica"
    size?: number; // default 9
    weight?: "normal" | "bold";
    color?: string; // "#rrggbb", default "#000000"
  };
  align?: "left" | "center" | "right"; // default "left"
  vAlign?: "top" | "middle" | "bottom"; // default "middle"
  /** Inset (pt) applied to all four rect edges before drawing. Default 2. */
  padding?: number;
  /** Behavior when formatted text doesn't fit at the requested size. Default "shrink". */
  overflow?: "shrink" | "truncate" | "error";
  /** Floor for "shrink"; below it, treat as "error". Default 5. */
  minFontSize?: number;
  /** Multiplier for multiline text. Default 1.15. */
  lineHeight?: number;
}

/**
 * Binding path (SPEC.md §6). A restricted JSONPath subset:
 *   "$"  — data-set root         "$.taxpayer.address.state"
 *   "@"  — current table row     "@.ssn"   (valid only inside table columns)
 * Segments: dot-separated identifiers, each optionally followed by one
 * numeric index, e.g. "$.dependents[2].name".
 */
export type Binding = string;

/** A transform step, applied left-to-right before formatting (SPEC.md §6.4). */
export type Transform = string | { fn: string; args?: Record<string, unknown> };

interface FieldBase {
  /** Unique within the document. Convention: the form's own line label, e.g. "line-1a". */
  id: string;
  label?: string;
  /** 1-based page. Required on top-level fields; table columns inherit the table's page. */
  page?: number;
  binding?: Binding;
  /** If true, missing/null resolved value is a render error; if false, the field is skipped. Default false. */
  required?: boolean;
  /** Used when the binding resolves to missing/null and required is false. */
  default?: unknown;
  transforms?: Transform[];
  style?: Style;
  notes?: string;
}

export interface TextField extends FieldBase {
  type: "text";
  rect: Rect;
  binding: Binding;
  multiline?: boolean; // default false
  maxLength?: number;
  case?: "preserve" | "upper"; // default "preserve"
}

export interface NumberFormat {
  decimals?: number; // default 0
  thousands?: boolean; // default true
  negative?: "parens" | "minus"; // default "parens"
  zero?: "print" | "blank" | "dash"; // default "print"
}

export interface NumberField extends FieldBase {
  type: "number";
  rect: Rect;
  binding: Binding;
  format?: NumberFormat;
}

export interface CurrencyFormat extends NumberFormat {
  /** 0 = whole-dollar rounding (IRS default), 2 = dollars and cents. */
  decimals?: 0 | 2;
  /** Print a leading "$". Almost always false on IRS forms. Default false. */
  symbol?: boolean;
}

export interface CurrencyField extends FieldBase {
  type: "currency";
  rect: Rect;
  binding: Binding;
  format?: CurrencyFormat;
}

export interface DateField extends FieldBase {
  type: "date";
  rect: Rect;
  binding: Binding;
  /** Output pattern with tokens YYYY, YY, MM, DD. Input must be ISO-8601 (YYYY-MM-DD). Default "MM/DD/YYYY". */
  pattern?: string;
}

/** One character per box (SSN, EIN, ZIP). Positioned by first cell + pitch. */
export interface CombField extends FieldBase {
  type: "comb";
  binding: Binding;
  /** Number of single-character boxes. */
  cells: number;
  /** Top-left of the FIRST cell. */
  cellOrigin: { x: number; y: number };
  /** Horizontal distance (pt) between left edges of adjacent cells. */
  pitch: number;
  cellSize: { w: number; h: number };
  /** Extra spacing beyond pitch after given 1-based cells (e.g. SSN hyphen gaps after cells 3 and 5). */
  gaps?: Array<{ afterCell: number; extra: number }>;
  /** Regex of characters to REMOVE before filling cells. Default "[^0-9A-Za-z]". */
  strip?: string;
  /**
   * "exact" (default): stripped length must equal `cells` (SSN, EIN, ZIP).
   * "left": length <= cells; fill from cell 1, leave the rest blank (account numbers).
   */
  fit?: "exact" | "left";
}

export interface CheckboxField extends FieldBase {
  type: "checkbox";
  rect: Rect;
  binding: Binding;
  /** Exactly one of `equals` / `truthy`. */
  checkedWhen: { equals: unknown } | { truthy: true };
  mark?: "X" | "check" | "fill"; // default "X"
}

/** One binding selects one of several mutually exclusive boxes (e.g. filing status). */
export interface RadioGroupField extends FieldBase {
  type: "radio-group";
  binding: Binding;
  options: Array<{
    /** Marked when the resolved value strictly equals this. */
    value: unknown;
    rect: Rect;
    label?: string;
  }>;
  mark?: "X" | "check" | "fill"; // default "X"
}

/** A column is any non-table, non-radio-group field positioned for ENTRY 1; the renderer offsets it by repeat.dx/dy per entry. */
export type Column =
  | TextField
  | NumberField
  | CurrencyField
  | DateField
  | CombField
  | CheckboxField;

/** Repeating entries bound to an array (dependents, Schedule B payers, ...). */
export interface TableField extends FieldBase {
  type: "table";
  /** Must resolve to an array. */
  binding: Binding;
  /**
   * Entry i (1-based) draws at the columns' positions offset by ((i−1)·dx, (i−1)·dy).
   * Classic top-to-bottom table: dy = row height. The 2025 Form 1040 dependents
   * grid runs left-to-right: dx = 108. At least one must be non-zero when max > 1.
   */
  repeat: {
    /** Printed entries the form provides. */
    max: number;
    dx?: number; // default 0
    dy?: number; // default 0
  };
  /** Behavior when the array has more than repeat.max items. Default "error". */
  overflow?: "continuation" | "truncate" | "error";
  columns: Column[];
}

export type Field =
  | TextField
  | NumberField
  | CurrencyField
  | DateField
  | CombField
  | CheckboxField
  | RadioGroupField
  | TableField;
