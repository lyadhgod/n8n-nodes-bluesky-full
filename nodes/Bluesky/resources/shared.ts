import type { INodeProperties } from 'n8n-workflow';

/**
 * Property builders shared across resource description files (post.ts, feed.ts,
 * user.ts, notification.ts). Each takes the owning `resource` and the list of
 * `operation` values it should be visible for, and returns the `displayOptions`-scoped
 * property definition(s) — factored out because "Return All" / "Limit" / "Simplify" /
 * the post-URI field are otherwise byte-for-byte identical across every operation that uses them.
 */

/** "Return All" + "Limit" (shown only when Return All is off), scoped to one resource/operations */
export function paginationFields(resource: string, operations: string[]): INodeProperties[] {
	return [
		{
			displayName: 'Return All',
			name: 'returnAll',
			type: 'boolean',
			default: false,
			description: 'Whether to return all results or only up to a given limit',
			displayOptions: { show: { resource: [resource], operation: operations } },
		},
		{
			displayName: 'Limit',
			name: 'limit',
			type: 'number',
			typeOptions: { minValue: 1 },
			default: 50,
			description: 'Max number of results to return',
			displayOptions: {
				show: { resource: [resource], operation: operations, returnAll: [false] },
			},
		},
	];
}

/** The "Simplify" toggle (default on), scoped to one resource/operations */
export function simplifyField(resource: string, operations: string[]): INodeProperties {
	return {
		displayName: 'Simplify',
		name: 'simplify',
		type: 'boolean',
		default: true,
		description: 'Whether to return a simplified version of the response instead of the raw data',
		displayOptions: { show: { resource: [resource], operation: operations } },
	};
}

/** The "Post" field accepting an AT URI or bsky.app link, scoped to the given `post` operations */
export function postUriField(operations: string[]): INodeProperties {
	return {
		displayName: 'Post',
		name: 'uri',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. at://did:plc:abc123/app.bsky.feed.post/3k2a or https://bsky.app/profile/…',
		description: 'The AT URI of the post, or its bsky.app link',
		displayOptions: { show: { resource: ['post'], operation: operations } },
	};
}

/** The "Account" field accepting a handle, DID or bsky.app profile link, scoped to one resource/operations */
export function actorField(resource: string, operations: string[]): INodeProperties {
	return {
		displayName: 'Account',
		name: 'actor',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. alice.bsky.social',
		description: 'The handle or DID of the account, or its bsky.app profile link',
		displayOptions: { show: { resource: [resource], operation: operations } },
	};
}
