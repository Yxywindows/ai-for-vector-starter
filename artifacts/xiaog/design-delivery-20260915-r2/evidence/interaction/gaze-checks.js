(async () => {
  const checks = [], metrics = {};
  const s = D01.getScene(), c = s.interaction;
  const assert = (v,m) => { if(!v) throw Error(m); };
  const pause = ms => new Promise(resolve => { const start=performance.now(); const tick=()=> performance.now()-start >= ms ? resolve() : requestAnimationFrame(tick); tick(); });
  const check = async (name,run) => { await run(); checks.push({name,pass:true}); };
  await check('Mouse leaving document returns gaze to neutral', async () => {
    document.dispatchEvent(new PointerEvent('pointerout',{relatedTarget:null,bubbles:true}));
    await pause(1600);
    assert(c.gaze.length()<0.001 && c.target.length()===0,'Gaze did not centre');
  });
  await check('Mouse gaze yields while gesture plays and resumes afterward', async () => {
    window.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:1100,clientY:120}));
    await pause(900);
    const before=c.gaze.length();
    s.taskResult('failed');
    await pause(650);
    assert(c.reaction?.sourceClip==='Wave' && c.gaze.length()<before*.08,'Gesture did not own attention');
    await pause(1800);
    assert(!c.reaction && c.gaze.length()>.3,'Gaze did not resume');
  });
  await check('Touch input clears mouse gaze', async () => {
    window.dispatchEvent(new PointerEvent('pointermove',{pointerType:'touch',clientX:15,clientY:30}));
    await pause(1500);
    assert(!s.pointer && c.gaze.length()<.001,'Touch inherited mouse gaze');
  });
  await check('Window blur centres gaze', async () => {
    window.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:10,clientY:600}));
    await pause(350);
    window.dispatchEvent(new Event('blur'));
    await pause(1600);
    assert(c.gaze.length()<.001,'Blur did not centre');
  });
  D01.select('tasks'); D01.expand(); await pause(1000);
  await check('Work view stops rendering once pointer settles', async () => {
    window.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:700,clientY:350}));
    await pause(2200);
    const rendered=s.rendered;
    await pause(600);
    assert(s.rendered-rendered <= 1,'Work view keeps rendering');
    metrics.settledFrames=s.rendered-rendered;
  });
  await check('Reduced motion ignores mouse updates without redrawing', async () => {
    document.querySelector('#motion').click(); await pause(100);
    const rendered=s.rendered;
    window.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:20,clientY:20}));
    await pause(400);
    assert(c.gaze.length()===0 && !s.pointer,'Reduced motion tracked cursor');
    assert(s.rendered===rendered,'Reduced pointer caused redraw');
    document.querySelector('#motion').click();
  });
  await check('Gaze remains bounded and does not accumulate bone rotation', () => {
    s.frozen=true; s.pointer=null; c.cancel(); c.look(99,-99);
    for(let i=0;i<150;i++)c.update(1/60,s.camera,false);
    const q=c.head.quaternion.clone();
    for(let i=0;i<500;i++)c.update(1/60,s.camera,false);
    const angle=q.angleTo(c.head.quaternion);
    assert(angle<.00001,'Accumulated rotation');
    for(const eye of c.metrics().eyeOffsets) assert(Math.abs(eye.offset[0])<=.070001 && Math.abs(eye.offset[1])<=.045001 && eye.offset[2]===0,'Eye left lens plane');
    metrics.driftRadians=angle; metrics.limits=c.metrics().eyeOffsets;
    c.cancel(); s.resume();
  });
  await check('Rapid outcomes keep at most the latest pending gesture', async () => {
    c.react('succeeded');c.react('failed');c.react('succeeded');c.react('failed');
    assert(c.reaction.name==='Yes' && c.pending?.name==='No','Unbounded or interrupted queue');
    await pause(4300);
    assert(!c.reaction&&!c.pending,'Queued feedback did not finish');
  });
  D01.home();
  return JSON.stringify({version:'D01-R1.2',passed:checks.length,failed:0,checks,metrics});
})()
