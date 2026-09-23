import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, it, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, "../src/index.html"), "utf-8");

/**
 * Source-level guards for behaviour that only shows up in a browser.
 *
 * These are blunt on purpose. Each one pins a fix whose failure mode is silent
 * — a misleading label on a saved row, a lost payment handle, an opaque 500 in
 * a tab the app cannot see — and whose only other coverage is a Playwright
 * scenario that does not run in this package. A static assertion that can
 * produce a false alarm is worth more here than no assertion at all.
 */

const body = () => {
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
  expect(m, "index.html has no module script").toBeTruthy();
  return m[1];
};

describe("a saved expense records the rule that split it", () => {
  const src = body();

  it("binds the computed source, not the form's split-method setting", () => {
    // Storing f.splitType made a 70/30 expense from a saved category rule
    // print "Equal" in the detail row and in the exported ledger.
    expect(src).toContain("source: splitSource");
    const insert = /INSERT INTO app_expense_splitter__expenses[\s\S]{0,400}?\[([\s\S]*?)\]/.exec(src);
    expect(insert, "expense INSERT not found").toBeTruthy();
    expect(insert[1]).toContain("splitSource");
    expect(insert[1]).not.toContain("f.splitType");
  });

  it("puts the same value in the optimistic row the UI renders before the write", () => {
    expect(src).toContain("split_type: splitSource");
    expect(src).not.toContain("split_type: f.splitType");
  });
});

