import type { INodeProperties } from 'n8n-workflow';

import { actorField, paginationFields, simplifyField } from './shared';

/** Properties for the Feed resource: Get Timeline, Get Author Feed, Get Custom Feed */
export const feedDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['feed'] } },
		options: [
			{
				name: 'Get Timeline',
				value: 'getTimeline',
				description: 'Retrieve the home timeline of the authenticated account',
				action: 'Get the home timeline',
			},
			{
				name: 'Get Author Feed',
				value: 'getAuthorFeed',
				description: 'Retrieve the posts and reposts of an account',
				action: 'Get the feed of an account',
			},
			{
				name: 'Get Custom Feed',
				value: 'getFeed',
				description: 'Retrieve the posts of a custom feed generator',
				action: 'Get a custom feed',
			},
		],
		default: 'getTimeline',
	},

	actorField('feed', ['getAuthorFeed']),
	{
		displayName: 'Feed',
		name: 'feedUri',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. at://did:plc:abc123/app.bsky.feed.generator/whats-hot',
		description: 'The AT URI of the feed generator',
		displayOptions: { show: { resource: ['feed'], operation: ['getFeed'] } },
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: { resource: ['feed'], operation: ['getAuthorFeed'] } },
		options: [
			{
				displayName: 'Filter',
				name: 'filter',
				type: 'options',
				default: 'posts_with_replies',
				description: 'Which kinds of posts to include',
				options: [
					{ name: 'Posts and Author Threads', value: 'posts_and_author_threads' },
					{ name: 'Posts With Media', value: 'posts_with_media' },
					{ name: 'Posts With Replies', value: 'posts_with_replies' },
					{ name: 'Posts With Video', value: 'posts_with_video' },
					{ name: 'Posts Without Replies', value: 'posts_no_replies' },
				],
			},
			{
				displayName: 'Include Pinned Posts',
				name: 'includePins',
				type: 'boolean',
				default: false,
				description: 'Whether to include the pinned post of the account',
			},
		],
	},

	...paginationFields('feed', ['getTimeline', 'getAuthorFeed', 'getFeed']),
	simplifyField('feed', ['getTimeline', 'getAuthorFeed', 'getFeed']),
];
