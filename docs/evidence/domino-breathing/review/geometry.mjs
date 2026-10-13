import * as m from '../../../../assets/brand/domino/model.mjs';
import {writeFileSync} from 'node:fs';
const vertices=[...m.DOMINO_PATH.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map(v=>[+v[1],+v[2]]);
const polygon=(i,t)=>{const [a,b,c,d,e,f]=m.dominoMatrix(i,t);return vertices.map(([u,v])=>[a*u+c*v+e,b*u+d*v+f])};
const area=p=>Math.abs(p.reduce((s,a,i)=>{let b=p[(i+1)%p.length];return s+a[0]*b[1]-a[1]*b[0]},0))/2;
const bounds=p=>({minX:Math.min(...p.map(p=>p[0])),maxX:Math.max(...p.map(p=>p[0])),minY:Math.min(...p.map(p=>p[1])),maxY:Math.max(...p.map(p=>p[1]))});
const clip=p=>{for(const [dim,n,sign]of [[0,0,1],[0,72,-1],[1,0,1],[1,64,-1]]){let q=[];for(let i=0;i<p.length;i++){let a=p[i],b=p[(i+1)%p.length],ia=(a[dim]-n)*sign>=0,ib=(b[dim]-n)*sign>=0;if(ia)q.push(a);if(ia!==ib){let t=(n-a[dim])/(b[dim]-a[dim]);q.push(a.map((v,k)=>v+t*(b[k]-v)));}}p=q;}return p};
let fullStart=null,fullEnd=null,maxReverse=0,mainCounts=[],maxContactError=0,offscreen=[];
for(let t=0;t<4500;t++){
const p=polygon(0,t),b=bounds(p),s=m.dominoState(0,t);
if(s.angle===0 && b.minX>=1&&b.maxX<=71&&b.minY>=1&&b.maxY<=63){fullStart??=t;fullEnd=t;}
if(t>0)maxReverse=Math.max(maxReverse,m.dominoState(0,t-1).angle-s.angle);
if(t%25===0){mainCounts.push(m.DOMINO_CARDS.map(i=>{const p=polygon(i,t);return area(clip(p))}).filter(v=>v>=180).length);}
const front=m.dominoAngleAtAge(t),back=m.dominoAngleAtAge(t+300);
if(back<m.DOMINO_FALL_ANGLE)maxContactError=Math.max(maxContactError,Math.abs(m.DOMINO_HEIGHT*Math.sin(back-front)-m.DOMINO_SPACING*Math.cos(front)));
}
for(let i of m.DOMINO_CARDS){const t=4500-i*300;offscreen.push([t-0.001,t].map(t=>{const b=bounds(polygon(i,t));return b.maxX<0||b.minX>72||b.maxY<0||b.minY>64;}));}
const result={parameters:{width:m.DOMINO_WIDTH,height:m.DOMINO_HEIGHT,pitch:m.DOMINO_SPACING,camera:m.DOMINO_CAMERA,fallAt:m.DOMINO_TIMING.fallAt},fullUpright:{start:fullStart,end:fullEnd,durationMs:fullEnd-fullStart+1},maxReverse,maxContactError,mainCardsArea180Range:[Math.min(...mainCounts),Math.max(...mainCounts)],recycleEndpointsAllOffscreen:offscreen.every(p=>p.every(Boolean)),seamMaxMatrixError:Math.max(...m.DOMINO_CARDS.flatMap(i=>m.dominoMatrix(i,0).map((v,j)=>Math.abs(v-m.dominoMatrix(i,4500)[j]))))};
writeFileSync('docs/evidence/domino-breathing/review/geometry.json',JSON.stringify(result,null,2));console.log(result);
