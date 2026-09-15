(async () => {
  const pause = ms => new Promise(resolve => { const start=performance.now(); const tick=()=>performance.now()-start>=ms ? resolve() : requestAnimationFrame(tick); tick(); });
  D01.home(); D01.resume();
  const s=D01.getScene();
  const stream=s.renderer.domElement.captureStream(30);
  const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8',videoBitsPerSecond:3500000});
  const chunks=[];
  recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
  const finished=new Promise(resolve=>recorder.onstop=resolve);
  recorder.start();
  await pause(700);
  window.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:120,clientY:570}));
  await pause(1100);
  window.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:1150,clientY:160}));
  await pause(1100);
  document.dispatchEvent(new PointerEvent('pointerout',{relatedTarget:null,bubbles:true}));
  D01.observeTask({id:'film-success',state:'running',demo:true});
  D01.observeTask({id:'film-success',state:'succeeded',demo:true});
  await pause(2200);
  D01.observeTask({id:'film-failure',state:'running',demo:true});
  D01.observeTask({id:'film-failure',state:'failed',demo:true});
  await pause(2400);
  recorder.stop(); await finished; stream.getTracks().forEach(t=>t.stop());
  const data=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(new Blob(chunks,{type:'video/webm'}));});
  D01.home();
  return JSON.stringify({data,width:s.renderer.domElement.width,height:s.renderer.domElement.height,scope:'Actual GLB runtime canvas only; local demo task transitions; no business execution',sequence:'idle, look left/down, look right/up, Yes nod, No Wave, return idle'});
})()
