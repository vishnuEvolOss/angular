/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import ts from 'typescript';

import {ImportedSymbolsTracker} from '../../../imports';
import {ClassMember, ReflectionHost} from '../../../reflection';

/**
 * @fileoverview
 *
 * Angular exposes functions that can be used as class member initializers
 * to make use of various APIs. Those are called initializer APIs.
 *
 * Signal-based inputs are relying on initializer APIs because such inputs
 * are declared using `input` and `input.required` intersection functions.
 * Similarly, signal-based queries follow the same pattern and are also
 * declared through initializer APIs.
 */

export interface InitializerApiFunction {
  owningModule: '@angular/core'|'@angular/core/rxjs-interop';
  functionName: ('input'|'model'|'ɵoutput'|'output'|'outputFromObservable'|'viewChild'|
                 'viewChildren'|'contentChild'|'contentChildren');
}

/**
 * Metadata describing an Angular class member that was recognized through
 * a function initializer. Like `input`, `input.required` or `viewChild`.
 */
interface InitializerFunctionMetadata {
  /** Initializer API function that was recognized. */
  api: InitializerApiFunction;
  /** Node referring to the call expression. */
  call: ts.CallExpression;
  /** Whether the initializer is required or not. E.g. `input.required` was used. */
  isRequired: boolean;
}

/**
 * Metadata that can be inferred from an initializer
 * statically without going through the type checker.
 */
interface StaticInitializerData {
  /** Initializer-function API that was matched. */
  api: InitializerApiFunction;

  /** Identifier in the initializer that refers to the Angular API. */
  apiReference: ts.Identifier;

  /** Whether the call is required. */
  isRequired: boolean;
}

/**
 * Attempts to identify an Angular class member that is declared via
 * its initializer referring to a given initializer API function.
 *
 * Note that multiple possible initializer API function names can be specified,
 * allowing for checking multiple types in one pass.
 */
export function tryParseInitializerApiMember<Functions extends InitializerApiFunction[]>(
    functions: Functions, member: Pick<ClassMember, 'value'>, reflector: ReflectionHost,
    importTracker: ImportedSymbolsTracker): (InitializerFunctionMetadata&{api: Functions[number]}|
                                             null) {
  if (member.value === null || !ts.isCallExpression(member.value)) {
    return null;
  }

  const call = member.value;
  const staticResult = parseTopLevelCall(call, functions, importTracker) ||
      parseTopLevelRequiredCall(call, functions, importTracker) ||
      parseTopLevelCallFromNamespace(call, functions, importTracker);

  if (staticResult === null) {
    return null;
  }

  // Once we've statically determined that the initializer is one of the APIs we're looking for, we
  // need to verify it using the type checker which accounts for things like shadowed variables.
  // This should be done as the absolute last step since using the type check can be expensive.
  const resolvedImport = reflector.getImportOfIdentifier(staticResult.apiReference);
  if (resolvedImport === null || staticResult.api.functionName !== resolvedImport.name ||
      staticResult.api.owningModule !== resolvedImport.from) {
    return null;
  }

  return {
    api: staticResult.api,
    call,
    isRequired: staticResult.isRequired,
  };
}

/**
 * Attempts to parse a top-level call to an initializer function,
 * e.g. `prop = input()`. Returns null if it can't be parsed.
 */
function parseTopLevelCall(
    call: ts.CallExpression, functions: InitializerApiFunction[],
    importTracker: ImportedSymbolsTracker): StaticInitializerData|null {
  const node = call.expression;

  if (!ts.isIdentifier(node)) {
    return null;
  }

  const matchingApi = functions.find(
      fn =>
          importTracker.isPotentialReferenceToNamedImport(node, fn.functionName, fn.owningModule));
  if (matchingApi === undefined) {
    return null;
  }

  return {api: matchingApi, apiReference: node, isRequired: false};
}

/**
 * Attempts to parse a top-level call to a required initializer,
 * e.g. `prop = input.required()`. Returns null if it can't be parsed.
 */
function parseTopLevelRequiredCall(
    call: ts.CallExpression, functions: InitializerApiFunction[],
    importTracker: ImportedSymbolsTracker): StaticInitializerData|null {
  const node = call.expression;

  if (!ts.isPropertyAccessExpression(node) || !ts.isIdentifier(node.expression) ||
      node.name.text !== 'required') {
    return null;
  }

  const expression = node.expression;
  const matchingApi = functions.find(
      fn => importTracker.isPotentialReferenceToNamedImport(
          expression, fn.functionName, fn.owningModule));
  if (matchingApi === undefined) {
    return null;
  }

  return {api: matchingApi, apiReference: expression, isRequired: true};
}


/**
 * Attempts to parse a top-level call to a function referenced via a namespace import,
 * e.g. `prop = core.input.required()`. Returns null if it can't be parsed.
 */
function parseTopLevelCallFromNamespace(
    call: ts.CallExpression, functions: InitializerApiFunction[],
    importTracker: ImportedSymbolsTracker): StaticInitializerData|null {
  const node = call.expression;

  if (!ts.isPropertyAccessExpression(node)) {
    return null;
  }

  let apiReference: ts.Identifier|null = null;
  let matchingApi: InitializerApiFunction|undefined = undefined;
  let isRequired = false;

  // `prop = core.input()`
  if (ts.isIdentifier(node.expression) && ts.isIdentifier(node.name)) {
    const namespaceRef = node.expression;

    apiReference = node.name;
    matchingApi = functions.find(
        fn => node.name.text === fn.functionName &&
            importTracker.isPotentialReferenceToNamespaceImport(namespaceRef, fn.owningModule));
  } else if (
      // `prop = core.input.required()`
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) && ts.isIdentifier(node.expression.name) &&
      node.name.text === 'required') {
    const potentialName = node.expression.name.text;
    const namespaceRef = node.expression.expression;

    apiReference = node.expression.name;
    matchingApi = functions.find(
        fn => fn.functionName === potentialName &&
            importTracker.isPotentialReferenceToNamespaceImport(namespaceRef!, fn.owningModule));
    isRequired = true;
  }

  if (matchingApi === undefined || apiReference === null) {
    return null;
  }

  return {api: matchingApi, apiReference, isRequired};
}
