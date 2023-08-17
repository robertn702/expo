#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const glob = require('glob');
const XML = require('xml-js');
const YAML = require('yaml');

const directoryPath = process.cwd();
const pattern = `${directoryPath}/**/*.swift`;

function getStructureFromFile(file) {
  const command = 'sourcekitten structure --file ' + file.path;

  try {
    const output = execSync(command);
    return JSON.parse(output);
  } catch (error) {
    console.error('An error occurred while executing the command:', error);
  }
}
// find an object with "key.typename" : "ModuleDefinition" somewhere in the structure and return it
function findModuleDefinitionInStructure(structure) {
  if (!structure) {
    return null;
  }
  if (structure?.['key.typename'] === 'ModuleDefinition') {
    const root = structure?.['key.substructure'];
    if (!root) {
      console.warn('Found ModuleDefinition but it is malformed');
    }
    return root;
  }
  const substructure = structure['key.substructure'];
  if (Array.isArray(substructure) && substructure.length > 0) {
    for (const child of substructure) {
      let result = null;
      result = findModuleDefinitionInStructure(child);
      if (result) {
        return result;
      }
    }
    return null;
  }
}

// Read string straight from file – needed since we can't get cursorinfo for modulename
function getIdentifierFromOffsetObject(offsetObject, file) {
  // adding 1 and removing 1 to get rid of quotes
  return file.content
    .substring(offsetObject['key.offset'], offsetObject['key.offset'] + offsetObject['key.length'])
    .replaceAll('"', '');
}

function maybeUnwrapXMLStructs(type) {
  if (!type) return type;
  if (typeof type === 'string') {
    return type;
  }

  if (type['_text']) {
    return type['_text'];
  }
  if (type['ref.struct']) {
    return maybeUnwrapXMLStructs(type['ref.struct']);
  }
  return type;
}

function maybeWrapArray(itemOrItems) {
  if (!itemOrItems) {
    return null;
  }
  if (Array.isArray(itemOrItems)) {
    return itemOrItems;
  } else {
    return [itemOrItems];
  }
}

function parseXMLAnnotatedDeclarations(cursorInfoOutput) {
  const xml = cursorInfoOutput['key.fully_annotated_decl'];
  if (!xml) {
    return cursorInfoOutput;
  }
  const parsed = XML.xml2js(xml, { compact: true });

  const parameters =
    maybeWrapArray(parsed?.['decl.function.free']?.['decl.var.parameter'])?.map((p) => ({
      name: maybeUnwrapXMLStructs(p['decl.var.parameter.argument_label']),
      nametype: maybeUnwrapXMLStructs(p['decl.var.parameter.type']),
    })) ?? [];
  const returnType = maybeUnwrapXMLStructs(
    parsed?.['decl.function.free']?.['decl.function.returntype']
  );
  return { parameters, returnType };
}

// Read type description with sourcekitten, works only for variables
function getTypeFromOffsetObject(offsetObject, file) {
  if (!offsetObject) {
    return null;
  }
  const request = {
    'key.request': 'source.request.cursorinfo',
    'key.sourcefile': file.path,
    'key.offset': offsetObject['key.offset'],
    'key.compilerargs': [
      file.path,
      // TODO: get this from the project
      '-target',
      'arm64-apple-ios16.4.0',
      '-sdk',
      '/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS16.4.sdk',
    ],
  };
  const yamlRequest = YAML.stringify(request, {
    defaultStringType: 'QUOTE_DOUBLE',
    lineWidth: 0,
    defaultKeyType: 'PLAIN',
    // needed since behaviour of sourcekitten is not consistent
  }).replace('"source.request.cursorinfo"', 'source.request.cursorinfo');

  const command = 'sourcekitten request --yaml "' + yamlRequest.replaceAll('"', '\\"') + '"';
  try {
    const output = execSync(command, { stdio: 'pipe' });
    return parseXMLAnnotatedDeclarations(JSON.parse(output));
  } catch (error) {
    console.error('An error occurred while executing the command:', error);
  }
}

function hasSubstructure(structureObject) {
  return structureObject?.['key.substructure'] && structureObject['key.substructure'].length > 0;
}

