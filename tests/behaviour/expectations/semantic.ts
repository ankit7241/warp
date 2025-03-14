import { readFileSync } from 'fs';
import AbiCoder from 'web3-eth-abi';
import {
  AddressType,
  ArrayType,
  BoolType,
  BuiltinStructType,
  BuiltinType,
  BytesType,
  FixedBytesType,
  FunctionType,
  IntType,
  MappingType,
  PointerType,
  StringType,
  TypeNode,
  UserDefinedType,
  ContractDefinition,
  FunctionDefinition,
  VariableDeclaration,
  compileSol,
  resolveAny,
  CompileResult,
  UserDefinedValueTypeDefinition,
  StructDefinition,
  EnumDefinition,
  InferType,
} from 'solc-typed-ast';
import { ABIEncoderVersion } from 'solc-typed-ast/dist/types/abi';
import * as path from 'path';
import tests from '../testCalldata';
import { InvalidTestError } from '../errors';

import whiteList from './semanticWhitelist';

import whileListGenerated from './semanticTestsGenerated';

import { NotSupportedYetError } from '../../../src/utils/errors';
import { compileSolFiles, compileSolFilesAndExtractContracts } from '../../../src/solCompile';
import { printTypeNode } from '../../../src/utils/astPrinter';
import { toUintOrFelt } from '../../../src/utils/utils';
import { AsyncTest, Expect } from './types';
import { error } from '../../../src/utils/formatting';
import { notNull } from '../../../src/utils/typeConstructs';
import assert from 'assert';
import { AST } from '../../../src/ast/ast';
import { createDefaultConstructor } from '../../../src/utils/nodeTemplates';
import { safeGetNodeType } from '../../../src/utils/nodeTypeProcessing';
import { encodeString } from './utils';

// this format will cause problems with overloading
export interface Parameter {
  type: string;
  name: string;
  components?: Parameter[];
}

interface FunABI {
  name: string;
  inputs: Parameter[];
  outputs: Parameter[];
}

export interface ITestCalldata {
  callData: string;
  expectations: string;
  failure: boolean;
  signature: string;
  expectedSideEffects?: string[];
}

type SolValue = string | SolValue[] | { [key: string]: SolValue };

//@ts-ignore: web3-eth-abi has their exports wrong
const abiCoder: AbiCoder = new AbiCoder.constructor();

// ----------------------- Gather all the tests ------------------------------
// This could benefit from some parallelism
function isValidTestName(testFileName: string) {
  let file = testFileName;
  while (file !== '.' && file !== '/') {
    if (whiteList.includes(file) || whileListGenerated.includes(file)) return true;
    file = path.dirname(file);
  }
  return false;
}
// This needs to be a reduce instead of filter because of the type system
const validTests = Object.entries(tests).reduce(
  (tests: [string, ITestCalldata[]][], [f, v]) =>
    v !== null && isValidTestName(f) ? tests.concat([[f, v]]) : tests,
  [],
);

// ------------------------ Export the tests ---------------------------------

// solc-typed-ast downloads compilers on demand, running a single compilation fully
// before the others ensures that the compiler is set up properly before being used
// asynchronously
const initialRun: Promise<CompileResult> =
  validTests.length > 0
    ? compileSol(validTests[0][0], 'auto')
    : Promise.resolve({
        data: null,
        files: new Map(),
        inferredRemappings: new Map(),
        resolvedFileNames: new Map(),
      });

export const expectations: AsyncTest[] = validTests.map(([file, tests]): AsyncTest => {
  try {
    // The solidity test dsl assumes the last contract defined in the file is
    // the target of the function calls. solc-typed-ast sorts the contracts
    // so we need to do a dumb regex to find the right contract
    const contractNames = [
      ...readFileSync(file, 'utf-8')
        .split('\n')
        .map((line) => {
          const commentStart = line.indexOf('//');
          if (commentStart === -1) return line;
          return line.slice(0, commentStart);
        })
        .join('\n')
        .matchAll(/contract (\w+)/g),
    ].map(([_, name]) => name);
    const lastContract = contractNames[contractNames.length - 1];
    const truncatedFileName = file.substring(0, file.length - '.sol'.length);

    const contractAbiDefAst = getContractAbiAndDefinition(file, lastContract);

    // Encode constructor arguments
    const constructorArgs: Promise<string[]> = encodeConstructors(tests[0], contractAbiDefAst);

    return new AsyncTest(
      truncatedFileName,
      lastContract,
      constructorArgs,
      transcodeTests(tests, contractAbiDefAst),
    );
  } catch (e) {
    return new AsyncTest(file, '', [], [], `${e}`);
  }
});

