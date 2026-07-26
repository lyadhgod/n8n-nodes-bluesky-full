import type { INodeProperties } from 'n8n-workflow';

import { paginationFields, simplifyField } from './shared';

/** Properties for the Notification resource: Get Many, Get Unread Count, Mark as Read */
export const notificationDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['notification'] } },
		options: [
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'Retrieve notifications of the authenticated account',
				action: 'Get many notifications',
			},
			{
				name: 'Get Unread Count',
				value: 'getUnreadCount',
				description: 'Retrieve the number of unread notifications',
				action: 'Get the unread notification count',
			},
			{
				name: 'Mark as Read',
				value: 'markRead',
				description: 'Mark notifications as seen up to a point in time',
				action: 'Mark notifications as read',
			},
		],
		default: 'getAll',
	},

	{
		displayName: 'Seen At',
		name: 'seenAt',
		type: 'dateTime',
		default: '',
		description: 'Mark everything up to this moment as read. Defaults to now.',
		displayOptions: { show: { resource: ['notification'], operation: ['markRead'] } },
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: { resource: ['notification'], operation: ['getAll'] } },
		options: [
			{
				displayName: 'Only Unread',
				name: 'onlyUnread',
				type: 'boolean',
				default: false,
				description: 'Whether to return only notifications that have not been read yet',
			},
			{
				displayName: 'Reasons',
				name: 'reasons',
				type: 'multiOptions',
				default: [],
				description: 'Only return notifications of these kinds',
				options: [
					{ name: 'Follow', value: 'follow' },
					{ name: 'Like', value: 'like' },
					{ name: 'Mention', value: 'mention' },
					{ name: 'Quote', value: 'quote' },
					{ name: 'Reply', value: 'reply' },
					{ name: 'Repost', value: 'repost' },
					{ name: 'Starter Pack Joined', value: 'starterpack-joined' },
				],
			},
		],
	},

	...paginationFields('notification', ['getAll']),
	simplifyField('notification', ['getAll']),
];
