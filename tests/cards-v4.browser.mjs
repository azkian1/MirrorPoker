import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawnEsbuild } from '../scripts/test-tools.mjs'
import { pathToFileURL } from 'node:url'

// Actual Chromium canvas pixels and pinned Three/WebGL; no hosted runtime claim.
const root=path.resolve(import.meta.dirname,'..')
const output=path.join(root,'.local-check/cards-v12')
await fs.mkdir(output,{recursive:true})
await fs.mkdir(path.join(root,'.test-output'),{recursive:true})
const build=spawnEsbuild([
  'tests/cards-v4-entry.ts','--bundle','--platform=browser','--format=esm','--external:three','--outfile=.test-output/cards-v4-bundle.mjs',
],{cwd:root,encoding:'utf8'})
assert.equal(build.status,0,build.stderr)
const bundle=await fs.readFile(path.join(root,'.test-output/cards-v4-bundle.mjs'))
const engine=await fs.readFile(path.join(root,'node_modules/three/build/three.module.js'))
const {chromium}=await import('@playwright/test')
let executablePath=process.env.MIRROR_CHROMIUM

let browser,page
const report={kind:'LOCAL CHROMIUM CANVAS + WEBGL — NOT HOSTED RUNTIME',checks:{},errors:[],images:[]}
before(async()=>{
  browser=await chromium.launch({channel:"chromium",headless:true,...(executablePath?{executablePath}:{}),args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']})
  page=await browser.newPage({viewport:{width:1716,height:856},deviceScaleFactor:1})
  page.on('pageerror',error=>report.errors.push(error.message))
  await page.route('**/*',route=>{
    const url=route.request().url()
    if(url==='http://mirror-cards.local/three.core.js')return fs.readFile(path.join(root,'node_modules/three/build/three.core.js')).then(body=>route.fulfill({contentType:'text/javascript',body}))
    if(url==='http://mirror-cards.local/three.mjs')return route.fulfill({contentType:'text/javascript',body:engine})
    if(url==='http://mirror-cards.local/cards.mjs')return route.fulfill({contentType:'text/javascript',body:bundle})
    if(url!=='http://mirror-cards.local/')return route.abort()
    return route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#29272d;font:14px Arial;color:#fff}#sheet{display:grid;grid-template-columns:repeat(13,132px);gap:0}figure{margin:0;padding:4px 2px 8px;box-sizing:border-box}figure canvas{width:128px;height:180px;display:block}figcaption{text-align:center;padding:3px}#view{display:none}</style><script type="importmap">{"imports":{"three":"/three.mjs"}}</script></head><body><div id="sheet"></div><div id="view"></div><script type="module">
      import {THREE,createCardFactory,createWorld,ANCHORS,CAMERA,CARD,CARD_REST,CARD_SUITS,CARD_ART,cardFaceSvg,cardCompactSvg} from '/cards.mjs';
      window.cardsV4={THREE,createCardFactory,createWorld,ANCHORS,CAMERA,CARD,CARD_REST,CARD_SUITS,CARD_ART,cardFaceSvg,cardCompactSvg};
      window.factory=createCardFactory(); window.cardCanvases={};
      for(const suit of 'cdhs')for(const rank of '23456789TJQKA'){
        const id=rank+suit,piece=factory.create(id),canvas=piece.group.children[1].material.map.image;
        cardCanvases[id]=canvas;const figure=document.createElement('figure');figure.append(canvas.cloneNode());
        figure.firstChild.getContext('2d').drawImage(canvas,0,0);const label=document.createElement('figcaption');label.textContent=(rank==='T'?'10':rank)+suit;figure.append(label);document.querySelector('#sheet').append(figure);
      }
      window.ready=true;
    </script></body></html>`})
  })
  await page.goto('http://mirror-cards.local/')
  await page.waitForFunction(()=>window.ready)
  const target=path.join(output,'01-all-52-faces.png');await page.screenshot({path:target,fullPage:true});report.images.push(target)
})
after(async()=>{
  if(page)assert.deepEqual(report.errors,[])
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2))
  await browser?.close()
})

test('all 52 faces have large corner-only ranks, one rank-independent central pip and four matching suit colors',async()=>{
  const metrics=await page.evaluate(()=>{
    const luma=rgb=>rgb.map(value=>{const s=value/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4}).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0)
    const box=(context,left,top,width,height)=>{
      const data=context.getImageData(left,top,width,height).data,points=[]
      let darkest=[255,255,255],minimum=1
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const at=(y*width+x)*4,rgb=[data[at],data[at+1],data[at+2]],light=luma(rgb)
        if(light<minimum){minimum=light;darkest=rgb}
        if(light<.25)points.push([x,y])
      }
      return{pixels:points.length,width:points.length?Math.max(...points.map(p=>p[0]))-Math.min(...points.map(p=>p[0]))+1:0,height:points.length?Math.max(...points.map(p=>p[1]))-Math.min(...points.map(p=>p[1]))+1:0,darkest}
    }
    const result=[]
    for(const [id,canvas]of Object.entries(cardCanvases)){
      const c=canvas.getContext('2d'),background=[...c.getImageData(128,12,1,1).data].slice(0,3)
      const corner=box(c,9,8,90,106),central=box(c,72,113,112,134),suit=box(c,20,118,54,55)
      const thumbnail=document.createElement('canvas');thumbnail.width=45;thumbnail.height=63;const small=thumbnail.getContext('2d');small.drawImage(canvas,0,0,45,63)
      const smallRank=box(small,1,1,22,18),signature=[...small.getImageData(1,1,22,18).data].filter((_,i)=>i%4!==3).map(value=>value<150?'1':'0').join('')
      const centralSignature=[...c.getImageData(72,113,112,134).data].join(',')
      const expected=cardsV4.CARD_SUITS[id[1]].color
      const colorCanvas=document.createElement('canvas');colorCanvas.width=colorCanvas.height=1;const colorContext=colorCanvas.getContext('2d');colorContext.fillStyle=expected;colorContext.fillRect(0,0,1,1);const expectedRGB=[...colorContext.getImageData(0,0,1,1).data].slice(0,3)
      const clippedInk=box(c,0,8,8,344).pixels+box(c,248,8,8,344).pixels+box(c,8,0,240,8).pixels+box(c,8,352,240,8).pixels
      result.push({id,corner,central,suit,smallRank,signature,centralSignature,expectedRGB,clippedInk,contrast:(luma(background)+.05)/(luma(corner.darkest)+.05)})
    }
    return result
  })
  assert.equal(metrics.length,52)
  assert.ok(metrics.every(card=>card.corner.height>=96&&card.corner.pixels>=1700),JSON.stringify(metrics.map(c=>({id:c.id,corner:c.corner}))))
  assert.ok(metrics.every(card=>card.central.height>=74&&card.central.pixels>=1800),JSON.stringify(metrics.map(c=>({id:c.id,central:c.central}))))
  assert.ok(metrics.every(card=>card.suit.height>=30&&card.suit.pixels>=400))
  assert.ok(metrics.every(card=>card.contrast>=4.5))
  assert.ok(metrics.every(card=>card.smallRank.height>=11&&card.smallRank.pixels>=45))
  assert.ok(metrics.every(card=>card.clippedInk===0),'Every rank, including 10, stays inside the outer print margin')
  assert.ok(metrics.filter(card=>card.id[0]==='T').every(card=>card.corner.width>=70&&card.corner.height>=96),'A ten retains both vector digits at the full rank height')
  for(const suit of 'cdhs'){
    const suited=metrics.filter(card=>card.id[1]===suit)
    assert.equal(new Set(suited.map(card=>card.signature)).size,13)
    assert.equal(new Set(suited.map(card=>card.centralSignature)).size,1,'Only the suit belongs in the center; the center must not vary with rank')
  }
  assert.equal(new Set(metrics.map(card=>card.expectedRGB.join(','))).size,4)
  for(const card of metrics){
    assert.deepEqual(card.corner.darkest,card.expectedRGB,`${card.id} rank uses its suit color`)
    assert.deepEqual(card.suit.darkest,card.expectedRGB,`${card.id} corner pip uses its suit color`)
    assert.deepEqual(card.central.darkest,card.expectedRGB,`${card.id} center pip uses its suit color`)
  }
  const blue=metrics.find(card=>card.id==='Ad').expectedRGB,green=metrics.find(card=>card.id==='Ac').expectedRGB,red=metrics.find(card=>card.id==='Ah').expectedRGB
  assert.ok(blue[2]>blue[0]&&blue[2]>blue[1],'diamonds are blue')
  assert.ok(green[1]>green[0]&&green[1]>green[2],'clubs are green')
  assert.ok(red[0]>red[1]&&red[0]>red[2],'hearts are red')
  report.checks.faceMetrics=metrics.map(({signature,centralSignature,...card})=>card)
})

test('factory keeps physical size, shared materials, back identity and face orientation with neutral print colors',async()=>{
  const result=await page.evaluate(()=>{
    const {THREE,CARD}=cardsV4,a=factory.create('As'),b=factory.create('As'),hidden=factory.create(null)
    const front=a.group.children[1],back=a.group.children[2],geometry=a.group.children[0].geometry
    geometry.computeBoundingBox();const size=geometry.boundingBox.getSize(new THREE.Vector3())
    const originalBack=back.material
    a.setCard('Td');const ten=a.group.children[1].material
    a.setCard('As')
    return{size:size.toArray(),expected:[CARD.width,CARD.thickness,CARD.height],sameFront:front.material===b.group.children[1].material,sameBack:originalBack===hidden.group.children[1].material,frontNormal:new THREE.Vector3(0,0,1).applyEuler(front.rotation).toArray(),backNormal:new THREE.Vector3(0,0,1).applyEuler(back.rotation).toArray(),faceToneMapped:front.material.toneMapped,tenToneMapped:ten.toneMapped,backToneMapped:back.material.toneMapped,backCenter:[...originalBack.map.image.getContext('2d').getImageData(128,180,1,1).data]}
  })
  result.size.forEach((value,index)=>assert.ok(Math.abs(value-result.expected[index])<1e-6))
  assert.equal(result.sameFront,true);assert.equal(result.sameBack,true)
  assert.ok(result.frontNormal[1]>.999);assert.ok(result.backNormal[1]<-.999)
  assert.equal(result.faceToneMapped,false);assert.equal(result.tenToneMapped,false)
  assert.equal(result.backToneMapped,false)
  report.checks.factory=result
})

test('rounded paper geometry removes square corners, keeps thin back margins, and retains two separate ten digits',async()=>{
  const result=await page.evaluate(()=>{
    const {THREE,CARD,CARD_REST}=cardsV4,piece=factory.create('Td'),front=piece.group.children[1]
    piece.group.updateMatrixWorld(true)
    const hit=(x,z)=>new THREE.Raycaster(new THREE.Vector3(x,1,z),new THREE.Vector3(0,-1,0)).intersectObject(piece.group,true)[0]?.object
    const cornerHit=!!hit(CARD.width/2-.001,CARD.height/2-.001)
    const edgeHit=hit(CARD.width/2-.001,0)===front,centerHit=hit(0,0)===front
    const canvas=front.material.map.image,c=canvas.getContext('2d'),d=c.getImageData(9,8,90,106),mask=[]
    for(let i=0;i<d.width*d.height;i++)mask.push(d.data[i*4]+d.data[i*4+1]+d.data[i*4+2]<540)
    const sizes=[]
    for(let start=0;start<mask.length;start++)if(mask[start]){
      const queue=[start];mask[start]=false;let size=0
      while(queue.length){const at=queue.pop();size++;const x=at%d.width,y=Math.floor(at/d.width)
        for(const[nx,ny]of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]])if(nx>=0&&nx<d.width&&ny>=0&&ny<d.height){const next=ny*d.width+nx;if(mask[next]){mask[next]=false;queue.push(next)}}
      }
      if(size>30)sizes.push(size)
    }
    const back=piece.group.children[2].material.map.image.getContext('2d'),row=back.getImageData(0,180,256,1).data
    let palePixels=0
    for(let x=0;x<256;x++)if(row[x*4]>130&&row[x*4+1]>130&&row[x*4+2]>130)palePixels++
    const uv=front.geometry.getAttribute('uv'),positions=front.geometry.getAttribute('position')
    let uvError=0
    for(let i=0;i<uv.count;i++)uvError=Math.max(uvError,Math.abs(uv.getX(i)-(positions.getX(i)/CARD.width+.5)),Math.abs(uv.getY(i)-(positions.getY(i)/CARD.height+.5)))
    return{cornerHit,edgeHit,centerHit,tenComponents:sizes.length,palePixels,uvError,frontY:front.position.y,expectedY:CARD.thickness/2+CARD_REST.skinOffset,thickness:CARD.thickness}
  })
  assert.equal(result.cornerHit,false,'the physical card, including the edge, is cut away at each rounded corner')
  assert.equal(result.edgeHit,true);assert.equal(result.centerHit,true)
  assert.equal(result.tenComponents,2,'10 is two complete separated vector digits, not a tiny T or merged glyph')
  assert.ok(result.palePixels<=10,'the closed card has a thin paper margin rather than the former broad light frame')
  assert.ok(result.uvError<1e-6)
  assert.equal(result.frontY,result.expectedY)
  assert.equal(result.thickness,.004)
  report.checks.roundedPaper=result
})

test('representative faces render in the actual camera and both worlds at desktop sizes',async()=>{
  for(const [width,height]of [[1280,720],[960,600]])for(const mode of ['NORMAL','MIRROR']){
    await page.setViewportSize({width,height})
    const result=await page.evaluate(({width,height,mode})=>{
      const {THREE,createCardFactory,createWorld,ANCHORS,CAMERA,CARD_REST}=cardsV4
      if(window.cardScene){cardScene.world.dispose();cardScene.factory.dispose();cardScene.renderer.dispose()}
      const view=document.querySelector('#view');view.replaceChildren();view.style.display='block';document.querySelector('#sheet').style.display='none'
      const scene=new THREE.Scene(),world=createWorld(scene),cards=createCardFactory()
      for(let i=0;i<60;i++)world.update(.1,mode)
      const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setSize(width,height);renderer.setPixelRatio(1);renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.outputColorSpace=THREE.SRGBColorSpace;view.append(renderer.domElement)
      const fov=THREE.MathUtils.radToDeg(2*Math.atan(Math.tan(THREE.MathUtils.degToRad(CAMERA.fov/2))*Math.max(1,(16/9)/(width/height))))
      const camera=new THREE.PerspectiveCamera(fov,width/height,CAMERA.near,CAMERA.far);camera.position.set(...CAMERA.position);camera.lookAt(...CAMERA.target)
      const placed=[]
      for(const [index,id]of ['As','Kd','Qh','Jc','Td'].entries()){
        const piece=cards.create(id);piece.group.position.set(...ANCHORS.board[index]);piece.group.position.y=CARD_REST.centerY;scene.add(piece.group);placed.push(piece)
      }
      for(const [index,id]of ['8c','6h','9s'].entries()){
        const piece=cards.create(id);piece.group.position.set(-.73+index*.73,CARD_REST.centerY,1.45);scene.add(piece.group);placed.push(piece)
      }
      renderer.render(scene,camera);window.cardScene={world,factory:cards,renderer}
      return{cards:placed.length,drawCalls:renderer.info.render.calls,glError:renderer.getContext().getError()}
    },{width,height,mode})
    assert.equal(result.cards,8);assert.equal(result.glError,0)
    report.checks[`${mode}-${width}`]=result
    const target=path.join(output,`02-${mode.toLowerCase()}-${width}.png`);await page.screenshot({path:target});report.images.push(target)
  }
})