// ------------------------ Transcode the tests ------------------------------

async function transcodeTests(
  expectations: ITestCalldata[],
  contractAbiDefAst: Promise<[FunABI[], ContractDefinition, AST]>,
): Promise<Expect[]> {
  await initialRun;

  const [abi, contractDef, ast] = await contractAbiDefAst;

  const inference = ast.inference;
  // Transcode each test
  return expectations
    .map((test) => {
      try {
        return transcodeTest(abi, contractDef, test, inference, ast);
      } catch (e) {
        console.log(error(`Failed to transcode ${test.signature}: ${e}`));
        throw e;
      }
    })
    .filter(notNull);
}

function transcodeTest(
  abi: FunABI[],
  contractDef: ContractDefinition,
  { signature, callData, expectations, failure }: ITestCalldata,
  inference: InferType,
  ast: AST,
): Expect | null {
  if (signature === '' || signature === '()') {
    throw new InvalidTestError('Fallback functions are not supported');
  }
  if (signature.startsWith('constructor(') && !failure) {
    // Valid constructor tests will already have been transcoded by encodeConstructors
    return null;
  }

  const [functionName] = signature.split('(');

  // Find the function definition in the ast
  const [funcAbi, funcDef] = getFunctionAbiAndDefinition(
    functionName,
    abi,
    contractDef,
    ast,
    signature,
    inference,
  );

  const inputTypeNodes =
    funcDef instanceof FunctionDefinition
      ? funcDef.vParameters.vParameters.map((cd) => safeGetNodeType(cd, inference))
      : inference.getterFunType(funcDef).parameters;
  const outputTypeNodes =
    funcDef instanceof FunctionDefinition
      ? funcDef.vReturnParameters.vParameters.map((cd) => safeGetNodeType(cd, inference))
      : inference.getterFunType(funcDef).returns;

  let removePrefix = 10;
  if (signature.startsWith('constructor(')) {
    removePrefix = 2;
    funcAbi.outputs = [];
  }

  const input = encode(
    funcAbi.inputs,
    inputTypeNodes,
    '0x' + callData.substring(removePrefix),
    inference,
  );

  const output = failure ? null : encode(funcAbi.outputs, outputTypeNodes, expectations, inference);

  const functionHash = inference.signatureHash(funcDef, ABIEncoderVersion.V2);

  return Expect.Simple(`${functionName}_${functionHash}`, input, output);
}

function encode(
  abi: Parameter[],
  typeNodes: TypeNode[],
  encodedData: string,
  inference: InferType,
): string[] {
  const inputs_ = abiCoder.decodeParameters(abi, encodedData);
  return (
    Object.entries(inputs_)
      // output of parameter decodes encodes parameters in an object with
      // each enty duplicated, one with their parameter name the other as a
      // simple index into the parameter list. Here we filter for those indexes
      .filter(([key, _]) => !isNaN(parseInt(key)))
      // borked types from import, see above
      .map(([_, val]) => val as SolValue)
      .flatMap((v: SolValue, i) => encodeValue(typeNodes[i], v, inference))
  );
}

// ------------------- Encode solidity values as cairo values ----------------

