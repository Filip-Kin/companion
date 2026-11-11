import debounceFn from 'debounce-fn'
import type { CustomFeedbackControlId, SomeControlId } from '@companion-app/shared/ControlId.js'
import type { VariableValue, VariableValues } from '@companion-app/shared/Model/Variables.js'
import type { VariableDependencyRegistry } from '../../Variables/DependencyRegistry.js'
import type {
	ExpressionParserOptions,
	VariablesAndExpressionParser,
} from '../../Variables/VariablesAndExpressionParser.js'
import type { ControlCustomFeedback } from '../ControlTypes/CustomFeedback.js'
import type { CustomActionInstancesForEntity } from '../CustomActions/CustomActionInstanceManager.js'
import type { ControlEntityInstance } from '../Entities/EntityInstance.js'
import type { ControlEntityList } from '../Entities/EntityList.js'
import { EntityPoolSpecialExpressionManager } from '../Entities/EntitySpecialExpressionManager.js'
import type { EntityScope } from '../Entities/Types.js'
import type { RenderClock } from '../RenderClock.js'
import type { CustomFeedbackInstancesForEntity } from './CustomFeedbackInstanceManager.js'

/**
 * The values seen by the entities of a copy of a custom feedback
 */
export interface CustomFeedbackValues {
	/** The control id of the custom feedback */
	readonly customFeedbackControlId: CustomFeedbackControlId
	/** The values of the inputs, exposed to the entities as `$(options:<id>)` */
	readonly options: VariableValues
	/**
	 * The values of the local variables which have been set, by name (without the `local:` prefix). Nothing sets the
	 * variables of a custom feedback, so this is always empty, and each has its startup value or that of its feedback
	 */
	readonly localValues: ReadonlyMap<string, VariableValue>
}

/**
 * The scope of the entities of a copy of a custom feedback, held by a feedback which uses it.
 * The entities see the `this:*` variables of the control holding the copy, the inputs of the copy as
 * `$(options:*)`, and the local variables of the copy.
 */
export class CustomFeedbackEntityScope implements EntityScope {
	readonly specialExpressionManager: EntityPoolSpecialExpressionManager
	readonly customActionChain: ReadonlyArray<string>
	readonly customActionInstances: CustomActionInstancesForEntity
	readonly customFeedbackInstances: CustomFeedbackInstancesForEntity
	readonly isTransient = true

	readonly #customFeedback: ControlCustomFeedback
	readonly #callerControlId: SomeControlId

	#values: CustomFeedbackValues
	#feedbacks: ControlEntityList | null = null
	#localVariables: ControlEntityList | null = null

	get values(): CustomFeedbackValues {
		return this.#values
	}

	/**
	 * @param customFeedback The custom feedback this is a copy of
	 * @param callerControlId The control which holds the copy
	 * @param customActionChain The custom actions and feedbacks this copy is inside, ending with this one
	 * @param customActionInstances For any copies of custom actions inside this copy
	 * @param customFeedbackInstances For any copies of custom feedbacks used by this copy
	 * @param renderClock The render clock, for special expressions which depend on it
	 * @param variableDependencies Where the special expressions register the variables they reference
	 * @param values The inputs of the copy
	 * @param onValuesChanged Called when the isInverted value of any entity of the copy changes
	 */
	constructor(
		customFeedback: ControlCustomFeedback,
		callerControlId: SomeControlId,
		customActionChain: ReadonlyArray<string>,
		customActionInstances: CustomActionInstancesForEntity,
		customFeedbackInstances: CustomFeedbackInstancesForEntity,
		renderClock: RenderClock,
		variableDependencies: VariableDependencyRegistry,
		values: CustomFeedbackValues,
		onValuesChanged: () => void
	) {
		this.#customFeedback = customFeedback
		this.#callerControlId = callerControlId
		this.customActionChain = customActionChain
		this.customActionInstances = customActionInstances
		this.customFeedbackInstances = customFeedbackInstances
		this.#values = values

		this.specialExpressionManager = new EntityPoolSpecialExpressionManager(
			callerControlId,
			this.createVariablesAndExpressionParser.bind(this),
			{
				isInverted: (values) => {
					const changed = [
						...(this.#feedbacks?.updateIsInvertedValues(values) ?? []),
						...(this.#localVariables?.updateIsInvertedValues(values) ?? []),
					]
					if (changed.length > 0) onValuesChanged()
				},
				storeResult: () => {
					// A custom feedback has no actions, so nothing has a storeResult
				},
			},
			renderClock,
			variableDependencies
		)
	}

	/**
	 * Set the lists holding the entities of the copy
	 */
	setEntityLists(feedbacks: ControlEntityList | null, localVariables: ControlEntityList | null): void {
		this.#feedbacks = feedbacks
		this.#localVariables = localVariables
	}

	/**
	 * Replace the inputs of the copy, and re-subscribe its entities so that they are parsed with the new values
	 */
	setValues(values: CustomFeedbackValues): void {
		this.#values = values

		this.#resubscribeEntities()
	}

	/**
	 * The values of some local variables of the copy have changed, such as from a connection, so re-parse anything
	 * which may use them. Nothing is run to read them at the time, so they must be told
	 * @param changed The local variable entities whose values changed
	 */
	localVariableEntitiesChanged(changed: ControlEntityInstance[]): void {
		const names = new Set<string>()
		for (const entity of changed) {
			const name = entity.rawLocalVariableName
			if (name) names.add(`local:${name}`)
		}
		if (names.size === 0) return

		// The values of the copy are its own, so the registry doesn't know of them
		this.specialExpressionManager.onVariableDependenciesChanged([], names)

		// A connection may give its values many times in quick succession
		this.#debounceResubscribeEntities()
	}

	readonly #debounceResubscribeEntities = debounceFn(() => this.#resubscribeEntities(), { wait: 10, maxWait: 50 })

	#resubscribeEntities(): void {
		this.#localVariables?.subscribe(true)
		this.#feedbacks?.subscribe(true)
	}

	createVariablesAndExpressionParser(
		overrideVariableValues: VariableValues | null,
		options?: ExpressionParserOptions
	): VariablesAndExpressionParser {
		return this.#customFeedback.createCopyParser(
			this.#values,
			this.#callerControlId,
			this.#localVariables?.getDirectEntities() ?? [],
			overrideVariableValues,
			options ?? {}
		)
	}

	destroy(): void {
		this.#debounceResubscribeEntities.cancel()
		this.specialExpressionManager.destroy()
	}
}
