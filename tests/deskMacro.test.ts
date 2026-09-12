// applyMacros 单测:别名/嵌套/孤儿/深度熔断/addvar/注释宏/lastUserMessage。
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMacros, type MacroCtx } from '../src/tools/deskMacro.ts';

function ctx(vars: Record<string, string> = {}): MacroCtx {
  return { user: 'User', char: 'Char', vars };
}

test('alias: setglobalvar/getglobalvar share the same pool as setvar/getvar', () => {
  const r1 = applyMacros('{{setglobalvar::a::1}}{{getglobalvar::a}}', ctx());
  assert.strictEqual(r1.text, '1');
  assert.strictEqual(r1.vars.a, '1');

  const r2 = applyMacros('{{setglobalvar::a::1}}{{getvar::a}}', ctx());
  assert.strictEqual(r2.text, '1');
});

test('nested set: a stored value can embed another getvar, expanded before storing', () => {
  const r = applyMacros('{{setvar::b::B}}{{setvar::a::x{{getvar::b}}y}}{{getvar::a}}', ctx());
  assert.strictEqual(r.text, 'xBy');
  assert.strictEqual(r.vars.a, 'xBy');
  assert.strictEqual(r.vars.b, 'B');
});

test('deep nesting: three levels of setvar/setglobalvar stacked', () => {
  const r = applyMacros(
    '{{setvar::c::C}}{{setvar::b::[{{getvar::c}}]}}{{setglobalvar::a::<{{getvar::b}}>}}{{getglobalvar::a}}',
    ctx()
  );
  assert.strictEqual(r.text, '<[C]>');
  assert.strictEqual(r.vars.a, '<[C]>');
  assert.strictEqual(r.vars.b, '[C]');
  assert.strictEqual(r.vars.c, 'C');
});

// ===== checklist fixture: a multi-line setglobalvar block whose value embeds several
// getvar placeholders (some empty, some filled), mirroring how a real preset assembles
// a checklist note and later reads it back as one block. =====

const checklistBlockRaw = [
  '{{setglobalvar::checklist::',
  '[mode]{{getvar::mode}}{{getvar::flag_a}}',
  '',
  '{{getvar::note_a}}{{getvar::note_b}}{{getvar::note_c}}',
  '[anchor](confirm core rules)',
  '',
  '[style](follow style guide{{getvar::tone}})',
  '{{getvar::note_d}}',
  '',
  '[summary]',
  '',
  '(closing remarks)',
  '}}',
].join('\n');

const checklistReceiveRaw = [
  'BEGIN: ',
  '<thinking>',
  '{{getglobalvar::checklist}}',
  'follow the checklist above without restating it verbatim.',
  '</thinking>',
  '{{getvar::emoji}}',
].join('\n');

const noteAVal = '\n[note-a fired](…)\n';
const toneVal = ', apply the house style';

// value portion (everything between the opening "{{setglobalvar::checklist::" and the
// closing "}}"), reproduced independently so the expected value isn't computed by reusing
// scanMacros itself.
const checklistValueTemplate = [
  '',
  '[mode]{{getvar::mode}}{{getvar::flag_a}}',
  '',
  '{{getvar::note_a}}{{getvar::note_b}}{{getvar::note_c}}',
  '[anchor](confirm core rules)',
  '',
  '[style](follow style guide{{getvar::tone}})',
  '{{getvar::note_d}}',
  '',
  '[summary]',
  '',
  '(closing remarks)',
  '', // the raw block's last content line and closing "}}" are on separate lines; this
  // empty element lets join reproduce that trailing "\n" inside the stored value.
].join('\n');

const expectedChecklist = checklistValueTemplate
  .replace('{{getvar::mode}}', '')
  .replace('{{getvar::flag_a}}', '')
  .replace('{{getvar::note_a}}', noteAVal)
  .replace('{{getvar::note_b}}', '')
  .replace('{{getvar::note_c}}', '')
  .replace('{{getvar::tone}}', toneVal)
  .replace('{{getvar::note_d}}', '');

let sharedVarsAfterSet: Record<string, string> = {};

test('checklist block: renders empty, vars.checklist equals the expanded value', () => {
  const r = applyMacros(checklistBlockRaw, ctx({ note_a: noteAVal, tone: toneVal }));
  assert.strictEqual(r.text, '');
  assert.strictEqual(r.vars.checklist, expectedChecklist);
  assert.ok(r.vars.checklist.includes('[note-a fired]'));
  assert.ok(r.vars.checklist.includes('[style](follow style guide, apply the house style)'));
  assert.ok(r.vars.checklist.includes('[mode]\n')); // empty placeholders render as empty
  sharedVarsAfterSet = r.vars; // the pool carries over between blocks, same as deskAssemble.ts's runMacro
});