export function encodeValue(tp: TypeNode, value: SolValue, inference: InferType): string[] {
  if (tp instanceof IntType) {
    return encodeAsUintOrFelt(tp, value, tp.nBits);
  } else if (tp instanceof ArrayType) {
    if (!(value instanceof Array)) {
      throw new Error(`Can't encode ${value} as arrayType`);
    }
    if (tp.size === undefined) {
      return [
        value.length.toString(),
        ...value.flatMap((v) => encodeValue(tp.elementT, v, inference)),
      ];
    } else {
      return value.flatMap((v) => encodeValue(tp.elementT, v, inference));
    }
  } else if (tp instanceof BoolType) {
    if (typeof value !== 'boolean') {
      throw new Error(`Can't encode ${value} as boolType`);
    }
    return [value ? '1' : '0'];
  } else if (tp instanceof BytesType) {
    if (value === null) return ['0'];
    if (typeof value !== 'string') {
      throw new Error(`Can't encode ${value} as bytesType`);
    }
    // removing 0x
    value = value.substring(2);
    const length = value.length / 2;
    assert(length === Math.floor(length), 'bytes must be even');

    const cairoBytes: string[] = [];
    for (let index = 0; index < value.length; index += 2) {
      const byte = value.substring(index, index + 2);
      cairoBytes.push(BigInt('0x' + byte).toString());
    }
    return [length.toString(), cairoBytes].flat();
  } else if (tp instanceof FixedBytesType) {
    return encodeAsUintOrFelt(tp, value, tp.size * 8);
  } else if (tp instanceof StringType) {
    if (typeof value !== 'string') {
      throw new Error(`Can't encode ${value} as stringType`);
    }
    return encodeString(value);
  } else if (tp instanceof AddressType) {
    return encodeAsUintOrFelt(tp, value, 160);
  } else if (tp instanceof BuiltinType) {
    throw new NotSupportedYetError('Serialising BuiltinType not supported yet');
  } else if (tp instanceof BuiltinStructType) {
    throw new NotSupportedYetError('Serialising BuiltinStructType not supported yet');
  } else if (tp instanceof MappingType) {
    throw new Error('Mappings cannot be serialised as external function parameters');
  } else if (tp instanceof UserDefinedType) {
    const definition = tp.definition;
    if (definition instanceof UserDefinedValueTypeDefinition) {
      return encodeValue(safeGetNodeType(definition.underlyingType, inference), value, inference);
    } else if (definition instanceof StructDefinition) {
      if (!(value instanceof Array)) {
        throw new Error(`Can't encode ${value} as structType`);
      }
      const membersEncoding: string[][] = [];
      for (let index = 0; index < value.length; index++) {
        const memberTypeNode = safeGetNodeType(definition.vMembers[index], inference);
        const memberValue = value[index];
        membersEncoding.push(encodeValue(memberTypeNode, memberValue, inference));
      }
      return membersEncoding.flat();
    } else if (definition instanceof EnumDefinition) {
      return encodeAsUintOrFelt(tp, value, 8);
    } else if (definition instanceof ContractDefinition) {
      return encodeAsUintOrFelt(tp, value, 160);
    }
  } else if (tp instanceof FunctionType) {
    throw new NotSupportedYetError('Serialising FunctionType not supported yet');
  } else if (tp instanceof PointerType) {
    return encodeValue(tp.to, value, inference);
  }
  throw new Error(`Don't know how to convert type ${printTypeNode(tp)}`);
}

// ------------------------------ utils --------------------------------------

function getSignature(abi: FunABI): string {
  return `${abi.name || 'constructor'}(${abi.inputs.map(formatSigType).join(',')})`;
}

function formatSigType(type: Parameter): string {
  return type.components === undefined
    ? type.type
    : type.type.replace('tuple', '(' + type.components.map(formatSigType).join(',') + ')');
}

export function encodeAsUintOrFelt(tp: TypeNode, value: SolValue, nBits: number): string[] {
  if (typeof value !== 'string') {
    throw new Error(`Can't encode ${value} as ${printTypeNode(tp)}`);
  }
  try {
    return toUintOrFelt(BigInt(value.toString()), nBits).map((x) => x.toString());
  } catch {
    throw new Error(`Can't encode ${value} as ${printTypeNode(tp)}`);
  }
}

