const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])
const schemaLists = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems'])
const schemaValues = new Set(['items', 'additionalItems', 'additionalProperties', 'unevaluatedItems', 'unevaluatedProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function relocateReference(reference, resourceId) {
  if (typeof reference === 'string') {
    if (reference === '#' || reference.startsWith('#/')) return '#/properties/input' + reference.slice(1)
    try {
      const resource = new URL(resourceId)
      const target = new URL(reference, resource)
      const fragment = target.hash
      resource.hash = target.hash = ''
      if (resource.href === target.href && (!fragment || fragment.startsWith('#/'))) return '#/properties/input' + fragment.slice(1)
    } catch {}
  }
  throw Error('EXTENSION_INFERENCE_INPUT_INVALID')
}

function relocateSchema(schema, resourceId, depth = 0) {
  if (!object(schema)) return schema
  if (depth > 64 || ['$id', '$dynamicRef', '$recursiveRef'].some(key => Object.hasOwn(schema, key))) throw Error('EXTENSION_INFERENCE_INPUT_INVALID')
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => {
    if (key === '$ref') return [key, relocateReference(value, resourceId)]
    const visit = child => relocateSchema(child, resourceId, depth + 1)
    if (schemaMaps.has(key) && object(value)) return [key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, visit(child)]))]
    if ((schemaLists.has(key) || key === 'items') && Array.isArray(value)) return [key, value.map(visit)]
    if (key === 'dependencies' && object(value)) return [key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, Array.isArray(child) ? child : visit(child)]))]
    return [key, schemaValues.has(key) ? visit(value) : value]
  }))
}

function envelopeSchema(parameters) {
  const { $id, $schema, ...schema } = parameters
  return {
    ...($id === undefined ? {} : { $id }),
    ...($schema === undefined ? {} : { $schema }),
    type: 'object',
    properties: { input: relocateSchema(schema, $id) },
    required: ['input'],
    additionalProperties: false,
  }
}

export function createToolArguments(tools, enabled) {
  const enveloped = new Set()
  const adapted = enabled ? tools.map(tool => {
    const schema = tool.parameters
    if (!object(schema) || !['anyOf', 'oneOf', 'allOf', '$ref'].some(key => Object.hasOwn(schema, key)) && !Array.isArray(schema.type)) return tool
    enveloped.add(tool.name)
    return { ...tool, parameters: envelopeSchema(schema) }
  }) : tools
  return {
    tools: adapted,
    encode(name, args) { return enveloped.has(name) ? { input: args } : args },
    decode(name, args) {
      if (!enveloped.has(name)) return args
      if (!object(args) || Object.keys(args).length !== 1 || !Object.hasOwn(args, 'input') || !object(args.input)) throw Error('EXTENSION_INFERENCE_OUTPUT_INVALID')
      return args.input
    },
  }
}
