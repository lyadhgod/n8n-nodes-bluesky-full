import type { INodeProperties } from 'n8n-workflow';

import { actorField, paginationFields, simplifyField } from './shared';

/** Operations that take a single "Account" parameter, i.e. every one except Search */
const ACTOR_OPERATIONS = [
	'block',
	'follow',
	'get',
	'getFollowers',
	'getFollowing',
	'mute',
	'unblock',
	'unfollow',
	'unmute',
];

/**
 * Properties for the User resource: Get, Search, Get Followers/Following,
 * Follow/Unfollow, Block/Unblock, Mute/Unmute.
 */
export const userDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['user'] } },
		options: [
			{
				name: 'Block',
				value: 'block',
				description: 'Block an account',
				action: 'Block a user',
			},
			{
				name: 'Follow',
				value: 'follow',
				description: 'Follow an account',
				action: 'Follow a user',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Retrieve the profile of an account',
				action: 'Get a user',
			},
			{
				name: 'Get Followers',
				value: 'getFollowers',
				description: 'Retrieve the accounts following an account',
				action: 'Get the followers of a user',
			},
			{
				name: 'Get Following',
				value: 'getFollowing',
				description: 'Retrieve the accounts an account follows',
				action: 'Get the accounts a user follows',
			},
			{
				name: 'Mute',
				value: 'mute',
				description: 'Mute an account',
				action: 'Mute a user',
			},
			{
				name: 'Search',
				value: 'search',
				description: 'Search accounts by name or handle',
				action: 'Search users',
			},
			{
				name: 'Unblock',
				value: 'unblock',
				description: 'Remove a block on an account',
				action: 'Unblock a user',
			},
			{
				name: 'Unfollow',
				value: 'unfollow',
				description: 'Stop following an account',
				action: 'Unfollow a user',
			},
			{
				name: 'Unmute',
				value: 'unmute',
				description: 'Remove a mute on an account',
				action: 'Unmute a user',
			},
		],
		default: 'get',
	},

	actorField('user', ACTOR_OPERATIONS),
	{
		displayName: 'Query',
		name: 'query',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. alice',
		description: 'Search term matched against handles and display names',
		displayOptions: { show: { resource: ['user'], operation: ['search'] } },
	},

	...paginationFields('user', ['getFollowers', 'getFollowing', 'search']),
	simplifyField('user', ['get', 'getFollowers', 'getFollowing', 'search']),
];
