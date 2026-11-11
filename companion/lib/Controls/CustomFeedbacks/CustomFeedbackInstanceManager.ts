import { EventEmitter } from 'node:events'
import debounceFn from 'debounce-fn'
import isEqual from 'fast-deep-equal'
import { CUSTOM_FEEDBACKS_CONNECTION_ID, isCustomFeedbacksConnectionId } from '@companion-app/shared/ConnectionId.js'
import {
	CreateCustomFeedbackControlId,
	type CustomFeedbackControlId,
	type SomeControlId,
} from '@companion-app/shared/ControlId.js'
import { EntityModelType, FeedbackEntitySubType } from '@companion-app/shared/Model/EntityModel.js'
import LogController, { type Logger } from '../../Log/Controller.js'
import type {
	VariableDependency,
	VariableDependencyListener,
	VariableDependencyRegistry,
} from '../../Variables/DependencyRegistry.js'
import { ControlCustomFeedback } from '../ControlTypes/CustomFeedback.js'
import { MAX_CUSTOM_ACTION_DEPTH } from '../CustomActionRunFrame.js'
import { deriveEntityIds } from '../CustomActions/CustomActionInstanceManager.js'
import type { ControlEntityInstance } from '../Entities/EntityInstance.js'
import type { EntityScope, FeedbackExecutionContext, NewFeedbackValue } from '../Entities/Types.js'
import type { IControlStore } from '../IControlStore.js'
import type { RenderClock } from '../RenderClock.js'
import { CustomFeedbackEntityScope } from './CustomFeedbackEntityScope.js'

/** The transient child group of a calling feedback, holding the feedbacks of its copy of the custom feedback */
export const CUSTOM_FEEDBACK_COPY_FEEDBACKS_GROUP = 'custom-feedback-copy:feedbacks'
/** The transient child group of a calling feedback, holding the local variables of its copy of the custom feedback */
export const CUSTOM_FEEDBACK_COPY_LOCAL_VARIABLES_GROUP = 'custom-feedback-copy:local-variables'

export type CustomFeedbackInstancesForEntity = Pick<
	CustomFeedbackInstanceManager,
	'entityUpdate' | 'entityDelete' | 'evaluateLive'
>

/**
 * The copy of a custom feedback held by a feedback which uses it
 */
interface PlacedCopy {
	/** The control holding the calling feedback */
	readonly controlId: SomeControlId
	/** The scope the calling feedback parses its options in */
	callerScope: EntityScope
	/** The control id of the custom feedback which was copied, if there is a copy */
	customFeedbackControlId: CustomFeedbackControlId | null
	/** The scope of the copy, or null if there is no copy */
	scope: CustomFeedbackEntityScope | null
	/** The variables the inputs of the copy referenced when they were parsed, so that they are re-parsed when one changes */
	readonly inputVariables: VariableDependency<ControlEntityInstance>
}

export interface CustomFeedbackInstanceEvents {
	/** A feedback which uses a custom feedback has been added, changed or removed */
	usageChanged: []
}

/**
 * Every feedback which uses a custom feedback holds a copy of the custom feedback's feedbacks and local variables,
 * subscribed with the inputs given by that feedback.
 *
 * The value of the calling feedback is computed from its copy, and given to it in the same way as a connection gives
 * a feedback its value. Unlike a custom action there is no run, whose inputs need freezing while it runs, so the copy
 * held by the calling feedback is the only one.
 *
 * The copies are never persisted, and are rebuilt whenever the custom feedback changes.
 */
export class CustomFeedbackInstanceManager implements VariableDependencyListener<ControlEntityInstance> {
	readonly #logger: Logger = LogController.createLogger('Controls/CustomFeedbacks/InstanceManager')

	readonly #controlStore: Pick<IControlStore, 'getControl' | 'updateFeedbackValues'>
	readonly #renderClock: RenderClock
	readonly #variableDependencies: VariableDependencyRegistry

	/** The copies, by the feedback which uses the custom feedback */
	readonly #copies = new Map<ControlEntityInstance, PlacedCopy>()

	readonly events = new EventEmitter<CustomFeedbackInstanceEvents>()

	/** The custom feedbacks which have changed, so their copies need rebuilding */
	#changedCustomFeedbackIds = new Set<CustomFeedbackControlId>()

	/** The calling feedbacks whose value needs computing again */
	#pendingValueCallers = new Set<ControlEntityInstance>()

	constructor(
		controlStore: Pick<IControlStore, 'getControl' | 'updateFeedbackValues'>,
		renderClock: RenderClock,
		variableDependencies: VariableDependencyRegistry
	) {
		this.#controlStore = controlStore
		this.#renderClock = renderClock
		this.#variableDependencies = variableDependencies
	}

