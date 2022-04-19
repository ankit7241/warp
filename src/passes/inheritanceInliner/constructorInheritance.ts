import assert from 'assert';
import {
  ContractDefinition,
  Expression,
  ExpressionStatement,
  FunctionDefinition,
  FunctionKind,
  FunctionStateMutability,
  FunctionVisibility,
  Statement,
  VariableDeclaration,
  VariableDeclarationStatement,
} from 'solc-typed-ast';
import { AST } from '../../ast/ast';
import { cloneASTNode } from '../../utils/cloning';
import { generateFunctionCall } from '../../utils/functionGeneration';
import { createBlock, createIdentifier, createParameterList } from '../../utils/nodeTemplates';
import { updateReferencedDeclarations } from './utils';

let count = 0;

export function solveConstructorInheritance(node: ContractDefinition, ast: AST) {
  // Contracts marked as abstract won't be deployed
  if (node.abstract) return;

  // Collect all constructors
  const constructors: Map<number, FunctionDefinition> = new Map();
  node.vLinearizedBaseContracts.forEach((contract) => {
    const constructorFunc = contract.vConstructor;
    if (constructorFunc !== undefined) constructors.set(contract.id, constructorFunc);
  });

  // Collect arguments passed to constructors of linearized contracts
  const statements: Statement[] = [];
  const args: Map<number, Expression[]> = new Map();
  const mappedVars: Map<number, VariableDeclaration> = new Map();

  const selfConstructor = generateFunctionForConstructor(node, mappedVars, ast);
  node.vLinearizedBaseContracts.forEach((contract) => {
    const constructorFunc = constructors.get(contract.id);
    collectArguments(
      contract,
      constructorFunc,
      constructors,
      args,
      mappedVars,
      statements,
      selfConstructor.id,
      ast,
    );
  });

  // Create calls to constructor functions:
  // Constructors must be called in the order of linearized contracts,
  // from the "most base-like" to the "most derived"
  node.linearizedBaseContracts
    .slice(1)
    .reverse()
    .forEach((contractId) => {
      const constructorFunc = constructors.get(contractId);
      if (constructorFunc !== undefined) {
        const newFunc = createFunctionFromConstructor(constructorFunc, node, ast);
        node.appendChild(newFunc);

        const argList = args.get(contractId) ?? [];
        assert(
          constructorFunc.vParameters.vParameters.length === argList.length,
          `Wrong number of arguments in constructor`,
        );

        const stmt = new ExpressionStatement(
          ast.reserveId(),
          '',
          generateFunctionCall(newFunc, argList, ast),
        );
        statements.push(stmt);
      }
    });

  // Change the constructor of this contract into a regular function to be called from `selfConstructor`
  transformConstructor(node, selfConstructor, statements, ast);

  // Add generated function calls to the body of this contract's constructor
  if (statements.length > 0) {
    generateBody(statements, selfConstructor, ast);
    ast.setContextRecursive(selfConstructor);
    node.appendChild(selfConstructor);
  }
}

// Arguments to constructors can be passed either directly (in the inheritance specifiers)
// or indirectly (as modifier invocations of the constructor function of a derived contract),
// both ways are not allowed.
function collectArguments(
  contract: ContractDefinition,
  constructorFunc: FunctionDefinition | undefined,
  constructors: Map<number, FunctionDefinition>,
  args: Map<number, Expression[]>,
  idRemapping: Map<number, VariableDeclaration>,
  statements: Statement[],
  scope: number,
  ast: AST,
) {
  contract.vInheritanceSpecifiers.forEach((specifier) => {
    const contractId = specifier.vBaseType.referencedDeclaration;
    const constructor = constructors.get(contractId);
    const size = specifier.vArguments.length;
    if (size > 0) {
      assert(
        constructor !== undefined && constructor.vParameters.vParameters.length === size,
        'Wrong number of arguments in constructor',
      );
      const argList = getArguments(
        specifier.vArguments,
        constructor.vParameters.vParameters,
        idRemapping,
        statements,
        scope,
        ast,
      );
      args.set(contractId, argList);
    }
  });

  if (constructorFunc !== undefined) {
    constructorFunc.vModifiers.forEach((modInvocation) => {
      const contractDef = modInvocation.vModifier;
      if (contractDef instanceof ContractDefinition) {
        const constructor = constructors.get(contractDef.id);
        const size = modInvocation.vArguments.length;
        if (size > 0) {
          assert(
            constructor !== undefined && constructor.vParameters.vParameters.length === size,
            'Wrong number of arguments in constructor',
          );
          const argList = getArguments(
            modInvocation.vArguments,
            constructor.vParameters.vParameters,
            idRemapping,
            statements,
            scope,
            ast,
          );
          args.set(contractDef.id, argList);
        }
      }
    });
  }
}

