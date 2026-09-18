import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

for (const nodeType of ['image', 'video']) {
  test(`${nodeType} generation polling survives collaboration rerenders`, () => {
    const source = readFileSync(new URL(`../components/canvas/nodes/${nodeType}-node.tsx`, import.meta.url), 'utf8')

    assert.match(source, /const patchNodeDataRef = useRef\(patchNodeData\)/)
    assert.match(source, /patchNodeDataRef\.current = patchNodeData/)
    assert.match(source, /patchNodeDataRef\.current\(id, patch\)/)
    assert.doesNotMatch(source, /\}, \[id, patchNodeData\]\)/)
  })
}
