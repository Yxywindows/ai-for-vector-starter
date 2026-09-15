import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {TaskFeedback} from '../../task-feedback.mjs';
const checks = [];
function check(name, run) { run(); checks.push({name,pass:true}); }
const events = [];
const feedback = new TaskFeedback(task => events.push({...task}));
check('historical terminal snapshots are silent', () => {
  feedback.observe({id:'history-ok',state:'succeeded'});
  feedback.observe({id:'history-fail',state:'failed'});
  assert.equal(events.length,0);
});
check('queued-running-succeeded emits once', () => {
  feedback.observe({id:'a',state:'queued'});
  feedback.observe({id:'a',state:'running'});
  assert.equal(feedback.observe({id:'a',state:'succeeded'}),true);
  assert.equal(events.at(-1).state,'succeeded');
});
check('duplicate and stale terminal polling cannot replay', () => {
  for (const state of ['succeeded','running','failed','queued','succeeded']) feedback.observe({id:'a',state});
  assert.equal(events.length,1);
});
check('running-failed emits once and preserves error data', () => {
  feedback.observe({id:'b',state:'running'});
  feedback.observe({id:'b',state:'failed',error:{code:'INVALID_GEOMETRY'}});
  assert.equal(events.length,2);
  assert.equal(events.at(-1).error.code,'INVALID_GEOMETRY');
});
check('cancelled task is not failure feedback', () => {
  for (const state of ['running','cancelling','running','queued','cancelled','failed']) feedback.observe({id:'c',state});
  assert.equal(events.length,2);
});
check('unknown and malformed states cannot produce a result', () => {
  for (const task of [null,{}, {id:'x',state:'validated'},{id:'x',state:'success'}, {state:'failed'}]) feedback.observe(task);
  assert.equal(events.length,2);
});
check('new task attempt with new ID can report result', () => {
  feedback.observe({id:'b-retry',state:'queued'});
  feedback.observe({id:'b-retry',state:'succeeded'});
  assert.equal(events.length,3);
});
check('snapshot tracking remains bounded without replaying evicted history', () => {
  for(let i=0;i<600;i++) feedback.observe({id:`history-${i}`,state:'failed'});
  assert.equal(feedback.tasks.size,512);
  feedback.observe({id:'history-0',state:'failed'});
  assert.equal(events.length,3);
});
const report={version:'D01-R1.2',passed:checks.length,failed:0,checks};
await fs.writeFile(new URL('./task-feedback-verification.json',import.meta.url),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