test('checklist receive: getglobalvar reads back the stored value, empty placeholder stays empty', () => {
  const r = applyMacros(checklistReceiveRaw, ctx(sharedVarsAfterSet));
  const expected =
    'BEGIN: \n<thinking>\n' +
    expectedChecklist +
    '\nfollow the checklist above without restating it verbatim.\n</thinking>\n';
  assert.strictEqual(r.text, expected);
});

test('unrecognized macros pass through unchanged, including nested unrecognized macros', () => {
  assert.strictEqual(applyMacros('{{random::a::b}}', ctx()).text, '{{random::a::b}}');
  assert.strictEqual(applyMacros('{{roll:1d6}}', ctx()).text, '{{roll:1d6}}');
  const r = applyMacros('{{foo::{{getvar::a}}}}', ctx({ a: 'X' }));
  assert.strictEqual(r.text, '{{foo::{{getvar::a}}}}'); // whole thing passes through, inner getvar not expanded
});

test('orphan "{{" (no closing) is kept as-is, no characters swallowed', () => {
  assert.strictEqual(applyMacros('{{setvar::a', ctx()).text, '{{setvar::a');
  assert.strictEqual(applyMacros('before {{setvar::a after text', ctx()).text, 'before {{setvar::a after text');
});

test('{{trim}} still strips whitespace/newlines immediately around itself', () => {
  const r = applyMacros('{{setvar::a::x}}  \n {{trim}} \n  {{getvar::a}}', ctx());
  assert.strictEqual(r.text, 'x');
});

test('a literal "::" inside a value is preserved', () => {
  const r = applyMacros('{{setvar::a::x::y}}{{getvar::a}}', ctx());
  assert.strictEqual(r.text, 'x::y');
  assert.strictEqual(r.vars.a, 'x::y');
});

test('recursion depth: a self-referencing setvar does not infinite-loop', () => {
  const r = applyMacros('{{setvar::a::{{getvar::a}}}}{{getvar::a}}', ctx());
  // getvar reads the value from before this assignment (unset = empty string), so a
  // self-reference converges in one step regardless of the depth cutoff.
  assert.strictEqual(r.vars.a, '');
  assert.strictEqual(r.text, '');
});

test('depth cutoff: 20 levels of nested setvar stop expanding past the limit (16) without throwing', () => {
  // build a {{setvar::v0::{{setvar::v1::{{setvar::v2::...innermost...}}}}}} shape, 20 levels deep
  const DEPTH = 20;
  let inner = 'leaf';
  for (let i = DEPTH - 1; i >= 0; i--) {
    inner = `setvar::v${i}::${inner === 'leaf' ? 'leaf' : `{{${inner}}}`}`;
  }
  const text = `{{${inner}}}{{getvar::v0}}`;
  assert.doesNotThrow(() => applyMacros(text, ctx()));
  const r = applyMacros(text, ctx());
  // don't assert exactly which level got cut off (that's an implementation detail); just
  // assert it didn't throw, didn't hang, and the outer setvar did store something (it
  // wasn't treated as one big unrecognized macro, since the outer depth is within limit).
  assert.notStrictEqual(r.vars.v0, undefined);
});

test('{{user}}/{{char}} behave as before', () => {
  const r = applyMacros('{{user}}和{{char}}', ctx());
  assert.strictEqual(r.text, 'User和Char');
});

test('orphan "{{" is followed by a legal macro that still expands, orphan keeps only its own two characters', () => {
  const r = applyMacros('{{broken {{setvar::a::A}}{{getvar::a}}', ctx());
  // "{{broken " is kept as-is; the setvar/getvar nested inside it are balanced macros and expand normally
  assert.strictEqual(r.text, '{{broken A');
  assert.strictEqual(r.vars.a, 'A');
});

test('a long run of unclosed "{{" must scan linearly, not quadratically', () => {
  const n = 20000;
  const s = '{{'.repeat(n) + 'tail{{setvar::z::Z}}{{getvar::z}}';
  const t0 = Date.now();
  const r = applyMacros(s, ctx());
  const ms = Date.now() - t0;
  // all orphans pass through, the trailing legal macro still expands
  assert.strictEqual(r.text, '{{'.repeat(n) + 'tailZ');
  assert.ok(ms < 1500, `20000 orphan "{{" took ${ms}ms, looks like quadratic scanning`);
});

