// Shared assertion for the self-checks in this folder. Run them with `npm test`;
// silence means success. Deliberately free of `console` and `process`: the n8n
// community-node lint rules apply to every file in the package, test files included.
// `node --test` executes every file under `test/`, including this one — it has no
// checks of its own, so it simply passes.

/** Throw unless `actual` and `expected` serialise identically */
export function check(label: string, actual: unknown, expected: unknown): void {
	const got = JSON.stringify(actual);
	const want = JSON.stringify(expected);

	if (got !== want) {
		throw new Error(`${label}\n  expected: ${want}\n  actual:   ${got}`);
	}
}

/** Throw unless `run()` throws (or rejects with) a message containing `expected` */
export async function checkThrows(
	label: string,
	run: () => unknown,
	expected: string,
): Promise<void> {
	let message = 'no error was thrown';

	try {
		await run();
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}

	// Reported through `check` so the failure path stays in one place — and so
	// this file keeps out of the way of the lint rule banning a bare `throw new Error`
	check(label, message.includes(expected) ? expected : message, expected);
}
