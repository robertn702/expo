#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const getAllModulesInWorkingDirectory = require('./expo-module-getStructure');

const directoryPath = process.cwd();

const modules = getAllModulesInWorkingDirectory();

function maybeUnwrapSwiftArray(type) {
  const isArray = type.startsWith('[') && type.endsWith(']');
  if (!isArray) {
    return type;
  }
  const innerType = type.substring(1, type.length - 1);
  return innerType;
}

function isSwiftArray(type) {
  return type.startsWith('[') && type.endsWith(']');
}

function mapSwiftTypeToTsType(type) {
  if (!type) {
    return ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword);
  }
  if (isSwiftArray(type)) {
    return ts.factory.createArrayTypeNode(mapSwiftTypeToTsType(maybeUnwrapSwiftArray(type)));
  }
  switch (type) {
    case 'unknown':
      return ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);
    case 'String':
      return ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
    case 'Bool':
      return ts.factory.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword);
    case 'Int':
    case 'Float':
    case 'Double':
      return ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
    default:
      return ts.factory.createTypeReferenceNode(type);
  }
}

function getMockReturnStatements(tsReturnType) {
  if (!tsReturnType) {
    return [];
  }
  switch (tsReturnType.kind) {
    case ts.SyntaxKind.AnyKeyword:
      return [ts.factory.createReturnStatement(ts.factory.createNull())];
    case ts.SyntaxKind.StringKeyword:
      return [ts.factory.createReturnStatement(ts.factory.createStringLiteral(''))];
    case ts.SyntaxKind.BooleanKeyword:
      return [ts.factory.createReturnStatement(ts.factory.createFalse())];
    case ts.SyntaxKind.NumberKeyword:
      return [ts.factory.createReturnStatement(ts.factory.createNumericLiteral('0'))];
    case ts.SyntaxKind.VoidKeyword:
      return [];
    case ts.SyntaxKind.ArrayType:
      return [ts.factory.createReturnStatement(ts.factory.createArrayLiteralExpression())];
  }
}

function wrapWithAsync(tsType) {
  return ts.factory.createTypeReferenceNode('Promise', [tsType]);
}

function getMockedFunctions(functions, async = false) {
  return functions.map((fnStructure) => {
    const name = ts.factory.createIdentifier(fnStructure.name);
    const returnType = mapSwiftTypeToTsType(fnStructure.types.returnType);
    const func = ts.factory.createFunctionDeclaration(
      [
        ts.factory.createToken(ts.SyntaxKind.ExportKeyword),
        async ? ts.factory.createToken(ts.SyntaxKind.AsyncKeyword) : undefined,
      ].filter((f) => !!f),
      undefined,
      name,
      undefined,
      fnStructure.types.parameters.map((p) =>
        ts.factory.createParameterDeclaration(
          undefined,
          undefined,
          p.name,
          undefined,
          mapSwiftTypeToTsType(p.typename),
          undefined
        )
      ),
      async ? wrapWithAsync(returnType) : returnType,
      ts.factory.createBlock(getMockReturnStatements(returnType), true)
    );
    return func;
  });
}

function getTypesToMock(module) {
  const foundTypes = [];

  Object.values(module)
    .flatMap((t) => (Array.isArray(t) ? t?.map((t2) => t2?.types) : [] ?? []))
    .forEach((types) => {
      types.parameters.forEach(({ typename }) => {
        foundTypes.push(maybeUnwrapSwiftArray(typename));
      });
      types.returnType && foundTypes.push(maybeUnwrapSwiftArray(types.returnType));
    });
  return new Set(
    foundTypes.filter((ft) => mapSwiftTypeToTsType(ft).kind === ts.SyntaxKind.TypeReference)
  );
}

function getMockedTypes(types) {
  return Array.from(types).map((type) => {
    const name = ts.factory.createIdentifier(type);
    const typeAlias = ts.factory.createTypeAliasDeclaration(
      [ts.factory.createToken(ts.SyntaxKind.ExportKeyword)],
      name,
      undefined,
      ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)
    );
    return typeAlias;
  });
}

function getMockForModule(module) {
  return [].concat(
    getMockedTypes(getTypesToMock(module)),
    getMockedFunctions(module.functions),
    getMockedFunctions(module.asyncFunctions, true)
  );
}

function printModules() {
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

  for (const m of modules) {
    const resultFile = ts.createSourceFile(
      m.name + '.ts',
      '',
      ts.ScriptTarget.Latest,
      false,
      ts.ScriptKind.TSX
    );
    fs.mkdirSync(path.join(directoryPath, 'mocks'), { recursive: true });
    const filePath = path.join(directoryPath, 'mocks', m.name + '.ts');
    const mock = getMockForModule(m);
    const printedTs = printer.printList(ts.ListFormat.MultiLine, mock, resultFile);
    // const transpiledJs = ts.transpileModule(printedTs, { compilerOptions: { module: ts.ModuleKind.ESNext,target:ts.ScriptTarget.ESNext } }).outputText;
    fs.writeFileSync(filePath, printedTs);
  }
}
printModules();