	/**
	 * A feedback which uses a custom feedback has been added or changed, so build or update its copy
	 * @param caller The feedback which uses a custom feedback
	 * @param controlId The control holding the feedback
	 * @param callerScope The scope the feedback parses its options in
	 */
	entityUpdate(caller: ControlEntityInstance, controlId: SomeControlId, callerScope: EntityScope): void {
		this.events.emit('usageChanged')

		// A change to the calling feedback clears its value, even when its copy is unchanged
		this.#queueValueUpdate(caller)

		if (caller.disabled) {
			// A disabled feedback has nothing subscribed
			this.#removeCopy(caller)
			return
		}

		const copy = this.#copies.get(caller)
		if (copy && copy.customFeedbackControlId === CreateCustomFeedbackControlId(caller.definitionId)) {
			copy.callerScope = callerScope
			this.#refreshInputs(caller, copy)
		} else {
			const newCopy: PlacedCopy = copy ?? {
				controlId,
				callerScope,
				customFeedbackControlId: null,
				scope: null,
				inputVariables: this.#variableDependencies.create(this, controlId, caller),
			}
			newCopy.callerScope = callerScope
			this.#copies.set(caller, newCopy)
			this.#build(caller, newCopy)
		}
	}

	/**
	 * A feedback which uses a custom feedback has been removed or disabled, so remove its copy
	 * @param caller The feedback which uses a custom feedback
	 */
	entityDelete(caller: ControlEntityInstance): void {
		this.#removeCopy(caller)
		this.events.emit('usageChanged')
	}

	/**
	 * Get the scope of the copy held by a feedback which uses a custom feedback
	 * @param caller The feedback which uses a custom feedback
	 * @returns The scope, or undefined if the feedback has no copy
	 */
	getCopyScope(caller: ControlEntityInstance): CustomFeedbackEntityScope | undefined {
		return this.#copies.get(caller)?.scope ?? undefined
	}

	/**
	 * Evaluate a calling feedback now, in the execution context of an action it is a condition of, rather than using
	 * its cached value. Its inputs are parsed in that context, so that they see what the action has just done, and
	 * the internal feedbacks of its copy are evaluated with them and the `$(this:*)` variables of the execution.
	 * As anywhere else, connection feedbacks can only provide their cached values, from the inputs of the copy
	 * @param caller The feedback which uses a custom feedback
	 * @param context The execution context
	 */
	evaluateLive(caller: ControlEntityInstance, context: FeedbackExecutionContext): boolean {
		const copy = this.#copies.get(caller)
		if (!copy?.scope) return false

		const customFeedback = this.#controlStore.getControl(copy.scope.values.customFeedbackControlId)
		if (!(customFeedback instanceof ControlCustomFeedback)) return false

		// Invalid inputs make it inactive, as they do the copy
		const parseRes = customFeedback.parseCallInputs(caller.rawOptions, context.parser, copy.controlId)
		if (!parseRes.ok) return false

		const parser = customFeedback.createCopyParser(
			{ ...copy.scope.values, options: parseRes.options },
			copy.controlId,
			caller.getTransientChildGroup(CUSTOM_FEEDBACK_COPY_LOCAL_VARIABLES_GROUP)?.getDirectEntities() ?? [],
			context.executionVariables,
			context.parserOptions
		)

		return isAllTrue(
			caller
				.getTransientChildGroup(CUSTOM_FEEDBACK_COPY_FEEDBACKS_GROUP)
				?.getChildBooleanFeedbackValues({ ...context, parser })
		)
	}

	/**
	 * Give the copy held by a calling feedback the runtime values of the copy held by another, which is a copy of the
	 * same calling feedback in the same circumstances (eg for a run of a custom action). This lets the new copy be used
	 * straight away, without waiting for the values to be recomputed
	 * @param target The calling feedback of the new copy
	 * @param source The calling feedback of the existing copy
	 */
	copyRuntimeValues(target: ControlEntityInstance, source: ControlEntityInstance): void {
		const targetScope = this.getCopyScope(target)
		const sourceScope = this.getCopyScope(source)
		if (!targetScope || !sourceScope || !isEqual(targetScope.values.options, sourceScope.values.options)) return

		const sourceEntities = new Map<string, ControlEntityInstance>()
		for (const entity of getCopyEntities(source)) {
			sourceEntities.set(entity.id.slice(source.id.length + 1), entity)
		}

		for (const entity of getCopyEntities(target)) {
			const sourceEntity = sourceEntities.get(entity.id.slice(target.id.length + 1))
			if (!sourceEntity) continue

			entity.copyRuntimeValuesFrom(sourceEntity)

			if (isCustomFeedbacksConnectionId(entity.connectionId)) this.copyRuntimeValues(entity, sourceEntity)
		}

		this.#queueValueUpdate(target)
	}

