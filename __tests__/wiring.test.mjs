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
  const loadData = /async function loadData\([^)]*\)[\s\S]*?\n\s*\]\);/.exec(src);

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
    expect(init[0]).toMatch(/await Promise\.all\(\[loadMembers\(\), loadData\(\{ withRecurring: false \}\)\]\);/);
    expect(init[0]).not.toMatch(/Promise\.all\(\[[^\]]*loadReportViews\(\)/);
    // The repeating-expense templates are not above the fold either.
    expect(init[0]).not.toMatch(/await\s+loadRecurring\(\)/);
    expect(init[0]).toMatch(/loadRecurring\(\)\.then\(/);
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

describe("repeating expenses: page wiring", () => {
  const src = body();
  const between = (start, end) => {
    const a = src.indexOf(start);
    expect(a, `${start} not found`).toBeGreaterThan(-1);
    return src.slice(a, src.indexOf(end, a + start.length));
  };
  const fnBody = (sig) => between(sig, "\n}\n");
  const run = () => fnBody("function postDueRecurring()");
  const pass = () => fnBody("async function postingPass(run)");
  const finish = () => fnBody("async function finishPostingRun(run)");

  describe("the posting run", () => {
    it("is claimed before its first await, and a call during it asks for another pass", () => {
      expect(run()).toMatch(/if \(postingRun\) \{ postingAgain = true; return postingRun; \}\n  postingRun = \(async/);
    });

    it("retries a conflicted pass once, after a re-read, and never loops", () => {
      expect(run()).toContain("if (conflicted && !retried) { retried = true; await reread({ withRecurring: true }); postingAgain = true; }");
      // Still conflicting after the retry: the day stays open for the next check.
      expect(run()).toContain("else if (conflicted) run.unsettled = true;");
      expect(finish()).toContain("!run.unsettled");
    });

    it("spends one budget across the run's passes, and leaves the day open when it runs out", () => {
      const p = pass();
      expect(p).toContain("if (run.budget === undefined) run.budget = MAX_POSTS_PER_RUN;");
      expect(p).toContain("run.budget = budget;");
      expect(p).toContain("if (budget <= 0) run.capped = true;");
    });

    it("runs a request that arrived while the run was finishing, rather than dropping it", () => {
      expect(run()).toMatch(/\.finally\(\(\) => \{\n    postingRun = null;[\s\S]*?if \(postingAgain\) \{\n      postingAgain = false;\n      postDueRecurring\(\)/);
    });

    it("re-reads only template paths for templates, and re-reads, repaints and reports once per run", () => {
      expect(fnBody("async function loadData({ withRecurring = false } = {})")).toContain("withRecurring\n      ? db(RECURRING_SQL)");
      expect(fnBody("async function reread({ withRecurring = false } = {})")).toContain("await loadData({ withRecurring })");
      expect(run()).toContain("await finishPostingRun(run);");
      const p = pass();
      expect(p).not.toContain("logActivity(");
      expect(p).not.toContain("toast(");
      expect(p).not.toMatch(/await reread\(\);\n  \/\/ An answer lost/);
      expect((finish().match(/await reread\(/g) ?? []).length).toBe(1);
      // A run that only synced reminder columns has nothing new to read.
      expect(finish()).toContain("const needsRead = run.posted.length > 0 || run.writes.size > 0 || run.failure || run.unsettled;");
      expect(finish()).toContain("announcePosted(run.posted, run.failure, { unconfirmed:");
    });

    it("starts after the first paint without holding it up, and watches for due dates once", () => {
      const init = fnBody("async function init()");
      expect(init.indexOf("postDueRecurring()")).toBeGreaterThan(init.indexOf("renderAll();"));
      expect(init).not.toMatch(/await postDueRecurring\(\)/);
      expect(init).toContain("watchForDueDates();");
      const watch = fnBody("function watchForDueDates()");
      expect(watch).toMatch(/if \(watchingDueDates\) return;\n  watchingDueDates = true;/);
      expect(watch).toContain("addEventListener('visibilitychange'");
      expect(watch).toContain("hubToday() !== lastPostingDay");
    });

    it("counts a day as looked at only when the run neither failed, stopped at the cap, nor left a conflict", () => {
      expect(finish()).toContain("if (!run.failure && !run.capped && !run.unsettled && run.today) lastPostingDay = run.today;");
      expect(src.match(/lastPostingDay = /g)).toHaveLength(2); // the declaration and this one
    });
  });

  describe("one pass", () => {
    it("posts only for adults, from household-local today, through guarded batches", () => {
      const p = pass();
      expect(p).toMatch(/if \(!IS_ADULT \|\| !DB\) return;/);
      expect(p).toContain("hubToday()");
      expect(p).not.toMatch(/toISOString\(\)\.slice\(0, ?10\)/);
      expect(p).toContain("postingBatches(");
      expect(p).toContain("await dbBatch(batch.statements)");
      expect((p.match(/await db\(/g) ?? []).length, "a bare single-statement write in a pass").toBe(0);
    });

    it("reads its roster, rules and templates fresh before writing, once per run and only when there is work", () => {
      const p = pass();
      expect(p).toMatch(/if \(!run\.refreshed\) \{\n    run\.refreshed = true;\n    if \(recurringFailed \|\| hasPostingWork\(today\)\) \{/);
      expect(p).toContain("await Promise.all([loadMembers(), loadData({ withRecurring: true })]);");
      // A failed refresh posts nothing and leaves the day open.
      expect(p).toMatch(/catch \(e\) \{[\s\S]*?run\.unsettled = true;\n        return;/);
      expect(p).toContain("if (recurringFailed) { run.unsettled = true; return; }");
      // The refresh comes before anything is decided from members or rules.
      expect(p.indexOf("loadMembers()")).toBeLessThan(p.indexOf("const roster ="));
    });

    it("treats another adult's posting (stale guard or duplicate) as a race, not a failure", () => {
      expect(pass()).toContain("if (isStaleConflict(e) || isDuplicate(e)) { conflicted = true; continue templates; }");
    });

    it("decides held once per template and looks posted dates up in a set", () => {
      const p = pass();
      expect((p.match(/templateProblem\(/g) ?? []).length).toBe(1);
      expect(p).toContain("const postedKeys = postedOccurrenceKeys(expenses);");
      expect(p).not.toContain("expenses.some(e => e.recurring_id");
    });

    it("moves its own copy of a template on with each batch, so passes need no re-read between them", () => {
      expect(pass()).toMatch(/const moved = \{ \.\.\.template, next_due_date: batch\.next_due_date, updated_at: now \};[\s\S]*?recurring = recurring\.map/);
    });

    it("decides every template's reminder sync before posting, and sends them together", () => {
      const p = pass();
      expect(p.indexOf("reminderSyncStatement(")).toBeLessThan(p.indexOf("templates:\n  for"));
      expect(p).toContain("await dbBatch(chunk.map(({ statement }) => statement));");
    });
  });

  describe("after the run", () => {
    it("decides a lost answer from fresh template rows only, by the batch's last date and stamp", () => {
      const f = finish();
      expect(f).toContain("if (run.failure && last && fresh && outcomeUnknown(run.failure)) {");
      expect(f).toContain("row.updated_at === last.now && row.next_due_date === last.next_due_date");
      expect(f).toContain("syncOpenEditForm(run.writes, fresh);");
    });

    it("logs one activity line per template and one event per expense", () => {
      const a = fnBody("function announcePosted(posted, failure, { unconfirmed = false } = {})");
      expect((a.match(/logActivity\(/g) ?? []).length).toBe(1);
      expect(a).toMatch(/for \(const group of byTemplate\.values\(\)\)/);
      // One at a time: a backlog's events never go out as one burst.
      // A few at a time: never one burst, never a minutes-long trickle.
      expect(a).toMatch(/for \(let i = 0; i < posted\.length; i \+= EVENT_GROUP\) \{\n      await Promise\.all\(posted\.slice\(i, i \+ EVENT_GROUP\)\.map\(p => publishEvent\('expense\.created', p\.expenseId/);
    });

    it("says an unconfirmable outcome as such, never as a failure to add", () => {
      expect(finish()).toContain("{ unconfirmed: !!run.failure && !fresh && outcomeUnknown(run.failure) }");
      expect(fnBody("function announcePosted(posted, failure, { unconfirmed = false } = {})")).toContain("Reload to check before adding it by hand.");
    });

    it("hands an open edit form this page's own posting stamp, never a later writer's", () => {
      const s = fnBody("function syncOpenEditForm(writes, fresh)");
      expect(s).toContain("modalEl !== f.formEl");
      expect(s).toContain("if (fresh && row?.updated_at !== write.now) return;");
      expect(s).toContain("dateEl.value === f.formNext");
    });
  });

  describe("template writes", () => {
    it("reads templates beside the ledger, and a failed read is said rather than read as none", () => {
      expect(src).toContain("SELECT * FROM app_expense_splitter__recurring_expenses ORDER BY created_at");
      expect(src).toContain("db(RECURRING_SQL).catch(() => { noRecurring = true;");
      expect(fnBody("async function loadRecurring()")).toContain("recurringFailed = true;");
      expect(src).toContain('data-testid="recurring-error"');
      expect(fnBody("function recurringOrigin(exp)")).toContain("recurringFailed || recurringPending ? 'Added by a repeating expense'");
    });

    it("guards edits and pauses on the stamp they were made from", () => {
      expect(src).toMatch(/UPDATE app_expense_splitter__recurring_expenses SET description = \?[\s\S]*?WHERE id = \? AND updated_at = \?`/);
      expect(src).toMatch(/UPDATE app_expense_splitter__recurring_expenses SET active = \?[\s\S]*?WHERE id = \? AND updated_at = \?`/);
    });

    it("clears the reminder stamp when an edit or resume moves the due date", () => {
      expect(src).toContain("${remindAgain(storedTerms, row) ? ', last_reminded_at = NULL' : ''}");
      const again = fnBody("function remindAgain(stored, saved)");
      for (const k of ["next_due_date", "remind_to", "paid_by"]) expect(again).toContain(`saved.${k} !== stored.${k}`);
      expect(src).toContain("${next !== t.next_due_date ? ', last_reminded_at = NULL' : ''}");
    });

    it("binds one parameter per column on the template INSERT", () => {
      const m = /'INSERT INTO app_expense_splitter__recurring_expenses \(([^)]*)\) VALUES \(([^)]*)\)'/.exec(src);
      expect(m, "template INSERT not found").toBeTruthy();
      expect(m[1].split(",").length).toBe(m[2].split(",").length);
    });

    it("keeps the stored anchor, compared against the date the form knows is stored", () => {
      expect(src).toContain("anchor_day: anchorForSave(storedTerms, date, f.repeat)");
      expect(src).toContain("const storedTerms = editing && f.formNext ? { ...editing, next_due_date: f.formNext } : editing;");
      expect(src).not.toMatch(/anchor_day: parseIsoDate\(date\)\.d/);
    });

    it("derives every write's reminder columns knowing whether the template is held", () => {
      expect(src).toContain("Object.assign(row, reminderColumns(row, heldNow(row)));");
      expect(src).toContain("Object.assign(updated, reminderColumns(updated, heldNow(updated)));");
    });

    it("counts a retried save as landed only when the stored terms are the ones it sent", () => {
      const save = fnBody("async function saveRecurring(origin)");
      expect(save).toContain("landed: stampLanded && sameTemplateTerms(current, row),");
      expect(save).toMatch(/if \(outcome !== 'landed' && stampLanded\) \{[\s\S]*?delete origin\.recurringPin;[\s\S]*?closeModalIfCurrent\(origin\);/);
    });

    it("holds this page's own posting off while an edit, a pause or a stop writes", () => {
      const held = fnBody("async function withPostingHeld(fn)");
      expect(held).toMatch(/templateWrites \+= 1;\n  try \{\n    if \(postingRun\) await postingRun\.catch\(\(\) => \{\}\);/);
      expect(held).toContain("if (templateWrites === 0 && postingDeferred) {");
      expect(run()).toMatch(/^function postDueRecurring\(\) \{\n  if \(templateWrites > 0\) \{ postingDeferred = true;/);
      expect(fnBody("function submitRecurring(origin)")).toContain("return withPostingHeld(async () => {");
      expect(between("window._setRecurringActive = async function", "\n};\n")).toContain("await withPostingHeld(() => setRecurringActive(id, on));");
      expect(between("window._deleteRecurring = async function", "\n};\n")).toContain("await withPostingHeld(() => stopRecurring(id));");
    });

    it("shows a pause, resume or stop as in progress on its own button", () => {
      expect(between("window._setRecurringActive = async function", "\n};\n")).toContain("markRecurringBusy(id, on ? 'resumeRecurring' : 'pauseRecurring'");
      expect(between("window._deleteRecurring = async function", "\n};\n")).toContain("markRecurringBusy(id, 'deleteRecurring', 'Stopping…');");
    });

    it("re-reads after a stop whose answer was lost, and counts a vanished row as stopped", () => {
      const d = fnBody("async function stopRecurring(id)");
      expect(d).toMatch(/if \(outcomeUnknown\(e\) && await rereadAndRender\(\{ withRecurring: true \}\)/);
      expect(d).toMatch(/!recurring\.some\(x => x\.id === id\)\) failed = null/);
    });

    it("decides lost answers with the shared re-read helper", () => {
      for (const fn of ["async function saveRecurring(", "async function setRecurringActive(", "async function stopRecurring("]) {
        expect(between(fn, "\n}"), fn).not.toContain("await loadData()");
      }
    });
  });

  describe("the form", () => {
    it("opens an unknown cadence as one the dropdown shows", () => {
      expect(src).toContain("f.repeat     = editing ? editableCadence(editing.cadence) : 'none';");
    });

    it("says why the dates cannot be saved, judged against the template as stored", () => {
      const v = fnBody("function validateForm()");
      expect(v).toContain("scheduleFormError(startValue, endValue, hubToday(), storedRow);");
      expect(v).toContain("next_due_date: f.formNext ?? editingRow.next_due_date");
      expect(v).toContain("scheduleLine.hidden = !scheduleError");
    });

    it("says before saving how many past occurrences a due date in the past will add", () => {
      const v = fnBody("function validateForm()");
      expect(v).toContain("!(startValue < today) ? 0 : dueOccurrences(");
      expect(v).toContain("paid by the payer chosen here. Move the due date to skip");
    });

    it("ties the edit state to its own form and clears it on close", () => {
      expect(src).toMatch(/if \(f\.formEl === form\) \{ f\.editId = null;/);
    });

    it("shows an edited template's stored weights rather than re-evening them", () => {
      expect(fnBody("function seedWeights()")).toMatch(/if \(f\.keepWeights\) \{[\s\S]*?return;\n  \}/);
      expect(between("window._toggleSplit = function", "\n};\n")).toContain("f.keepWeights = false;");
      expect(between("window._setSplitMethod = function", "\n};\n")).toContain("f.keepWeights = false;");
    });

    it("has one conflict check and one cents conversion", () => {
      expect(src).not.toMatch(/e\?\.status === 409 \|\|/);
      expect((src.match(/parseFloat\(f\.custom\[id\]/g) ?? []).length).toBe(1);
    });
  });

  describe("reads that fail", () => {
    it("repairs a ledger left stale by a failed closing re-read, independently of posting", () => {
      expect(finish()).toContain("if (!fresh) ledgerStale = true;");
      expect(fnBody("async function reread({ withRecurring = false } = {})")).toContain("ledgerStale = false; return true;");
      const watch = fnBody("function watchForDueDates()");
      expect(watch).toContain("if (ledgerStale) rereadAndRender({ withRecurring: true })");
      expect(watch).toMatch(/visible'\) \{ repair\(\); post\(\); \}/);
      expect(watch).toMatch(/repair\(\);\n    if \(hubToday\(\) !== lastPostingDay\) post\(\);/);
    });

    it("keeps the last template rows when a template read fails", () => {
      expect(src).toContain("if (!noRecurring) recurring = tRes.rows;");
    });

    it("calls a template removed only after a successful read says so", () => {
      const save = fnBody("async function saveRecurring(origin)");
      expect(save).toMatch(/if \(f\.editId && !editing\) \{[\s\S]*?const read = await rereadAndRender\(\{ withRecurring: true \}\);[\s\S]*?if \(!read \|\| recurringFailed\) \{[\s\S]*?saveFailed\(/);
      expect(save.indexOf("if (!read || recurringFailed)")).toBeLessThan(save.indexOf("This repeating expense has been removed."));
    });
  });

  describe("an open edit form and the posting run", () => {
    it("follows the run's stamp only when it holds the version the run posted from", () => {
      const s = fnBody("function syncOpenEditForm(writes, fresh)");
      expect(s).toContain("if (write.foreign || f.editStamp !== write.from) return;");
      expect(s.indexOf("f.editStamp !== write.from")).toBeLessThan(s.indexOf("f.editStamp = write.now;"));
      const r = fnBody("function recordPost(run, template, now, nextDue)");
      expect(r).toContain("from: prev ? prev.from : template.updated_at");
      expect(r).toContain("template.updated_at !== prev.from && template.updated_at !== prev.now");
      expect(pass()).toContain("recordPost(run, template, now, batch.next_due_date);");
      expect(finish()).toContain("recordPost(run, last.template, last.now, last.next_due_date);");
    });

    it("abandons a save whose form was closed during its re-read, rather than saving another form's values", () => {
      const save = fnBody("async function saveRecurring(origin)");
      expect(save).toMatch(/const read = await rereadAndRender\(\{ withRecurring: true \}\);\n[\s\S]*?if \(modalEl !== origin\) \{/);
      expect(save.indexOf("if (modalEl !== origin)")).toBeLessThan(save.indexOf("editing = recurring.find(t => t.id === f.editId) ?? null;\n    if (!editing)"));
    });
  });
});
