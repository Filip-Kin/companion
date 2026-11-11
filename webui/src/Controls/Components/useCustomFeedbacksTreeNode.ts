import { useContext } from 'react'
import { CUSTOM_FEEDBACKS_CONNECTION_ID } from '@companion-app/shared/ConnectionId.js'
import { CreateCustomFeedbackControlId } from '@companion-app/shared/ControlId.js'
import type { CustomFeedbackCollection } from '@companion-app/shared/Model/CustomFeedbackModel.js'
import { useComputed } from '~/Resources/util.js'
import type { EntityLeafItem } from '~/Stores/EntityDefinitionsStore.js'
import { RootAppStoreContext } from '~/Stores/RootAppStore.js'
import type { CollapsibleTreeNode } from '../../Components/CollapsibleTree/CollapsibleTree.js'
import type { ConnectionTreeNodeMeta } from './useConnectionTreeNodes.js'

/**
 * Build the tree node for the custom feedbacks, with a child node for each collection of custom feedbacks
 * @param leaves The leaves for each of the custom feedbacks
 * @returns The node, or null if there are no custom feedbacks
 */
export function useCustomFeedbacksTreeNode(
	leaves: EntityLeafItem[]
): CollapsibleTreeNode<EntityLeafItem, ConnectionTreeNodeMeta> | null {
	const { customFeedbacksList } = useContext(RootAppStoreContext)

	return useComputed(() => {
		if (leaves.length === 0) return null

		// Group the leaves by the collection of their custom feedback
		const leavesByCollection = new Map<string | null, EntityLeafItem[]>()
		for (const leaf of leaves) {
			const definitionId = leaf.fullId.slice(CUSTOM_FEEDBACKS_CONNECTION_ID.length + 1)
			const collectionId =
				customFeedbacksList.customFeedbacks.get(CreateCustomFeedbackControlId(definitionId))?.collectionId || null

			let list = leavesByCollection.get(collectionId)
			if (!list) {
				list = []
				leavesByCollection.set(collectionId, list)
			}
			list.push(leaf)
		}

		const buildCollectionNode = (
			collection: CustomFeedbackCollection
		): CollapsibleTreeNode<EntityLeafItem, ConnectionTreeNodeMeta> | null => {
			const children = [...collection.children]
				.sort((a, b) => a.sortOrder - b.sortOrder)
				.map(buildCollectionNode)
				.filter((node) => !!node)
			const collectionLeaves = leavesByCollection.get(collection.id) ?? []

			// Skip collections that have no custom feedbacks anywhere in their subtree
			if (children.length === 0 && collectionLeaves.length === 0) return null

			return {
				id: `custom-feedback-collection:${collection.id}`,
				children,
				leaves: collectionLeaves,
				metadata: {
					type: 'connection',
					connectionId: CUSTOM_FEEDBACKS_CONNECTION_ID,
					connectionLabel: collection.label,
					moduleDisplayName: 'Custom feedbacks',
				},
			}
		}

		return {
			id: `connection:${CUSTOM_FEEDBACKS_CONNECTION_ID}`,
			children: customFeedbacksList
				.rootCollections()
				.map(buildCollectionNode)
				.filter((node) => !!node),
			leaves: leavesByCollection.get(null) ?? [],
			metadata: {
				type: 'connection',
				connectionId: CUSTOM_FEEDBACKS_CONNECTION_ID,
				connectionLabel: 'Custom feedbacks',
				moduleDisplayName: undefined,
			},
		}
	}, [leaves, customFeedbacksList])
}
