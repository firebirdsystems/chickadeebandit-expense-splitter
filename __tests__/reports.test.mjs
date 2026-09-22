import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, it, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(__dirname, "../manifest.json"), "utf-8"));
const html = readFileSync(join(__dirname, "../src/index.html"), "utf-8");

// The hub owns these rules (manifest-sql-validation.validateReports) and refuses
// the whole bundle at publish if one is broken — which means the first sign of a
// typo is a failed release of every app in the pack, not a failed test here. The
// list is restated rather than imported because the app repo has no dependency
// on the hub; the cost of the copy is drift, and the cost of no copy is finding
// out at publish.
const MAX_VIEWS = 6;
const MAX_COLUMNS = 12;
const FORMATS = new Set(["text", "date", "datetime", "money_cents", "member"]);
const VIEW_ID_RE = /^[a-z0-9_]+$/;

// Columns the app-DB codec never encrypts. A WHERE or ORDER BY against anything
// else compares AES-GCM ciphertext: the comparison cannot match and the sort is
// arbitrary, and neither failure is visible in the rendered document.
const BUILTIN_PLAINTEXT = new Set([
  "id", "household_id", "created_at", "updated_at", "sent_at", "read_at",
  "expires_at", "last_synced_at", "completed", "all_day",
  "status", "type", "category", "week", "emoji", "icon", "source",
  "position", "sort_order", "pinned", "key", "version",
  "visibility", "audience", "membership_type", "membership_roles",
]);
const PLAINTEXT_SUFFIXES = ["_id", "_at", "_date", "_by", "_time"];
const isPlaintext = (col) =>
  BUILTIN_PLAINTEXT.has(col)
  || PLAINTEXT_SUFFIXES.some((s) => col.endsWith(s))
  || (manifest.db_plaintext_columns ?? []).includes(col);