async function encodeConstructors(
  firstTest: ITestCalldata,
  contractAbiDefAST: Promise<[FunABI[], ContractDefinition, AST]>,
): Promise<string[]> {
  const [contractAbi, contractDef, ast] = await contractAbiDefAST;

  let constructorArgs: string[] = [];

  const constructorSignature = contractAbi
    .map(getSignature)
    .find((sig) => sig.startsWith('constructor('));

  if (firstTest.signature.startsWith('constructor(')) {
    let signature: string = firstTest.signature;
    if (constructorSignature !== firstTest.signature && constructorSignature !== undefined) {
      // If constructor Signature from AST does not match the constructor test signature in test_calldata.ts
      // then we get the signature from the contract ABI (generated from solc )
      // for e.g tests/behaviour/solidity/test/libsolidity/semanticTests/array/constant_var_as_array_length.sol
      console.warn(
        `WARNING: constructor signature mismatch: ${firstTest.signature} vs ${constructorSignature} in test_calldata and contract ${ast.roots[0].absolutePath} respectively`,
      );
      signature = constructorSignature;
    }
    const [constrAbi, constrDef] = getFunctionAbiAndDefinition(
      'constructor',
      contractAbi,
      contractDef,
      ast,
      signature,
      ast.inference,
    );
    assert(
      constrDef instanceof FunctionDefinition,
      'Constructor must be of type functionDefinition',
    );
    const typeNodes = constrDef.vParameters.vParameters.map((cd) =>
      safeGetNodeType(cd, ast.inference),
    );
    constructorArgs = encode(constrAbi.inputs, typeNodes, firstTest.callData, ast.inference);
  }

  return constructorArgs;
}

async function getContractAbiAndDefinition(
  file: string,
  lastContractName: string,
): Promise<[FunABI[], ContractDefinition, AST]> {
  // Get the abi of the contract for web3
  const contracts: any = compileSolFilesAndExtractContracts(file);
  const lastContract = contracts[lastContractName];
  if (lastContract === undefined) {
    throw new InvalidTestError(`Unable to find contract ${lastContractName} in file ${file}`);
  }
  const contractAbi = lastContract.abi;

  // Get the ast itself so we can resolve the types for our type conversion
  // later
  const ast = compileSolFiles([file], { warnings: false });
  const astRoot = ast.roots[ast.roots.length - 1];
  const [contractDef] = astRoot
    .getChildrenByType(ContractDefinition, true)
    .filter((contract) => contract.name === lastContractName);

  return [contractAbi, contractDef, ast];
}

function getFunctionAbiAndDefinition(
  functionName: string,
  abi: FunABI[],
  contractDef: ContractDefinition,
  ast: AST,
  signature: string,
  inference: InferType,
): [FunABI, FunctionDefinition | VariableDeclaration] {
  let defs: (FunctionDefinition | VariableDeclaration)[];
  if (functionName !== 'constructor') {
    defs = Array.from(resolveAny(functionName, contractDef, inference, true)).filter((def) => {
      if (def instanceof FunctionDefinition || def instanceof VariableDeclaration) {
        return inference.signature(def, ABIEncoderVersion.V2) === signature;
      }
      return false;
    }) as (FunctionDefinition | VariableDeclaration)[];
  } else {
    if (contractDef.vConstructor === undefined) {
      // Need to create a default constructor and its abi
      abi = [{ name: '', inputs: [], outputs: [] }];
      defs = [createDefaultConstructor(contractDef, ast)];
    } else {
      defs = [contractDef.vConstructor];
    }
  }

  if (defs.length === 0) {
    throw new InvalidTestError(
      `No function definition found for test case ${signature} in the ast.\n` +
        `Defined functions:\n` +
        `\t${defs.map((d) => {
          if (d instanceof FunctionDefinition || d instanceof VariableDeclaration) {
            return inference.signature(d, ABIEncoderVersion.V2);
          }
          return `Unknown def ${d}`;
        })}`,
    );
  }
  if (defs.length > 1) {
    throw new InvalidTestError(
      `Multiple function definitions found for test case ${signature} in the ast.` +
        `Defined functions:\n` +
        `\t${defs}`,
    );
  }

  // Find the function definition in the abi
  const funcAbis = abi.filter((funAbi) => getSignature(funAbi) === signature);
  if (funcAbis.length === 0) {
    throw new InvalidTestError(
      `No function definition found for test case ${signature} in web3 abi\n` +
        `Defined functions:\n` +
        `\t${abi.map((v) => getSignature(v))}`,
    );
  }
  if (funcAbis.length > 1) {
    throw new InvalidTestError(
      `Multiple function definitions found for test case ${signature}\n` +
        `Defined functions:\n` +
        `\t${abi.map((v) => getSignature(v))}`,
    );
  }

  const [funcDef] = defs;
  const [funcAbi] = funcAbis;

  return [funcAbi, funcDef];
}
