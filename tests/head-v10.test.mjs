import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEALER_HEAD_GLSL, HEAD_MAPPING } from '../scene/dealer-head.ts'

test('reference-to-body mapping preserves pixel-space head proportions', () => {
  const {source,target}=HEAD_MAPPING
  const sourceSize=source.extent.map((value,axis)=>value*source.pixels[axis])
  const targetSize=target.extent.map((value,axis)=>value*target.pixels[axis])
  const scale=targetSize.map((value,axis)=>value/sourceSize[axis])
  assert.ok(Math.abs(scale[0]/scale[1]-1)<1e-7,JSON.stringify({sourceSize,targetSize,scale}))
  assert.ok(Math.abs(target.min[0]+target.extent[0]/2-.475)<1e-8,'Head stays at the approved horizontal centre')
  assert.equal(target.min[1],.005)
  assert.equal(target.extent[1],.410,'Mouth and chin vertical alignment is retained')
})

test('compiled chunk consumes the approved metadata and keeps the body alpha', () => {
  const vec2=values=>`vec2(${values.map(value=>value.toFixed(8)).join(', ')})`
  for(const rectangle of [HEAD_MAPPING.source,HEAD_MAPPING.target]){
    assert.ok(DEALER_HEAD_GLSL.includes(vec2(rectangle.min)))
    assert.ok(DEALER_HEAD_GLSL.includes(vec2(rectangle.extent)))
  }
  assert.deepEqual(HEAD_MAPPING.neckFade,[.975,1])
  assert.ok(DEALER_HEAD_GLSL.includes('smoothstep(0.97500000, 1.00000000, head.y)'))
  assert.ok(DEALER_HEAD_GLSL.includes('return vec4(mix(body.rgb, reference, coverage), body.a);'))
  assert.ok(DEALER_HEAD_GLSL.includes('uniform sampler2D dealerHeadMap;'))
})
