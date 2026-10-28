// Rushi Mail: Mail.tm plus optional user-owned free DropMail access.
// Only the specific inbox actions below are exposed. There is no generic API proxy.
const UPSTREAM = 'https://api.mail.tm';
const HEADERS = {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
const list = d => d['hydra:member'] || d.member || [];
const json = (data, status=200, extra={}) => new Response(JSON.stringify(data), {status,headers:{...HEADERS,...extra}});
const failure = (message,status=400) => Object.assign(new Error(message),{status});
let availableCache = null, availableAt = 0;
async function service(path, {token='',method='GET',body}={}) {
 const headers={Accept:'application/ld+json'};
 if(token)headers.Authorization='Bearer '+token;
 if(body!==undefined)headers['Content-Type']=method==='PATCH'?'application/merge-patch+json':'application/json';
 let response;
 try{response=await fetch(UPSTREAM+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});}catch{throw failure('The email service is not responding. Please try again later.',503);}
 if(response.status===204)return null;
 const data=await response.json().catch(()=>({}));
 if(!response.ok){let message='The email service returned an error. Please try again.';
 if(response.status===401)message='This inbox could not reconnect. It may have expired. Try Refresh or create a new address.';
 if(response.status===422)message='That email name is unavailable or invalid. Try a different name or leave it blank.';
 if(response.status===429)message='The email service is busy. Wait one minute before trying again.';
 if(response.status===404||response.status===410)message='This inbox or message is no longer available.';
 throw failure(message,response.status>=500?503:response.status);}
 return data;
}
async function available(){
 if(availableCache&&Date.now()-availableAt<300000)return availableCache;
 const found=[];
 for(let page=1;page<=20;page++){
  const d=await service('/domains?page='+page);
  found.push(...list(d).filter(x=>x.isActive!==false&&!x.isPrivate).map(x=>({domain:x.domain})));
  if(!d['hydra:view']?.['hydra:next'])break;
 }
 if(!found.length)throw failure('No email domains are available right now.',503);
 availableCache=[...new Map(found.map(d=>[d.domain,d])).values()];availableAt=Date.now();return availableCache;
}
async function dropService(token,query,variables={}){
 if(!/^af_[A-Za-z0-9._~-]+$/.test(token)||token.length>6000)throw failure('Connect your free DropMail token using More domains.',401);
 let response;
 try{response=await fetch('https://dropmail.me/api/graphql/-',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json',Authorization:'Bearer '+token},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(15000)});}catch{throw failure('DropMail is not responding. Please try again later.',503);}
 const result=await response.json().catch(()=>({}));
 if(response.status===401||response.status===403)throw failure('Your DropMail token is invalid or expired. Open More domains to connect a valid token.',401);
 const code=result.errors?.[0]?.extensions?.code;
 if(response.status===429||code==='RATE_LIMIT_EXCEEDED')throw failure('DropMail is limiting requests. Wait one minute before trying again.',429);
 if(code==='SESSION_NOT_FOUND')throw failure('This DropMail inbox expired. Its old emails cannot be recovered. Create a new address.',410);
 if(code==='DOMAIN_NOT_FOUND')throw failure('That domain is no longer available. Reload the domain list.',400);
 if(!response.ok||result.errors?.length||!result.data)throw failure('DropMail could not complete this action. Please try again.',503);
 return result.data;
}
function dropId(value){if(typeof value!=='string'||!/^[A-Za-z0-9_+/=-]{1,512}$/.test(value))throw failure('Invalid inbox or message identifier.');return value;}
const DROP_FIELDS='id fromAddr headerSubject text receivedAt';
function normalDrop(m){return {id:m.id,from:{name:'',address:m.fromAddr||''},subject:m.headerSubject||'',intro:(m.text||'').slice(0,180),text:m.text||'',html:[],seen:false,isDeleted:false,createdAt:m.receivedAt};}
async function dropAction(path,b,token){
 if(path==='/app/drop-options'){
  const d=await dropService(token,'query {domains {id name expiresAt availableVia health}}');
  return json({domains:d.domains.filter(x=>x.availableVia?.includes('API')&&x.health!=='BROKEN'&&(!x.expiresAt||Date.parse(x.expiresAt)>Date.now())).map(x=>({domain:x.name,id:x.id,provider:'dropmail',expiresAt:x.expiresAt}))});
 }
 if(path==='/app/drop-create'){
  const d=await dropService(token,'mutation ($domain: ID!) {introduceSession(input:{domainId:$domain}) {id expiresAt addresses {id address}}}',{domain:dropId(b.domainId)});
  const s=d.introduceSession,a=s?.addresses?.[0];if(!a)throw failure('DropMail did not create an inbox. Try again.',503);
  return json({inbox:{id:a.id,address:a.address,sessionId:s.id,provider:'dropmail',expiresAt:s.expiresAt}},201);
 }
 if(path==='/app/drop-check'){
  const after=b.cursor==null?null:dropId(b.cursor);
  const d=await dropService(token,'query ($id: ID!, $after: String) {session(id:$id) {expiresAt mailsConnection(first:30,after:$after,sort:DESC) {totalCount pageInfo {hasNextPage endCursor} edges {node {'+DROP_FIELDS+'}}}}}',{id:dropId(b.sessionId),after});
  if(!d.session)throw failure('This DropMail inbox expired. Create a new address.',410);
  const c=d.session.mailsConnection;
  return json({messages:c.edges.map(e=>normalDrop(e.node)),total:c.totalCount,hasNext:c.pageInfo.hasNextPage,nextCursor:c.pageInfo.endCursor,expiresAt:d.session.expiresAt});
 }
 if(path==='/app/drop-read'){
  const d=await dropService(token,'query ($id: ID!) {node(id:$id) {... on Mail {'+DROP_FIELDS+' attachments {name}}}}',{id:dropId(b.id)});
  if(!d.node)throw failure('This message is no longer available.',404);
  return json({message:{...normalDrop(d.node),seen:true,hasAttachments:!!d.node.attachments?.length}});
 }
 throw failure('Unknown application action.',404);
}
function normalMessage(m){return {id:m.id,from:{name:m.from?.name||'',address:m.from?.address||''},subject:m.subject||'',intro:m.intro||'',seen:!!m.seen,isDeleted:!!m.isDeleted,createdAt:m.createdAt,hasAttachments:!!m.hasAttachments};}
function tokenFrom(request){const header=request.headers.get('Authorization')||'';if(!/^Bearer [A-Za-z0-9._~-]+$/.test(header)||header.length>6000)throw failure('Please reconnect to your inbox.',401);return header.slice(7);}
function idFrom(body){if(typeof body.id!=='string'||! /^[A-Za-z0-9_-]{1,150}$/.test(body.id))throw failure('Invalid message identifier.');return body.id;}
async function appAction(request,url){
 if(request.method!=='POST')return json({message:'Use this application from its website.'},405);
 // Origin is checked by the exported Worker handler before routing.
 if(!(request.headers.get('Content-Type')||'').startsWith('application/json'))return json({message:'Invalid request format.'},415);
 if(Number(request.headers.get('Content-Length')||0)>8192)return json({message:'Request too large.'},413);
 const text=await request.text();if(text.length>8192)return json({message:'Request too large.'},413);
 let b;try{b=JSON.parse(text||'{}');}catch{return json({message:'Invalid request.'},400);}
 if(!b||Array.isArray(b)||typeof b!=='object')return json({message:'Invalid request.'},400);
 try{
  if(url.pathname==='/app/health')return json({service:'rushi-mail-github-api',version:1});
  if(['/app/drop-options','/app/drop-create','/app/drop-check','/app/drop-read'].includes(url.pathname))return await dropAction(url.pathname,b,tokenFrom(request));
  if(url.pathname==='/app/options')return json({domains:await available()});
  if(url.pathname==='/app/create'){
   const domains=await available();const domain=b.domain||domains[0].domain;
   if(!domains.some(d=>d.domain===domain))throw failure('Please choose an available email domain.');
   if(typeof b.name!=='string'||! /^[a-z0-9][a-z0-9._-]{1,46}[a-z0-9]$/.test(b.name))throw failure('Choose a valid email name with 3–48 characters.');
   if(typeof b.password!=='string'||b.password.length<24||b.password.length>100)throw failure('Could not prepare inbox credentials. Reload and try again.');
   const account=await service('/accounts',{method:'POST',body:{address:b.name+'@'+domain,password:b.password}});
   return json({inbox:{id:account.id,address:account.address}},201);
  }
  if(url.pathname==='/app/connect'){
   if(typeof b.address!=='string'||b.address.length>254||!b.address.includes('@')||typeof b.password!=='string'||b.password.length>100)throw failure('Invalid saved inbox.');
   const session=await service('/token',{method:'POST',body:{address:b.address,password:b.password}});
   return json({token:session.token});
  }
  const token=tokenFrom(request);
  if(url.pathname==='/app/check'){
   const page=Number(b.page||1);if(!Number.isSafeInteger(page)||page<1||page>1000)throw failure('Invalid inbox page.');
   const d=await service('/messages?page='+page,{token});const messages=list(d).filter(m=>!m.isDeleted).map(normalMessage);
   const total=d['hydra:totalItems']??d.totalItems??messages.length;
   return json({messages,total,hasNext:!!d['hydra:view']?.['hydra:next']||page*30<total});
  }
  if(url.pathname==='/app/read'){
   const id=idFrom(b);const m=await service('/messages/'+id,{token});
   await service('/messages/'+id,{token,method:'PATCH',body:{seen:true}}).catch(()=>{});
   return json({message:{...normalMessage(m),text:m.text||'',html:Array.isArray(m.html)?m.html:[],seen:true}});
  }
  if(url.pathname==='/app/remove-message'){await service('/messages/'+idFrom(b),{token,method:'DELETE'});return json({deleted:true});}
  if(url.pathname==='/app/remove-inbox'){
   const me=await service('/me',{token});await service('/accounts/'+encodeURIComponent(me.id),{token,method:'DELETE'});return json({deleted:true});
  }
  return json({message:'Unknown application action.'},404);
 }catch(e){return json({message:e.message||'Unable to complete this action.'},e.status||500,e.status===429?{'Retry-After':'60'}:{});}
}

const READY_HTML = "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Rushi Mail connection ready</title><style>body{background:#101713;color:#f1f5ee;font:17px/1.7 system-ui;max-width:650px;padding:60px 24px;margin:auto}h1{color:#c5ef8b}code{word-break:break-all}button{padding:12px 18px;background:#c5ef8b;border:0;border-radius:10px}</style><h1>Your email connection is ready.</h1><p>Copy this page\u2019s address, return to your GitHub Pages website, choose <strong>Email setup</strong>, and paste it there.</p><p><code id=\"address\"></code></p><button id=\"copy\">Copy Worker address</button><p id=\"status\"></p><script>document.getElementById('address').textContent=location.origin;document.getElementById('copy').onclick=async()=>{try{await navigator.clipboard.writeText(location.origin);document.getElementById('status').textContent='Copied. Paste it into Email setup on your website.';}catch{document.getElementById('status').textContent='Select and copy the address above.';}};</script></html>";
// This is the GitHub account supplied for this project. No private keys belong here.
const DEFAULT_ALLOWED_ORIGIN = 'https://unsungstories-2626.github.io';
export default {
 async fetch(request,env={}) {
  const url=new URL(request.url),origin=request.headers.get('Origin');
  const allowed=String(env.ALLOWED_ORIGIN||DEFAULT_ALLOWED_ORIGIN).replace(/\/$/,'');
  if(!origin&&url.pathname==='/'&&['GET','HEAD'].includes(request.method))return new Response(request.method==='HEAD'?null:READY_HTML,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});
  if(origin!==allowed&&origin!==url.origin)return json({message:'This website is not allowed to use this Worker. Check ALLOWED_ORIGIN in the setup guide.'},403);
  const cors={'Access-Control-Allow-Origin':origin,'Vary':'Origin','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Expose-Headers':'Retry-After','Access-Control-Max-Age':'600'};
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  const response=url.pathname.startsWith('/app/')?await appAction(request,url):json({message:'Not found.'},404);
  const headers=new Headers(response.headers);for(const [key,value] of Object.entries(cors))headers.set(key,value);
  return new Response(response.body,{status:response.status,headers});
 }
};
