import {
    ActivityFinished,
    ActivityStarts,
    DomainEvent,
    FeatureNarrativeDetected,
    SceneDescriptionDetected,
    SceneFinished,
    SceneParametersDetected,
    SceneSequenceDetected,
    SceneStarts,
    SceneTagged,
    SceneTemplateDetected,
    TestRunFinished,
    TestRunnerDetected,
} from '@serenity-js/core/lib/events';
import { FileSystemLocation, Path } from '@serenity-js/core/lib/io';
import {
    ActivityDetails,
    CapabilityTag,
    Category,
    Description,
    ExecutionFailedWithError,
    ExecutionSkipped,
    ExecutionSuccessful,
    FeatureTag,
    ImplementationPending,
    Name,
    Outcome,
    ScenarioDetails,
    Tag,
    Tags,
    ThemeTag,
} from '@serenity-js/core/lib/model';
import { StageManager } from '@serenity-js/core/lib/stage';
import * as cucumber from 'cucumber';
import { Loader, Mapper } from '../gherkin';
import { Feature, ScenarioOutline } from '../gherkin/model';

const flatten = <T>(acc: T[], list: T[]): T[] => acc.concat(list);
const notEmpty = <T>(list: T[]) => list.filter(item => !! item);

export class Notifier {
    constructor(
        private readonly stageManager: StageManager,
        private readonly loader: Loader,
        private readonly mapper: Mapper,
    ) {
    }

    scenarioStarts(scenario: cucumber.events.ScenarioPayload): Promise<void> {
        return this.loader.load(new Path(scenario.getFeature().getUri()))
            .then(result => {

                const map = this.mapper.map(result);
                const feature = map.get(Feature).onLine(scenario.getFeature().getLine());

                if (scenario.getLines().length === 2) {
                    const outline = map.get(ScenarioOutline).onLine(scenario.getLines()[1]);

                    const template = outline.steps.map(step => step.value).join('\n');

                    this.emit(
                        new SceneSequenceDetected(this.sequenceDetailsOf(scenario)),
                        new SceneTemplateDetected(new Description(template)),
                        new SceneParametersDetected(
                            this.scenarioDetailsOf(scenario),
                            outline.parameters[scenario.getLine()],
                        ),
                    );
                }

                const details = this.scenarioDetailsOf(scenario);

                this.emit(...notEmpty([
                    new SceneStarts(details),
                    feature.description && new FeatureNarrativeDetected(feature.description),
                    new TestRunnerDetected(new Name('Cucumber')),
                    ...this.scenarioHierarchyTagsFor(scenario).map(tag => new SceneTagged(details, tag)),
                    !! scenario.getDescription() && new SceneDescriptionDetected(new Description(scenario.getDescription())),
                    ...this.customTagsFor(scenario).map(tag => new SceneTagged(details, tag)),
                ]));
            });
    }

    stepStarts(step: cucumber.events.StepPayload) {
        if (! step.isHidden()) {                                                            // "before" and "after" steps emit a 'hidden' event, which we ignore
            this.emit(
                new ActivityStarts(this.activityDetailsOf(step)),
            );
        }
    }

    stepFinished(result: cucumber.events.StepResultPayload) {
        if (! result.getStep().isHidden()) {                                                // "before" and "after" steps emit a 'hidden' event, which we ignore
            this.emit(
                new ActivityFinished(
                    this.activityDetailsOf(result.getStep()),
                    this.stepOutcomeFrom(result),
                ),
            );
        }
    }

    scenarioFinished(result: cucumber.events.ScenarioResultPayload) {
        this.emit(
            new SceneFinished(
                this.scenarioDetailsOf(result.getScenario()),
                this.scenarioOutcomeFrom(result),
            ),
        );
    }

    testRunFinished(result: cucumber.events.FeaturesPayload) {
        this.emit(
            new TestRunFinished(),
        );
    }

    private sequenceDetailsOf(scenario: cucumber.events.ScenarioPayload): ScenarioDetails {
        return new ScenarioDetails(
            new Name(scenario.getName()),
            new Category(scenario.getFeature().getName()),
            new FileSystemLocation(
                new Path(scenario.getUri()),
                scenario.getLines()[1],
            ),
        );
    }

    private scenarioDetailsOf(scenario: cucumber.events.ScenarioPayload): ScenarioDetails {
        return new ScenarioDetails(
            new Name(scenario.getName()),
            new Category(scenario.getFeature().getName()),
            new FileSystemLocation(
                new Path(scenario.getUri()),
                scenario.getLine(),
            ),
        );
    }

