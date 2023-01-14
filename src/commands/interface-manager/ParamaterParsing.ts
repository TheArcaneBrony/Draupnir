/**
 * Copyright (C) 2022 Gnuxie <Gnuxie@protonmail.com>
 * All rights reserved.
 *
 * This file incorperates work from mjolnir
 * https://github.com/matrix-org/mjolnir
 * Which includes the following license notice:
 *
Copyright 2022 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
 *
 * However, this file is modified and the modifications in this file
 * are NOT distributed, contributed, or committed under the Apache License.
 */

import { Keyword, ReadItem, SuperCoolStream } from "./CommandReader";
import { CommandError, CommandResult } from "./Validation";

export class ArgumentStream extends SuperCoolStream<ReadItem[]> {
    public rest() {
        return this.source.slice(this.position);
    }
}

export type PredicateIsParamater = (readItem: ReadItem) => CommandResult<true>;

export interface PresentationType {
    validator: PredicateIsParamater,
    name: string,
}

const PRESENTATION_TYPES = new Map</* the name of the presentation type. */string, PresentationType>();

export function findPresentationType(name: string): PresentationType {
    const entry = PRESENTATION_TYPES.get(name);
    if (entry) {
        return entry;
    } else {
        throw new TypeError(`presentation type with the name: ${name} was not registered`);
    }
}

export function registerPresentationType(name: string, presentationType: PresentationType): void {
    if (PRESENTATION_TYPES.has(name)) {
        throw new TypeError(`presentation type with the name: ${name} has already been registered`);
    }
    PRESENTATION_TYPES.set(name, presentationType);
}

export function makePresentationType(description: PresentationType) {
    registerPresentationType(description.name, description);
    return description;
}

export function simpleTypeValidator(name: string, predicate: (readItem: ReadItem) => boolean): PredicateIsParamater {
    return (readItem: ReadItem) => {
        const result = predicate(readItem);
        if (result) {
            return CommandResult.Ok(result);
        } else {
            // How do we accurately denote the type when it includes spaces in its name, same for the read item?
            return CommandError.Result(`Was expecting a match for the presentation type: ${name} but got ${readItem}.`);
        }
    }
}

makePresentationType({
    name: "Keyword",
    validator: simpleTypeValidator("Keyword", (item: ReadItem) => item instanceof Keyword),
});

makePresentationType({
    name: 'string',
    validator: simpleTypeValidator('string', (item: ReadItem) => typeof item === 'string'),
})

interface DestructableRest {
    rest: ReadItem[],
    // Pisses me off to no end that this is how it has to work.
    [prop: string]: ReadItem|ReadItem[],
}

export class RestParser {
    public parseRest(stream: ArgumentStream): CommandResult<DestructableRest> {
        const items: ReadItem[] = [];
        while (stream.peekItem()) {
            items.push(stream.readItem());
        }
        return CommandResult.Ok({ rest: items });
    }
}

// Maybe we can get around the index type restriction by making "rest" a protected keyword?
interface KeywordsDescription {
    readonly [prop: string]: KeywordPropertyDescription|boolean;
    readonly allowOtherKeys: boolean
}

interface KeywordPropertyDescription extends ParamaterDescription {
    readonly isFlag: boolean;
}

// Things that are also needed that are not done yet:
// 1) We need to figure out what happens to aliases for keywords..
// 2) We need to sort out the predicates thing.
export class KeywordParser extends RestParser {
    constructor(public readonly description: KeywordsDescription) {
        super();
    }

    /**
     * TODO: Prototype pollution must be part of integration tests for this
     * @param itemStream stream of arguments.
     */
    public parseRest(itemStream: ArgumentStream): CommandResult<DestructableRest> {
        const destructable: DestructableRest = { rest: [] };
        while (itemStream.peekItem() !== undefined) {
            const item = itemStream.readItem();
            if (item instanceof Keyword) {
                const description = this.description[item.designator];
                if (typeof description === 'boolean') {
                    throw new TypeError("Shouldn't be a boolean mate");
                }
                const associatedProperty: CommandResult<any> = (() => {
                    if (itemStream.peekItem() !== undefined && !(itemStream.peekItem() instanceof Keyword)) {
                        const property = itemStream.readItem();
                        return CommandResult.Ok(property);
                    } else {
                        if (!description.isFlag) {
                            return ArgumentParseError.Result(`An associated argument was not provided for the keyword ${description.name}.`, { paramater: description, stream: itemStream })
                        }
                        return CommandResult.Ok(true);
                    }
                })();
                if (associatedProperty.isErr()) {
                    return CommandResult.Err(associatedProperty.err);
                }
                destructable[description.name] = associatedProperty.ok;

            } else {
                destructable.rest.push(item);
            }
        }
        return CommandResult.Ok(destructable);
    }
}