function getArguments(
  args: Expression[],
  parameters: VariableDeclaration[],
  idRemapping: Map<number, VariableDeclaration>,
  statements: Statement[],
  scope: number,
  ast: AST,
): Expression[] {
  const size = args.length;
  const argList: Expression[] = [];
  for (let i = 0; i < size; ++i) {
    const newArg = cloneASTNode(args[i], ast);
    updateReferencedDeclarations(newArg, idRemapping, ast);
    const newVar = cloneASTNode(parameters[i], ast);
    newVar.name = `__warp_constructor_parameter_${count++}`;
    newVar.scope = scope;

    idRemapping.set(parameters[i].id, newVar);
    argList.push(createIdentifier(newVar, ast));
    statements.push(
      new VariableDeclarationStatement(ast.reserveId(), '', [newVar.id], [newVar], newArg),
    );
  }
  return argList;
}

function createFunctionFromConstructor(
  constructorFunc: FunctionDefinition,
  node: ContractDefinition,
  ast: AST,
): FunctionDefinition {
  const newFunc = cloneASTNode(constructorFunc, ast);
  newFunc.kind = FunctionKind.Function;
  newFunc.name = `__warp_constructor_${count++}`;
  newFunc.visibility = FunctionVisibility.Private;
  newFunc.isConstructor = false;
  newFunc.scope = node.id;
  ast.setContextRecursive(newFunc);

  return newFunc;
}

function createDefaultConstructor(node: ContractDefinition, ast: AST): FunctionDefinition {
  const newFunc = new FunctionDefinition(
    ast.reserveId(),
    '',
    node.id,
    FunctionKind.Constructor,
    '',
    false,
    FunctionVisibility.Public,
    FunctionStateMutability.NonPayable,
    true,
    createParameterList([], ast),
    createParameterList([], ast),
    [],
  );
  return newFunc;
}

function generateBody(statements: Statement[], constructorFunc: FunctionDefinition, ast: AST) {
  const newBody = createBlock(statements, ast);
  constructorFunc.vBody = newBody;
  ast.registerChild(newBody, constructorFunc);
}

function generateFunctionForConstructor(
  node: ContractDefinition,
  idRemapping: Map<number, VariableDeclaration>,
  ast: AST,
): FunctionDefinition {
  const newFunc = createDefaultConstructor(node, ast);
  const currentConstructor = node.vConstructor;
  if (currentConstructor !== undefined) {
    const parameters = currentConstructor.vParameters.vParameters.map((v) => {
      const newV = cloneASTNode(v, ast);
      newV.scope = newFunc.id;
      idRemapping.set(v.id, newV);
      return newV;
    });
    const retParameters = currentConstructor.vReturnParameters.vParameters.map((v) => {
      const newV = cloneASTNode(v, ast);
      newV.scope = newFunc.id;
      idRemapping.set(v.id, newV);
      return newV;
    });
    newFunc.vParameters = createParameterList(parameters, ast);
    newFunc.vReturnParameters = createParameterList(retParameters, ast);
    newFunc.acceptChildren();
  }
  return newFunc;
}

function transformConstructor(
  node: ContractDefinition,
  newConstructor: FunctionDefinition,
  statements: Statement[],
  ast: AST,
) {
  const currentCons = node.vConstructor;
  if (currentCons === undefined) return;

  currentCons.kind = FunctionKind.Function;
  currentCons.name = `__warp_constructor_${count++}`;
  currentCons.visibility = FunctionVisibility.Private;
  currentCons.isConstructor = false;

  const argList = newConstructor.vParameters.vParameters.map((v) => {
    return createIdentifier(v, ast);
  });
  statements.push(
    new ExpressionStatement(ast.reserveId(), '', generateFunctionCall(currentCons, argList, ast)),
  );
}