test('addvar appends instead of overwriting; two multi-select notes stack in the same slot, setvar still overwrites', () => {
  const r = applyMacros('{{addvar::style::[A]}}{{addvar::style::[B]}}{{getvar::style}}', ctx());
  assert.strictEqual(r.text, '[A][B]');
  assert.strictEqual(r.vars.style, '[A][B]');
  const r2 = applyMacros('{{setvar::style::[A]}}{{setvar::style::[B]}}{{getvar::style}}', ctx());
  assert.strictEqual(r2.text, '[B]');
});

test('addvar starts from empty string when unset; addglobalvar is an alias for the same pool; value is expanded before appending', () => {
  const r = applyMacros('{{setvar::x::X}}{{addglobalvar::a::<{{getvar::x}}>}}{{addvar::a::!}}{{getglobalvar::a}}', ctx());
  assert.strictEqual(r.text, '<X>!');
  assert.strictEqual(r.vars.a, '<X>!');
});

test('addvar adds numerically when both sides are numbers, otherwise concatenates as strings', () => {
  assert.strictEqual(applyMacros('{{setvar::n::2}}{{addvar::n::3}}{{getvar::n}}', ctx()).text, '5');
  assert.strictEqual(applyMacros('{{setvar::n::2}}{{addvar::n::x}}{{getvar::n}}', ctx()).text, '2x');
  assert.strictEqual(applyMacros('{{addvar::n::3}}{{getvar::n}}', ctx()).text, '3'); // empty start + number = string "3"
});

test('{{// comment}} renders empty; macros inside a comment are swallowed too, not expanded', () => {
  assert.strictEqual(applyMacros('before{{//this note is only for the preset author}}after', ctx()).text, 'beforeafter');
  assert.strictEqual(applyMacros('{{// note {{getvar::a}} here}}', ctx({ a: 'X' })).text, '');
  assert.strictEqual(applyMacros('{{//}}', ctx()).text, '');
});

test('{{lastUserMessage}} renders this turn\'s input; empty string when ctx omits it', () => {
  const c: MacroCtx = { ...ctx(), lastUserMessage: 'hello there' };
  assert.strictEqual(applyMacros('<user_input>\n{{lastUserMessage}}\n</user_input>', c).text, '<user_input>\nhello there\n</user_input>');
  assert.strictEqual(applyMacros('[{{lastUserMessage}}]', ctx()).text, '[]');
});

test('order of operations: addvar then getvar in sequence, value flows into a wrapping block, block itself renders empty', () => {
  const textile = '{{addvar::style::\n[Timbre: Textile Prose]\nConcrete nouns.\n}}';
  const r1 = applyMacros(textile, ctx());
  assert.strictEqual(r1.text, '');
  const r2 = applyMacros('<style>\n{{getvar::style}}\n</style>', ctx(r1.vars));
  assert.strictEqual(r2.text, '<style>\n\n[Timbre: Textile Prose]\nConcrete nouns.\n\n</style>');
});

test('unrecognized macros still pass through unaffected by the new prefixes (random/roll)', () => {
  assert.strictEqual(applyMacros('{{random::a::b}}{{roll:1d6}}', ctx()).text, '{{random::a::b}}{{roll:1d6}}');
});

test('known macro names without "::" parameters are not macros and pass through unchanged', () => {
  const src = '{{setvar}}|{{getvar}}|{{addvar}}|{{setglobalvar}}|{{getglobalvar}}|{{addglobalvar}}';
  const r = applyMacros(src, ctx({ a: 'X' }));
  assert.strictEqual(r.text, src);
  assert.deepStrictEqual(r.vars, { a: 'X' });
});

test('nested parsing (documented semantic): a literal "{{" inside a value is read as a nested macro start', () => {
  // The value contains a balanced inner "{{y}}", so the outer setvar closes at the final "}}" and stores
  // the expanded value; an unrecognized inner macro is kept verbatim inside the stored value.
  const r = applyMacros('{{setvar::a::x{{y}}}}{{getvar::a}}', ctx());
  assert.strictEqual(r.text, 'x{{y}}');
  assert.strictEqual(r.vars.a, 'x{{y}}');
  // Without a closing pair for the outer macro, the outer "{{" is an orphan and only the inner macro is parsed.
  const r2 = applyMacros('{{setvar::a::x{{y}}{{getvar::a}}', ctx());
  assert.strictEqual(r2.text, '{{setvar::a::x{{y}}');
  assert.strictEqual(r2.vars.a, undefined);
});