	/**
	 * A custom feedback has been changed or deleted, so its copies need rebuilding
	 * @param customFeedbackControlId The control id of the custom feedback
	 */
	onCustomFeedbackChanged(customFeedbackControlId: CustomFeedbackControlId): void {
		this.#changedCustomFeedbackIds.add(customFeedbackControlId)
		this.#debounceRebuildChanged()
	}

	readonly #debounceRebuildChanged = debounceFn(
		() => {
			const changedIds = this.#changedCustomFeedbackIds
			this.#changedCustomFeedbackIds = new Set()

			// Building a copy adds and removes the copies nested inside it, so work from a snapshot
			for (const [caller, copy] of [...this.#copies]) {
				if (this.#copies.get(caller) !== copy) continue

				if (changedIds.has(CreateCustomFeedbackControlId(caller.definitionId))) {
					this.#build(caller, copy)
				}
			}
		},
		{ wait: 20, maxWait: 100 }
	)

	/**
	 * Some variables read by the inputs of copies have changed, so re-parse those inputs. The entities of the copies
	 * are told of the changes by the registry themselves
	 */
	onVariableDependenciesChanged(hits: ReadonlyArray<VariableDependency<ControlEntityInstance>>): void {
		for (const hit of hits) {
			// Re-parsing the inputs of a copy can remove the copies nested inside it
			const copy = this.#copies.get(hit.data)
			if (copy?.inputVariables !== hit) continue

			this.#refreshInputs(hit.data, copy)
		}
	}

	/**
	 * Build the copy held by a calling feedback, replacing any existing copy
	 */
	#build(caller: ControlEntityInstance, copy: PlacedCopy): void {
		this.#clearCopy(caller, copy)

		const customFeedbackControlId = CreateCustomFeedbackControlId(caller.definitionId)
		copy.customFeedbackControlId = customFeedbackControlId

		const customFeedback = this.#controlStore.getControl(customFeedbackControlId)
		if (!(customFeedback instanceof ControlCustomFeedback)) return

		const chain = copy.callerScope.customActionChain
		if (chain.includes(customFeedbackControlId)) {
			this.#logger.warn(`Not using "${customFeedback.options.name}" in ${copy.controlId}, as it uses itself`)
			return
		}
		if (chain.length >= MAX_CUSTOM_ACTION_DEPTH) {
			this.#logger.warn(`Not using "${customFeedback.options.name}" in ${copy.controlId}, as it is nested too deeply`)
			return
		}

		const parseRes = customFeedback.parseCallInputs(
			caller.rawOptions,
			copy.callerScope.createVariablesAndExpressionParser(null),
			copy.controlId
		)
		// Even when invalid, so that the copy is built once a variable they use changes
		copy.inputVariables.set(parseRes.referencedVariableIds)
		if (!parseRes.ok) {
			// Inactive until its inputs can be parsed, as a module feedback is
			this.#logger.warn(
				`Failed to parse the inputs of custom feedback "${customFeedback.options.name}" in ${copy.controlId}: ${JSON.stringify(parseRes.optionErrors)}`
			)
			return
		}

		const scope = new CustomFeedbackEntityScope(
			customFeedback,
			copy.controlId,
			[...chain, customFeedbackControlId],
			copy.callerScope.customActionInstances,
			this,
			this.#renderClock,
			this.#variableDependencies,
			{ customFeedbackControlId, options: parseRes.options, localValues: new Map() },
			() => this.#queueValueUpdate(caller)
		)
		copy.scope = scope

		const idPrefix = `${caller.id}/`

		// The local variables are built first, so that they are available to the feedbacks as they are subscribed
		const localVariables = caller.setTransientChildGroup(
			CUSTOM_FEEDBACK_COPY_LOCAL_VARIABLES_GROUP,
			scope,
			{ type: EntityModelType.Feedback, feedbackListType: FeedbackEntitySubType.Value },
			deriveEntityIds(
				idPrefix,
				customFeedback.entities.getLocalVariableEntities().map((entity) => entity.asEntityModel(true))
			),
			(changed) => scope.localVariableEntitiesChanged(changed)
		)
		scope.setEntityLists(null, localVariables)

