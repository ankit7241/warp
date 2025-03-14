import {
  FixedBytesType,
  generalizeType,
  TypeName,
  IndexAccess,
  Literal,
  IntType,
  TypeNode,
} from 'solc-typed-ast';
import { AST } from '../../ast/ast';
import { ASTMapper } from '../../ast/mapper';
import { createCallToFunction } from '../../utils/functionGeneration';
import { generateExpressionTypeString } from '../../utils/getTypeString';
import { typeNameFromTypeNode } from '../../utils/utils';
import {
  createNumberLiteral,
  createUint8TypeName,
  createUint256TypeName,
} from '../../utils/nodeTemplates';
import { safeGetNodeType } from '../../utils/nodeTypeProcessing';
import { replaceBytesType } from './utils';

export class ReplaceIndexAccessBytesConverter extends ASTMapper {
  visitIndexAccess(node: IndexAccess, ast: AST): void {
    const baseNodeType = safeGetNodeType(node.vBaseExpression, ast.inference);
    const baseExprType = generalizeType(baseNodeType)[0];
    if (node.vIndexExpression === undefined || !(baseExprType instanceof FixedBytesType)) {
      this.visitExpression(node, ast);
      return;
    }
    const baseTypeName = typeNameFromTypeNode(baseNodeType, ast);

    const indexNodeType = safeGetNodeType(node.vIndexExpression, ast.inference);
    const indexTypeName =
      node.vIndexExpression instanceof Literal
        ? createUint256TypeName(ast)
        : typeNameFromTypeNode(indexNodeType, ast);

    const stubParams: [string, TypeName][] = [
      ['base', baseTypeName],
      ['index', indexTypeName],
    ];
    const callArgs = [node.vBaseExpression, node.vIndexExpression];
    if (baseExprType.size !== 32) {
      stubParams.push(['width', createUint8TypeName(ast)]);
      callArgs.push(createNumberLiteral(baseExprType.size, ast, 'uint8'));
    }

    const importedFunc = ast.registerImport(
      node,
      'warplib.maths.bytes_access',
      selectWarplibFunction(baseExprType, indexNodeType),
      stubParams,
      [['res', createUint8TypeName(ast)]],
    );

    const call = createCallToFunction(importedFunc, callArgs, ast);
    ast.replaceNode(node, call, node.parent);
    const callNodeType = replaceBytesType(safeGetNodeType(call, ast.inference));
    call.typeString = generateExpressionTypeString(callNodeType);
    this.commonVisit(call, ast);
  }
}

function selectWarplibFunction(baseType: TypeNode, indexType: TypeNode): string {
  const isIndexUint256 =
    indexType instanceof IntType && indexType.signed === false && indexType.nBits === 256;
  const isBaseBytes32 = baseType instanceof FixedBytesType && baseType.size === 32;

  if (isIndexUint256 && isBaseBytes32) {
    return 'byte256_at_index_uint256';
  }
  if (isIndexUint256) {
    return 'byte_at_index_uint256';
  }
  if (isBaseBytes32) {
    return 'byte256_at_index';
  }
  return 'byte_at_index';
}
