import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnEsbuild } from '../scripts/test-tools.mjs'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root=resolve(import.meta.dirname,'..')
mkdirSync(resolve(root,'.test-output'),{recursive:true})
const built=spawnEsbuild(['tests/turn-warning-entry.ts','--bundle','--platform=node','--format=esm','--outfile=.test-output/turn-warning-bundle.mjs'],{cwd:root,encoding:'utf8'})
assert.equal(built.status,0,built.stderr)
const {createTurnWarning}=await import('../.test-output/turn-warning-bundle.mjs')
const self={playerId:'p0'}
const state=(remainingMs=30000,turnId='turn-1',playerId='p0',durationMs=30000)=>({
  actorId:playerId,match:{status:'PLAYING'},turnTimer:{remainingMs,turnId,playerId,durationMs},
})

test('warning fires once at five seconds, clock resync cannot refill or replay it',()=>{
  let time=0,warnings=0
  const alarm=createTurnWarning(()=>warnings++,()=>time)
  alarm.observe(state(),self)
  time=24999;alarm.frame();assert.equal(warnings,0)
  // An old snapshot delivered late cannot push the local warning back.
  alarm.observe(state(30000),self)
  time=25000;alarm.frame();assert.equal(warnings,1)
  alarm.observe(state(5000),self);alarm.frame();assert.equal(warnings,1)
  time=30001;alarm.frame();assert.equal(warnings,1)
  alarm.observe(state(10000,'turn-2','p0',10000),self)
  time=35001;alarm.frame();assert.equal(warnings,2)
})

test('opponents, expired turns and cleared sessions are silent; a resynced live turn warns',()=>{
  let time=0,warnings=0
  const alarm=createTurnWarning(()=>warnings++,()=>time)
  alarm.observe(state(4000,'opponent','p1'),self);alarm.frame();assert.equal(warnings,0)
  alarm.observe(state(0),self);alarm.frame();assert.equal(warnings,0)
  alarm.observe(state(4000,'resync'),self);assert.equal(warnings,1)
  alarm.observe(null,null);time=2000;alarm.frame();assert.equal(warnings,1)
  alarm.observe(state(6000,'new'),self);alarm.reset();time=4000;alarm.frame();assert.equal(warnings,1)
  alarm.observe({...state(4000,'finished'),match:{status:'FINISHED'}},self);assert.equal(warnings,1)
})