    private customTagsFor(scenario: cucumber.events.ScenarioPayload): Tag[] {
        return scenario.getTags()
            .map(cucumberTag => Tags.from(cucumberTag.getName()))
            .reduce(flatten, []);
    }

    private scenarioHierarchyTagsFor(scenario: cucumber.events.ScenarioPayload): Tag[] {

        const humanReadable = (text: string) => text.replace(/[_-]+/g, ' ');

        const
            separator       = '/',
            directories     = notEmpty(new Path(scenario.getFeature().getUri()).directory().value.split(separator)),
            featuresIndex   = directories.indexOf('features'),
            hierarchy       = [ ...directories.slice(featuresIndex + 1), scenario.getFeature().getName() ] as string[];

        const [ feature, capability, theme ]: string[] = hierarchy.reverse();

        return notEmpty([
            theme       && new ThemeTag(humanReadable(theme)),
            capability  && new CapabilityTag(humanReadable(capability)),
            feature     && new FeatureTag(feature),
        ]);
    }

    private activityDetailsOf(step: cucumber.events.StepPayload): ActivityDetails {
        return new ActivityDetails(this.nameOf(step));
    }

    private  nameOf(step: cucumber.events.StepPayload): Name {
        const serialise = (argument: any) => {
            // tslint:disable:switch-default  - the only possible values are DataTable and DocString
            switch (argument.getType()) {
                case 'DataTable':
                    return '\n' + argument.raw().map(row => `| ${row.join(' | ')} |`).join('\n');
                case 'DocString':
                    return `\n${ argument.getContent() }`;
            }
            // tslint:enable:switch-default
        };

        return new Name([
            step.getKeyword(),
            step.getName(),
            (step as any).getArguments().map(serialise).join('\n'),
        ].join('').trim());
    }

    private scenarioOutcomeFrom(result: cucumber.events.ScenarioResultPayload): Outcome {
        const
            status: string = result.getStatus(),
            error: Error   = this.errorFrom(result.getFailureException());

        return this.outcomeFrom(status, error);
    }

    private stepOutcomeFrom(result: cucumber.events.StepResultPayload): Outcome {
        const
            status: string                          = result.getStatus(),
            ambiguousStepsError: Error | undefined  = this.ambiguousStepsDetectedIn(result),
            error: Error | undefined                = this.errorFrom(result.getFailureException());

        return this.outcomeFrom(status, error || ambiguousStepsError);
    }

    private ambiguousStepsDetectedIn(result: cucumber.events.StepResultPayload): Error | undefined {
        const ambiguousStepDefinitions = result.getAmbiguousStepDefinitions() || [];

        if (ambiguousStepDefinitions.length === 0) {
            return void 0;
        }

        return ambiguousStepDefinitions
                .map(step => `${step.getPattern().toString()} - ${step.getUri()}:${step.getLine()}`)
                .reduce((err: Error, issue) => {
                    err.message += `\n${issue}`;
                    return err;
                }, new Error('Each step should have one matching step definition, yet there are several:'));
    }

    private errorFrom(error: Error | string | undefined): Error | undefined {
        switch (typeof error) {
            case 'string':   return new Error(error as string);
            case 'object':   return error as Error;
            case 'function': return error as Error;
            default:         return void 0;
        }
    }

    private outcomeFrom(status: string, error?: Error) {
        if (error && /timed out/.test(error.message)) {
            return new ExecutionFailedWithError(error);
        }

        // tslint:disable:switch-default
        switch (true) {
            case status === 'undefined':
                return new ImplementationPending();

            case status === 'ambiguous':
                if (! error) {
                    // Only the step result contains the "ambiguous step def error", the scenario itself doesn't
                    return new ExecutionFailedWithError(new Error('Ambiguous step definition detected'));
                }

                return new ExecutionFailedWithError(error);

            case status === 'failed':
                return new ExecutionFailedWithError(error);

            case status === 'pending':
                return new ImplementationPending();

            case status === 'passed':
                return new ExecutionSuccessful();

            case status === 'skipped':
                return new ExecutionSkipped();
        }
        // tslint:enable:switch-default
    }

    private emit(...events: DomainEvent[]) {
        events.forEach(event => this.stageManager.notifyOf(event));
    }
}