export interface ParsedArguments {
    readonly immediateArguments: ReadItem[],
    readonly rest?: DestructableRest,
}

export interface ParamaterDescription {
    name: string,
    description?: string,
    acceptor: PresentationType,
}

export type ParamaterParser = (...readItems: ReadItem[]) => CommandResult<ParsedArguments>;

// So this should really just be something used by defineInterfaceCommand which turns paramaters into a validator that can be used.
// It can't be, because then otherwise how does the semantics for union work?
// We should have a new type of CommandResult that accepts a ParamterDescription, and can render what's wrong (e.g. missing paramater).
// Showing where in the item stream it is missing and the command syntax and everything lovely like that.
// How does that work with Union?
export function paramaters(descriptions: ParamaterDescription[], restParser: undefined|RestParser = undefined): IArgumentListParser {
    return new ArgumentListParser(descriptions, restParser);
}

export interface IArgumentListParser {
    readonly parseFunction: ParamaterParser,
    readonly descriptions: ParamaterDescription[],
    readonly restParser?: RestParser,
}

/**
 * Zis is le argument list parser
 * It is used directly by InterfaceCommand to consume, parse, validate le arguments.
 */
class ArgumentListParser implements IArgumentListParser {
    public readonly parseFunction: ParamaterParser
    constructor(
        public readonly descriptions: ParamaterDescription[],
        public readonly restParser: undefined|RestParser = undefined,
        ) {
            this.parseFunction = this.makeParseFunction(descriptions, restParser);
    }

    private makeParseFunction(descriptions: ParamaterDescription[], restParser: undefined|RestParser): ParamaterParser {
        return (...readItems: ReadItem[]) => {
            const itemStream = new ArgumentStream(readItems);
            for (const paramater of descriptions) {
                if (itemStream.peekItem() === undefined) {
                    return ArgumentParseError.Result(`An argument for the paramater ${paramater.name} was expected but was not provided.`, { paramater, stream: itemStream });
                }
                const result = paramater.acceptor.validator(itemStream.peekItem());
                if (result.err) {
                    // should really allow the help to be printed later on and keep the whole context?
                    return ArgumentParseError.Result(result.err.message, { paramater, stream: itemStream });
                }
                itemStream.readItem();
            }
            if (restParser) {
                const result = restParser.parseRest(itemStream);
                if (result.isErr()) {
                    return CommandResult.Err(result.err);
                }
                return CommandResult.Ok({ immediateArguments: readItems, rest: result.ok });
            } else {
                return CommandResult.Ok({ immediateArguments: readItems });
            }
        }
    }
}

export class ArgumentParseError extends CommandError {
    constructor(
        public readonly paramater: ParamaterDescription,
        public readonly stream: ArgumentStream,
        message: string) {
        super(message)
    }

    public static Result<Ok>(message: string, options: { paramater: ParamaterDescription, stream: ArgumentStream }): CommandResult<Ok, ArgumentParseError> {
        return CommandResult.Err(new ArgumentParseError(options.paramater, options.stream, message));
    }
}

/**
 * I don't think we should use `union` and it should be replaced by a presentationTypeTranslator
 * these are specific to applications e.g. imagine you want to resolve an alias or something.
 * It oculd also work by making an anonymous presentation type, but dunno about that.
 */
export function union(...predicates: PredicateIsParamater[]): PredicateIsParamater {
    return (item: ReadItem) => {
        const matches = predicates.map(predicate => predicate(item));
        const oks = matches.filter(result => result.isOk());
        if (oks.length > 0) {
            return CommandResult.Ok(true);
        } else {
            // FIXME asap: again, we need some context as to what the argument is?
            return CommandError.Result(`The argument must match the paramater description ${matches}`);
        }
    }
}