const views = manifest.reports?.views ?? [];
const prefix = `app_${manifest.id.replace(/-/g, "_")}__`;
/** Output aliases the query produces — every `AS name`. */
const aliasesOf = (q) => new Set([...q.matchAll(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map((x) => x[1]));
/** Bare column names in a clause, with any table qualifier dropped. */
const columnsIn = (clause) =>
  [...clause.matchAll(/\b(?:[A-Za-z_][A-Za-z0-9_]*\.)?([A-Za-z_][A-Za-z0-9_]*)\b/g)].map((x) => x[1]);

describe("manifest.reports stays inside the hub's ceilings", () => {
  it("declares at least one view and no more than the cap", () => {
    expect(views.length).toBeGreaterThan(0);
    expect(views.length).toBeLessThanOrEqual(MAX_VIEWS);
  });

  it("gives every view a unique, legal id that is not the reserved one", () => {
    const seen = new Set();
    for (const v of views) {
      expect(v.id, v.id).toMatch(VIEW_ID_RE);
      expect(v.id).not.toBe("change_history");
      expect(seen.has(v.id), `${v.id} declared twice`).toBe(false);
      seen.add(v.id);
    }
  });

  it("declares change_history only alongside an audited table", () => {
    if (!manifest.reports?.change_history) return;
    const audited = Object.values(manifest.row_policies ?? {}).some((p) => p?.audit_writes === true);
    expect(audited, "change_history renders empty without audit_writes").toBe(true);
  });
});

describe.each(views.map((v) => [v.id, v]))("reports.%s", (id, view) => {
  const q = view.source.query;

  it("is a single, comment-free SELECT over this app's own tables", () => {
    expect(view.source.kind).toBe("sql");
    expect(q.length).toBeLessThanOrEqual(2000);
    expect(q).toMatch(/^\s*(SELECT|WITH)\s/i);
    expect(q).not.toMatch(/--|\/\*/);
    expect(q.trimEnd().endsWith(";")).toBe(false);
    expect(q).not.toMatch(/\bUNION\b/i);
    for (const t of q.match(/(?:FROM|JOIN)\s+(\w+)/gi) ?? []) {
      expect(t.split(/\s+/)[1], `${id} reads a foreign table`).toMatch(new RegExp(`^${prefix}`));
    }
  });

  it("declares no LIMIT — the hub imposes its own row ceiling", () => {
    expect(q).not.toMatch(/\bLIMIT\b/i);
  });

  it("names every column it displays, within the column cap", () => {
    const aliases = aliasesOf(q);
    expect(view.columns.length).toBeGreaterThan(0);
    expect(view.columns.length).toBeLessThanOrEqual(MAX_COLUMNS);
    const keys = new Set();
    for (const c of view.columns) {
      expect(aliases.has(c.key), `${id}.${c.key} is not a selected column`).toBe(true);
      expect(keys.has(c.key), `${id}.${c.key} declared twice`).toBe(false);
      keys.add(c.key);
      expect(c.label.trim().length).toBeGreaterThan(0);
      if (c.format !== undefined) expect(FORMATS.has(c.format), `${id}.${c.key} format`).toBe(true);
    }
  });

  it("takes both range tokens or neither, and compares them against plaintext", () => {
    const start = /:range_start\b/.test(q);
    expect(start).toBe(/:range_end\b/.test(q));
    if (!start) return;
    const where = /\bWHERE\b([\s\S]*?)(\bORDER\s+BY\b|$)/i.exec(q)?.[1] ?? "";
    for (const clause of where.split(/\bAND\b|\bOR\b/i)) {
      if (!/:range_(start|end)\b/.test(clause)) continue;
      for (const col of columnsIn(clause.replace(/:range_(start|end)\b/g, ""))) {
        if (["substr", "date", "AND", "OR"].includes(col)) continue;
        expect(isPlaintext(col), `${id} ranges over encrypted column "${col}"`).toBe(true);
      }
    }
  });

  it("sorts only on plaintext columns, resolving aliases to their source", () => {
    const orderBy = /\bORDER\s+BY\b([\s\S]*)$/i.exec(q)?.[1];
    if (!orderBy) return;
    // `SELECT note AS n … ORDER BY n` sorts on ciphertext wearing a label, so
    // the alias is resolved back to the stored column before the check.
    const sources = new Map(
      [...q.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s+AS\s+([A-Za-z_][A-Za-z0-9_]*)/gi)]
        .map((x) => [x[3], x[2]]),
    );
    for (const col of columnsIn(orderBy)) {
      if (["ASC", "DESC", "substr"].includes(col.toUpperCase?.() ? col.toUpperCase() : col)) continue;
      const resolved = sources.get(col) ?? col;
      expect(isPlaintext(resolved), `${id} orders by encrypted column "${resolved}"`).toBe(true);
    }
  });

  it("leads its ORDER BY with group_by when it declares one", () => {
    if (view.group_by === undefined) return;
    const aliases = aliasesOf(q);
    expect(aliases.has(view.group_by)).toBe(true);
    const first = (/\bORDER\s+BY\b\s*([^,]+)/i.exec(q)?.[1] ?? "");
    const sources = new Map(
      [...q.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s+AS\s+([A-Za-z_][A-Za-z0-9_]*)/gi)]
        .map((x) => [x[3], x[2]]),
    );
    const wanted = [view.group_by, sources.get(view.group_by)].filter(Boolean);
    expect(wanted.some((w) => columnsIn(first).includes(w))).toBe(true);
  });
});

describe("the app surfaces the views it declares", () => {
  it("reads __REPORTS_URL rather than hard-coding the endpoint path", () => {
    expect(html).toContain("window.__REPORTS_URL");
    // A hard-coded view list would be a second copy of the endpoint's own
    // decision about which views this caller may render.
    for (const v of views) {
      expect(html.includes(`"${v.id}"`), `${v.id} is hard-coded into the UI`).toBe(false);
    }
  });
});
