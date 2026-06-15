// 共有UIヘルパ（モックのデザイントークンを踏襲）
export const C = {
  bg:"#e8ecf3", card:"#fff", ink:"#1d2430", muted:"#6b7480", line:"#dde2ea", lineStrong:"#cad1dc", track:"#eef1f5",
  fill:"#3a86ff", over:"#e5484d", free:"#2fa66b", full:"#8a93a0", amber:"#f5a623", capline:"#9aa3af",
  pj:{ Backend:"#3a86ff", Frontend:"#2fa66b", QA:"#b657d6", "共通":"#8a93a0" },
};
export const member_color = (i)=> ["#e5772d","#3a86ff","#2fa66b","#b657d6","#0ea5e9","#f5a623"][i%6];

// 時間表示は小数2桁まで（15分=0.25 を 0.3 に潰さない）。末尾の0は省く（1.50→1.5 / 4→4）。
export const fmtH = (h)=> { const r = Math.round(h*100)/100; return (Number.isInteger(r) ? r : +r.toFixed(2)) + "h"; };
export const esc = (s)=> (s==null?"":String(s)).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
export const todayISO = ()=> new Date().toISOString().slice(0,10);

// 最小 hyperscript
export function h(tag, attrs, ...kids){
  const e = document.createElement(tag);
  if(attrs) for(const [k,v] of Object.entries(attrs)){
    if(k==="class") e.className=v;
    else if(k==="html") e.innerHTML=v;
    else if(k.startsWith("on") && typeof v==="function") e.addEventListener(k.slice(2),v);
    else if(v!=null) e.setAttribute(k,v);
  }
  for(const k of kids.flat()){ if(k==null) continue; e.append(k.nodeType?k:document.createTextNode(k)); }
  return e;
}
export const clear = (el)=>{ el.innerHTML=""; return el; };

// 容量バー（assignedH / capH, 超過は赤）
export function capacityBar(assignedH, capH, scaleMaxH){
  const max = scaleMaxH || Math.max(capH*1.3, assignedH);
  const inCap = Math.min(assignedH, capH), over = Math.max(0, assignedH-capH);
  return `<div style="position:relative;height:24px;background:${C.track};border-radius:7px;overflow:hidden">
    <div style="position:absolute;left:${capH/max*100}%;top:0;bottom:0;width:2px;background:${C.capline}"></div>
    <div style="position:absolute;left:0;top:0;bottom:0;width:${inCap/max*100}%;background:${C.fill};border-radius:7px 0 0 7px"></div>
    ${over>0?`<div style="position:absolute;left:${capH/max*100}%;top:0;bottom:0;width:${over/max*100}%;background:${C.over}"></div>`:""}
  </div>`;
}
