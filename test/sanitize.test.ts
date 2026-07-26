// Self-check for the boundary coercions. Run with `npm test`; silence means success.
// Same constraints as richtext.test.ts: no `console`, no `process`, since the
// n8n community-node lint rules apply to test files too.
import { asBoolean, asNumber, asObject, asString, asStringArray, splitList } from '../sanitize.ts';

function check(label: string, actual: unknown, expected: unknown): void {
	const got = JSON.stringify(actual);
	const want = JSON.stringify(expected);

	if (got !== want) {
		throw new Error(`${label}\n  expected: ${want}\n  actual:   ${got}`);
	}
}

// The bug this module exists to prevent: `String(undefined)` is `"undefined"`,
// a seven-character string that passes every truthiness check downstream
check('a missing string is empty, not "undefined"', asString(undefined), '');
check('null is an empty string', asString(null), '');
check('a number is not silently stringified', asString(42), '');
check('a string passes through untouched', asString(' keep me '), ' keep me ');

check('a missing number falls back', asNumber(undefined, 50), 50);
check('a blank string falls back rather than becoming 0', asNumber('', 50), 50);
check('NaN falls back', asNumber('abc', 50), 50);
check('a numeric string is parsed', asNumber('25', 50), 25);
check('a real number passes through', asNumber(0, 50), 0);

// `Boolean('false')` is true, which on `returnAll` turns one page into every page
check('the string "false" is false', asBoolean('false'), false);
check('the string "0" is false', asBoolean('0'), false);
check('the string "true" is true', asBoolean('true'), true);
check('undefined takes the fallback', asBoolean(undefined, true), true);
check('an explicit false beats the fallback', asBoolean(false, true), false);

check('an array is not a record', asObject([1, 2]), {});
check('null is not a record', asObject(null), {});
check('an object passes through', asObject({ a: 1 }), { a: 1 });

check('non-strings and blanks are dropped from lists', asStringArray(['a', '', 3, null, ' b ']), [
	'a',
	'b',
]);
check('a non-array yields no entries', asStringArray('a,b'), []);

check('a comma list is split and trimmed', splitList(' en , de ,, '), ['en', 'de']);
check('a missing comma list is empty', splitList(undefined), []);