		const feedbacks = caller.setTransientChildGroup(
			CUSTOM_FEEDBACK_COPY_FEEDBACKS_GROUP,
			scope,
			{ type: EntityModelType.Feedback, feedbackListType: FeedbackEntitySubType.Boolean },
			deriveEntityIds(
				idPrefix,
				customFeedback.entities.getFeedbackEntities().map((entity) => entity.asEntityModel(true))
			),
			() => this.#queueValueUpdate(caller)
		)
		scope.setEntityLists(feedbacks, localVariables)

		this.#queueValueUpdate(caller)
	}

	/**
	 * Re-parse the inputs of a copy, and re-subscribe its entities if they have changed
	 */
	#refreshInputs(caller: ControlEntityInstance, copy: PlacedCopy): void {
		const scope = copy.scope
		if (!scope) {
			// Inactive because its inputs were invalid, so try building it again
			this.#build(caller, copy)
			return
		}

		const customFeedback = this.#controlStore.getControl(scope.values.customFeedbackControlId)
		if (!(customFeedback instanceof ControlCustomFeedback)) return

		const parseRes = customFeedback.parseCallInputs(
			caller.rawOptions,
			copy.callerScope.createVariablesAndExpressionParser(null),
			copy.controlId
		)
		if (!parseRes.ok) {
			// It becomes inactive, which building it again does
			this.#build(caller, copy)
			return
		}
		copy.inputVariables.set(parseRes.referencedVariableIds)

		if (isEqual(parseRes.options, scope.values.options)) return

		scope.setValues({ ...scope.values, options: parseRes.options })
	}

	/**
	 * Remove the entities and scope of a copy
	 */
	#clearCopy(caller: ControlEntityInstance, copy: PlacedCopy): void {
		caller.removeTransientChildGroup(CUSTOM_FEEDBACK_COPY_FEEDBACKS_GROUP)
		caller.removeTransientChildGroup(CUSTOM_FEEDBACK_COPY_LOCAL_VARIABLES_GROUP)

		copy.scope?.destroy()
		copy.scope = null
		copy.customFeedbackControlId = null
		copy.inputVariables.set(null)

		// Without a copy, the feedback is false
		this.#queueValueUpdate(caller)
	}

	#removeCopy(caller: ControlEntityInstance): void {
		const copy = this.#copies.get(caller)
		if (!copy) return

		this.#copies.delete(caller)
		this.#clearCopy(caller, copy)
		copy.inputVariables.dispose()
	}

	/**
	 * Compute the value of a calling feedback again, once the current changes are complete
	 */
	#queueValueUpdate(caller: ControlEntityInstance): void {
		if (this.#pendingValueCallers.size === 0) queueMicrotask(() => this.#updateValues())
		this.#pendingValueCallers.add(caller)
	}

	#updateValues(): void {
		const callers = this.#pendingValueCallers
		this.#pendingValueCallers = new Set()

		const newValues: NewFeedbackValue[] = []
		for (const caller of callers) {
			// A feedback which no longer has a copy has been removed or disabled, so has no value to give
			const copy = this.#copies.get(caller)
			if (!copy) continue

			newValues.push({ entityId: caller.id, controlId: copy.controlId, value: computeCopyValue(caller, !!copy.scope) })
		}

		if (newValues.length > 0) this.#controlStore.updateFeedbackValues(CUSTOM_FEEDBACKS_CONNECTION_ID, newValues)
	}
}

/**
 * Compute the value of a calling feedback from its copy: true when it has some feedbacks, and all of them are true
 * @param caller The feedback which uses the custom feedback
 * @param hasCopy Whether the feedback has a copy, as it may have been refused one (eg for using itself)
 */
function computeCopyValue(caller: ControlEntityInstance, hasCopy: boolean): boolean {
	if (!hasCopy) return false

	return isAllTrue(
		caller.getTransientChildGroup(CUSTOM_FEEDBACK_COPY_FEEDBACKS_GROUP)?.getChildBooleanFeedbackValues(null)
	)
}

/**
 * The value of a custom feedback from the values of its feedbacks: true when it has some, and all of them are true
 */
function isAllTrue(values: boolean[] | undefined): boolean {
	return !!values && values.length > 0 && values.every((value) => value)
}

/**
 * Get all the entities of the copy held by a calling feedback
 */
function getCopyEntities(caller: ControlEntityInstance): ControlEntityInstance[] {
	return [CUSTOM_FEEDBACK_COPY_LOCAL_VARIABLES_GROUP, CUSTOM_FEEDBACK_COPY_FEEDBACKS_GROUP].flatMap(
		(groupId) => caller.getTransientChildGroup(groupId)?.getAllEntities() ?? []
	)
}