function parseClosureTypes(structureObject) {
  const closure = structureObject['key.substructure']?.find(
    (s) => s['key.kind'] === 'source.lang.swift.expr.closure'
  );
  if (!closure) {
    return null;
  }
  const parameters = closure['key.substructure']
    ?.filter((s) => s['key.kind'] === 'source.lang.swift.decl.var.parameter')
    .map((p) => ({ name: p['key.name'], typename: p['key.typename'] }));

  // TODO: Figure out if possible
  const returnType = 'unknown';
  return { parameters, returnType };
}

// Used for functions,async functions, all of shape Identifier(name, closure or function)
function findNamedDefinitionsOfType(type, moduleDefinition, file) {
  const definitionsOfType = moduleDefinition.filter((md) => md['key.name'] === type);
  return definitionsOfType.map((d) => {
    const definitionParams = d['key.substructure'];
    const name = getIdentifierFromOffsetObject(definitionParams[0], file);
    let types = null;
    if (hasSubstructure(definitionParams[1])) {
      types = parseClosureTypes(definitionParams[1]);
    } else {
      types = getTypeFromOffsetObject(definitionParams[1], file);
    }
    return { name, types };
  });
}

// Used for functions,async functions, all of shape Identifier(name, closure or function)
function findUnnamedDefinitionsOfType(type, moduleDefinition, file) {
  const definitionsOfType = moduleDefinition.filter((md) => md['key.name'] === type);
  return definitionsOfType.map((d) => {
    const definitionParams = d['key.substructure'];
    let types = null;
    if (hasSubstructure(definitionParams[0])) {
      types = parseClosureTypes(definitionParams[0]);
    } else {
      types = getTypeFromOffsetObject(definitionParams[0], file);
    }
    return { name: null, types };
  });
}

// Used for events
function findGroupedDefinitionsOfType(type, moduleDefinition, file) {
  const definitionsOfType = moduleDefinition.filter((md) => md['key.name'] === type);
  return definitionsOfType.flatMap((d) => {
    const definitionParams = d['key.substructure'];
    return definitionParams.map((d) => ({ name: getIdentifierFromOffsetObject(d, file) }));
  });
}

function findAndParseView(moduleDefinition, file) {
  const viewDefinition = moduleDefinition.find((md) => md['key.name'] === 'View');
  if (!viewDefinition) {
    return null;
  }
  // we support reading view definitions from closure only
  const viewModuleDefinition =
    viewDefinition['key.substructure']?.[1]?.['key.substructure']?.[0]?.['key.substructure']?.[0]?.[
      'key.substructure'
    ];
  if (!viewModuleDefinition) {
    console.warn('Could not parse view definition');
    return null;
  }
  // let's drop nested view field (is null anyways)
  const { view: _, ...definition } = parseModuleDefinition(viewModuleDefinition, file);
  return definition;
}

function omitViewFromTypes(definitions) {
  return definitions.map((d) => ({
    ...d,
    types: {
      ...d.types,
      parameters: d.types.parameters?.filter((t, idx) => idx !== 0 && t.name !== 'view'),
    },
  }));
}

function parseModuleDefinition(moduleDefinition, file) {
  const parsedDefinition = {
    name: findNamedDefinitionsOfType('Name', moduleDefinition, file)?.[0]?.name,
    functions: findNamedDefinitionsOfType('Function', moduleDefinition, file),
    asyncFunctions: findNamedDefinitionsOfType('AsyncFunction', moduleDefinition, file),
    events: findGroupedDefinitionsOfType('Events', moduleDefinition, file),
    properties: findNamedDefinitionsOfType('Property', moduleDefinition, file),
    props: omitViewFromTypes(findNamedDefinitionsOfType('Prop', moduleDefinition, file)),
    onCreate: findUnnamedDefinitionsOfType('OnCreate', moduleDefinition, file),
    view: findAndParseView(moduleDefinition, file),
  };
  return parsedDefinition;
}

function findModuleDefinitionsInFiles(files) {
  for (const path of files) {
    const file = { path, content: fs.readFileSync(path, 'utf8') };
    const definition = findModuleDefinitionInStructure(getStructureFromFile(file));
    if (definition) {
      console.log(JSON.stringify(parseModuleDefinition(definition, file), null, 2));
    }
  }
}

glob(pattern, (error, files) => {
  if (error) {
    console.error('An error occurred while searching for Swift files:', error);
  } else {
    findModuleDefinitionsInFiles(files);
  }
});
