import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
const require=createRequire(process.env.D01_WEB_PACKAGE||'C:/Users/yxy/Desktop/work/AI_FOR_VECTOR/web/package.json');
const {chromium}=require('playwright');
const browser=await chromium.launch({headless:true,channel:'chrome'});
const context='?projectId=18cb3488-119b-4d8d-958f-e20a0a70d0ae&layerId=76375d7a-74cf-4c2b-b0e0-d724afaec1d9';
const base='http://127.0.0.1:18404/prototype.html';
const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
const records=[],errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
async function goto(route){await page.goto(base+'#/'+route+context);await page.waitForFunction(()=>window.D01?.ready);await page.waitForTimeout(200);}
async function shot(name,fullPage=false){await page.evaluate(()=>(document.querySelector('#notice').textContent='',document.activeElement?.blur()));await page.screenshot({path:`evidence/${name}.png`,fullPage});records.push({name,fullPage,viewport:page.viewportSize(),url:page.url(),metrics:await page.evaluate(()=>D01.metrics())});}
await goto('home');await page.evaluate(()=>D01.captureAt('home',0));await shot('desktop-idle');
for(const [name,t]of [['f0',0],['f30',500],['f90',1500],['f180',3000]]){await page.evaluate(t=>D01.captureAt('preview',t),t);await shot('desktop-'+name);}
await page.evaluate(()=>D01.captureAt('expanding',280));await shot('desktop-expanding');
for(const id of ['projects','data','analysis','tasks','exports','overview']){await goto(id);if(id==='tasks')await page.locator('[data-task]').first().click();if(id==='overview'){await page.locator('#work-project').selectOption('');}await shot('page-'+id);}
await page.setViewportSize({width:1280,height:720});await goto('home');await page.evaluate(()=>D01.captureAt('home',0));await shot('laptop-idle');await page.evaluate(()=>D01.captureAt('preview',1500));await shot('laptop-preview');
await page.setViewportSize({width:1920,height:1080});await goto('home');await page.evaluate(()=>D01.captureAt('home',0));await shot('desktop-1920');
for(const [prefix,size]of [['mobile',{width:390,height:844}],['landscape',{width:844,height:390}]]){await page.setViewportSize(size);await goto('home');await page.evaluate(()=>D01.captureAt('home',0));await shot(prefix+'-idle');await page.evaluate(()=>D01.captureAt('preview',1500));await shot(prefix+'-preview',prefix==='mobile');await goto('analysis');await shot(prefix+'-destination',true);}
await fs.writeFile('evidence/capture-manifest.json',JSON.stringify({version:'D01-R1',createdAt:new Date().toISOString(),sameAssets:'assets/runtime_manifest.json',timing:'Deterministic storyboard points, not timing-performance measurements.',errors,records},null,2));
console.log(JSON.stringify({screenshots:records.length,errors}));await browser.close();
