(async () => {
  const checks = [], samples = {}, images = {};
  const assert = (value, message) => { if (!value) throw Error(message); };
  const next = () => new Promise(requestAnimationFrame);
  const wait = async (predicate, timeout = 5000) => {
    const start = performance.now();
    while (!predicate()) { if (performance.now() - start > timeout) throw Error('Timed out'); await next(); }
  };
  const pause = async (ms) => { const start = performance.now(); await wait(() => performance.now() - start >= ms, ms + 2000); };
  const check = async (name, run) => { await run(); checks.push({name,pass:true}); };
  await wait(() => window.D01?.ready);
  const s = D01.getScene(), controller = s.interaction;
  const taskCount = D01.snapshot.tasks.length;
  assert(controller, 'Actual GLB interaction controller missing');
  const click = (selector) => { const el = document.querySelector(selector); assert(el, selector); el.click(); };
  if (D01.state.mode !== 'work' || D01.state.feature !== 'tasks') {
    D01.home(); D01.select('tasks'); D01.expand();
  }
  await wait(() => D01.state.mode === 'work');
  const vector = controller.head.position.clone();
  const arm = s.robot.getObjectByName('LowerArmR');
  assert(arm?.isBone, 'Right arm must be present');
  await check('Initial history produces no gesture', () => {
    assert(controller.played.Yes === 0 && controller.played.No === 0, 'History replayed');
  });
  for (const [status, name, sourceClip] of [['succeeded','Yes','Yes'],['failed','No','Wave']]) {
    await check(`${status}: UI lifecycle, one ${sourceClip} gesture, return to idle`, async () => {
      const count = controller.played[name];
      const cube = s.cube.quaternion.toArray();
      click(`[data-task-demo="${status}"]`);
      assert(document.querySelector('#rehearsal-status').dataset.state === 'running', 'Missing running state');
      await wait(() => controller.reaction?.name === name);
      assert(controller.reaction.sourceClip === sourceClip, 'Wrong source animation');
      const rows = [];
      let nextSample = 0;
      while (controller.reaction) {
        const r = controller.reaction;
        if (r.elapsed >= nextSample) {
          s.robot.updateMatrixWorld(true);
          const p = arm.getWorldPosition(vector).project(s.camera);
          rows.push({time:r.elapsed,weight:r.weight,head:controller.head.quaternion.toArray(),arm:arm.quaternion.toArray(),armNDC:p.toArray(),gaze:controller.gaze.toArray()});
          if (r.elapsed > 0.95 && !images[name]) images[name] = s.renderer.domElement.toDataURL('image/png');
          nextSample += 0.1;
        }
        await next();
      }
      await pause(1100);
      assert(controller.played[name] === count + 1, 'Repeated gesture');
      assert(!controller.reaction && !controller.pending, 'Gesture did not return to idle');
      assert(cube.every((value,i) => Math.abs(value-s.cube.quaternion.toArray()[i]) < 1e-7), 'Cube moved during work');
      assert(document.querySelector('#rehearsal-status').dataset.state === status, 'Wrong result status');
      assert(D01.snapshot.tasks.length === taskCount, 'Demo wrote task history');
      assert(rows.length >= 10, 'Insufficient motion samples');
      if (name === 'No') {
        const reference = rows[0].head;
        assert(rows.every(row => row.head.every((v,i) => Math.abs(v-reference[i]) < 0.00001)), 'No must not shake the head');
        assert(!controller.actions.No.getClip().tracks.some(t => /^(Head|Neck)\./.test(t.name)), 'Wave contains head tracks');
      }
      samples[name] = rows;
    });
  }
  await check('Duplicate terminal events are ignored by the integration hook', () => {
    const before = controller.played.Yes;
    D01.observeTask({id:'qa-duplicate',state:'running',demo:true});
    D01.observeTask({id:'qa-duplicate',state:'succeeded',demo:true});
    for (const state of ['succeeded','running','failed','succeeded']) D01.observeTask({id:'qa-duplicate',state,demo:true});
    assert(controller.played.Yes === before + 1 && !controller.pending, 'Duplicate action queued');
  });
  await check('Reduced motion cancels active action and keeps result text', async () => {
    click('#motion');
    assert(controller.reduced && !controller.reaction && controller.gaze.length() === 0, 'Motion was not stopped');
    const before = {...controller.played};
    click('[data-task-demo="failed"]');
    await wait(() => document.querySelector('#rehearsal-status').dataset.state === 'failed');
    assert(controller.played.Yes === before.Yes && controller.played.No === before.No, 'Reduced gesture ran');
    assert(document.querySelector('#rehearsal-status').textContent.includes('静态文字'), 'Missing accessible fallback');
    click('#motion');
  });
  await check('Queued results keep speech aligned with their gesture', async () => {
    D01.observeTask({id:'qa-burst-ok',state:'running',demo:true});
    D01.observeTask({id:'qa-burst-ok',state:'succeeded',demo:true});
    D01.observeTask({id:'qa-burst-fail',state:'running',demo:true});
    D01.observeTask({id:'qa-burst-fail',state:'failed',demo:true});
    assert(controller.reaction.name==='Yes' && controller.pending?.name==='No','Missing pending outcome');
    assert(document.querySelector('#dialogue-text').textContent.includes('这次任务完成了'),'Wrong speech for Yes');
    await wait(()=>controller.reaction?.name==='No');
    assert(document.querySelector('#dialogue-text').textContent.includes('没能完成'),'Wrong speech for Wave');
    await wait(()=>!controller.reaction);
  });
  await check('Navigating away cancels pending rehearsal and restores method dialogue', async () => {
    click('[data-task-demo="succeeded"]');
    click('[data-feature="analysis"]');
    await pause(1150);
    assert(!controller.reaction, 'Late action after navigation');
    assert(document.querySelector('#dialogue-text').textContent.includes('缓冲距离'), 'Stale result dialogue');
  });
  await check('Parameter validation is not task execution feedback', () => {
    const before = {...controller.played};
    click('#analysis-form button[type="submit"]');
    assert(controller.played.Yes === before.Yes && controller.played.No === before.No, 'Validation played task result');
  });
  await check('Seven method dialogues survive the interaction changes', () => {
    const methods = [['buffer','缓冲距离'],['clip','掩膜图层'],['intersection','重叠'],['dissolve','融合全部'],['spatial-join','匹配属性'],['validate-repair','无效几何'],['point-in-polygon','每个面']];
    for (const [id, expected] of methods) {
      click(`[data-tool="${id}"]`);
      assert(document.querySelector('#dialogue-text').textContent.includes(expected), id);
    }
  });
  await check('Only one canvas survives navigation and gesture transitions', () => assert(document.querySelectorAll('canvas').length === 1, 'Duplicate canvas'));
  const report = {version:'D01-R1.2',passed:checks.length,failed:0,checks,samples,renderer:s.metrics().renderer,images};
  D01.home();
  return JSON.stringify(report);
})()
