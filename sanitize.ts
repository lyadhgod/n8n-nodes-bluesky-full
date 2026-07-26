/**
 * Coercions for the three kinds of data this package does not control:
 * decrypted credential fields, node parameters (which may be expressions
 * evaluating to anything) and XRPC responses. All three arrive typed as
 * `IDataObject`/`unknown`, so a bare `as string` cast is a claim rather than a
 * check, and `String(value)` turns a missing field into the literal string
 * `"undefined"` — which then travels into URLs, `Authorization` headers and
 * created records as if it were real data.
 *
 * Lives at the top level next to `constants.ts` because `nodes/` and
 * `credentials/` are separate directories compiled by the same tsconfig and
 * both cross these boundaries.
 */

import type { IDataObject } from 'n8n-workflow';

/** A string, or `''` for anything else — notably never the string `"undefined"` */
export function asString(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/** A finite number, or `fallback` for anything else (`undefined`, `''`, `NaN`, objects) */
export function asNumber(value: unknown, fallback: number): number {
	if (typeof value === 'string' && value.trim() === '') return fallback;
	const parsed = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * A boolean. Strings are compared explicitly rather than passed through
 * `Boolean()`, under which the `'false'` an expression can yield is truthy —
 * on a field like `returnAll` that flips "one page" into "every page".
 */
export function asBoolean(value: unknown, fallback = false): boolean {
	if (value === undefined || value === null) return fallback;
	if (typeof value === 'string') return !['', 'false', '0'].includes(value.trim().toLowerCase());
	return Boolean(value);
}

/** A plain object, or `{}`. `null` and arrays are excluded: neither is a usable record. */
export function asObject(value: unknown): IDataObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as IDataObject)
		: {};
}

/** An array, or `[]` */
export function asArray<T>(value: unknown): T[] {
	return Array.isArray(value) ? (value as T[]) : [];
}

/** The trimmed, non-empty strings of an array of unknowns, e.g. a multiOptions parameter */
export function asStringArray(value: unknown): string[] {
	return asArray<unknown>(value)
		.map((entry) => asString(entry).trim())
		.filter((entry) => entry.length > 0);
}

/** Split a comma-separated parameter (e.g. Languages, Tags) into trimmed, non-empty entries */
export function splitList(value: unknown): string[] {
	return asStringArray(asString(value).split(','));
}