describe("replacing a payment handle cannot lose the old one", () => {
  const src = body();
  const save = /window\._savePayHandle = async function[\s\S]*?\n};/.exec(src);

  it("sends the DELETE and the INSERT as one transaction", () => {
    expect(save, "_savePayHandle not found").toBeTruthy();
    // As two sequential calls, a DELETE that succeeded and an INSERT that
    // failed left the member with no handle and a toast saying the save failed.
    expect(save[0]).toContain("dbBatch(");
    expect((save[0].match(/await db\(/g) ?? []).length,
      "_savePayHandle still issues a bare single-statement write").toBe(0);
  });

  it("has a batch helper that posts the endpoint's statements shape", () => {
    expect(src).toMatch(/async function dbBatch\(/);
    expect(src).toContain("JSON.stringify({ statements })");
  });
});

describe("no write path replaces rows with two separate calls", () => {
  const src = body();

  /** Each `window._name = async function … };` body, by name. */
  const handlers = () => {
    const out = new Map();
    for (const m of src.matchAll(/window\._([A-Za-z]+) = async function[\s\S]*?\n};/g)) {
      out.set(m[1], m[0]);
    }
    expect(out.size, "no async handlers found — the scan regex has drifted").toBeGreaterThan(3);
    return out;
  };

  it("never issues a bare DELETE and a bare INSERT from the same handler", () => {
    // A DELETE that succeeded and an INSERT that failed destroys the rows the
    // member was editing while the toast says the save failed — which reads as
    // "nothing changed". Both replace-in-place paths (_savePayHandle and
    // _saveSplitRule) had this; the endpoint takes an atomic batch instead.
    const offenders = [];
    for (const [name, fn] of handlers()) {
      const bare = [...fn.matchAll(/await db\(\s*\n?\s*[`'"]?\s*(DELETE|INSERT)/gi)]
        .map((m) => m[1].toUpperCase());
      // `db(` with the verb in a template literal on the next line still counts.
      const templated = [...fn.matchAll(/await db\([\s\S]{0,120}?(DELETE FROM|INSERT INTO)/gi)]
        .map((m) => m[1].split(" ")[0].toUpperCase());
      const verbs = new Set([...bare, ...templated]);
      if (verbs.has("DELETE") && verbs.has("INSERT")) offenders.push(name);
    }
    expect(offenders, `these handlers replace rows non-atomically: ${offenders.join(", ")}`)
      .toEqual([]);
  });

  it("routes both replace-in-place handlers through the batch", () => {
    for (const name of ["_savePayHandle", "_saveSplitRule"]) {
      const fn = handlers().get(name.slice(1));
      expect(fn, `${name} not found`).toBeTruthy();
      expect(fn, `${name} does not use dbBatch`).toContain("dbBatch(");
    }
  });
});

describe("the export block is not offered where it cannot work", () => {
  const src = body();

  it("is gated on adult, because one view reads an adult-only table", () => {
    // api/reports only drops the admin-only change-history view; it does not
    // look at what a view's SQL reads. reimbursement_record joins
    // reimbursement_agreements (endpoint_only, read:"adult"), so a child
    // clicking it gets a 500 in a new tab the app cannot intercept.
    expect(src).toMatch(/if \(!reportViews\.length \|\| !IS_ADULT\)/);
    expect(src).toMatch(/if \(!REPORTS_URL \|\| !IS_ADULT\) return;/);
  });

  it("still builds the list from the endpoint rather than a copy of the manifest", () => {
    expect(src).toMatch(/reportViews\.map\(/);
  });
});

describe("boot does not issue a read the caller is known to be refused", () => {
  const src = body();
  const loadData = /async function loadData\(\)[\s\S]*?\n\s*\]\);/.exec(src);

  it("asks for reimbursement_agreements only as an adult", () => {
    // endpoint_only with read:"adult". A child's request is refused, and the
    // browser records the 403 before the .catch can swallow it — console noise
    // on every child's launch, and a failure in the e2e error collector, for an
    // answer that is known to be empty before the request is sent.
    //
    // Pinned as the whole ternary rather than "the file mentions IS_ADULT
    // somewhere": the gate that matters is the one wrapped around THIS read,
    // and an IS_ADULT elsewhere in loadData would satisfy a looser check while
    // the request still went out.
    expect(loadData, "loadData's Promise.all block not found").toBeTruthy();
    expect(loadData[0]).toMatch(
      /IS_ADULT\s*\n?\s*\?\s*db\('SELECT \* FROM app_expense_splitter__reimbursement_agreements'\)[\s\S]{0,40}?\n\s*:\s*Promise\.resolve\(\{ rows: \[\] \}\)/,
    );
  });

  it("still merges the agreements it did fetch into the request list", () => {
    // The empty branch has to be the same SHAPE as the real answer, or the
    // merge below throws for every child instead of finding nothing.
    expect(src).toMatch(/const agrById = new Map\(aRes\.rows\.map\(/);
  });
});

describe("weight inputs are bounded where they are read, not only where they are checked", () => {
  const src = body();
  const setWeight = /window\._setWeight = function[\s\S]*?\n};/.exec(src);

  it("clamps percent and shares on the way in", () => {
    expect(setWeight, "_setWeight not found").toBeTruthy();
    // A negative share apportions a negative amount_cents, which the balance
    // maths reads as the payer owing money to the member whose share it was.
    expect(setWeight[0]).toContain("Math.max(0,");
    expect(setWeight[0]).toContain("Math.min(TOTAL_BP,");
    expect(setWeight[0]).toContain("Math.min(MAX_SHARES,");
  });

  it("previews per-member amounts only once the rule is whole", () => {
    // Asserting the two names EXIST is not enough — they can be declared and
    // then not used in the condition, which is exactly the state a careless
    // revert leaves behind. Pin the guard where it is applied.
    expect(src).toContain("const percentReady = isPercent && total === TOTAL_BP;");
    expect(src).toContain("const sharesReady = !isPercent && validateShares(f.weights, ids);");
    expect(src).toMatch(/amountCents > 0 && \(percentReady \|\| sharesReady\)\s*\n?\s*\?/);
  });
});

describe("an optional read never holds up the first paint", () => {
  const src = body();
  const init = /async function init\(\)[\s\S]*?\n}/.exec(src);

  it("does not await the report view list alongside members and data", () => {
    // Swallowing loadReportViews' errors was not enough: a reports endpoint
    // that HANGS never rejects, and Promise.all waits either way, so the whole
    // app sat on its skeleton behind a list nothing above the fold needs.
    expect(init, "init() not found").toBeTruthy();
    expect(init[0]).toMatch(/await Promise\.all\(\[loadMembers\(\), loadData\(\)\]\);/);
    expect(init[0]).not.toMatch(/Promise\.all\(\[[^\]]*loadReportViews\(\)/);
  });

  it("starts it after the first paint and repaints only the block it feeds", () => {
    const awaited = /await\s+loadReportViews\(\)/.test(init[0]);
    expect(awaited, "loadReportViews is awaited on the boot path").toBe(false);
    expect(init[0]).toMatch(/loadReportViews\(\)\s*\.then\(renderExportBlock\)/);
    // Ordered after the paint: a repaint of an element that does not exist yet
    // is a no-op that leaves the block empty until the next render.
    const paint = init[0].indexOf("showMain();");
    const start = init[0].indexOf("loadReportViews()");
    expect(paint).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(paint);
  });
});
