// Console bridge script injected into every HTML preview response so that
// console.log/warn/error/info and uncaught errors are forwarded to the parent
// frame via postMessage, regardless of how the iframe is loaded.
const CONSOLE_BRIDGE_SCRIPT = `<script>(function(){
  var _o={log:console.log,warn:console.warn,error:console.error,info:console.info};
  function relay(lv,args){
    try{
      window.parent.postMessage({__mustaflow:true,level:lv,args:Array.prototype.slice.call(args).map(function(a){
        try{return typeof a==="object"?JSON.stringify(a):String(a);}catch(e){return String(a);}
      })},"*");
    }catch(_){}
  }
  console.log=function(){relay("log",arguments);_o.log.apply(console,arguments);};
  console.warn=function(){relay("warn",arguments);_o.warn.apply(console,arguments);};
  console.error=function(){relay("error",arguments);_o.error.apply(console,arguments);};
  console.info=function(){relay("info",arguments);_o.info.apply(console,arguments);};
  window.addEventListener("error",function(e){
    window.parent.postMessage({__mustaflow:true,type:"crash",level:"error",args:[(e.message||"Script error")+(e.filename?" ("+e.filename+":"+e.lineno+")":"")]},"*");
  });
  window.addEventListener("unhandledrejection",function(e){
    var m=e.reason&&e.reason.message?e.reason.message:String(e.reason);
    window.parent.postMessage({__mustaflow:true,type:"crash",level:"error",args:["Unhandled rejection: "+m]},"*");
  });
})();<\/script>`;

export function injectBridge(html: string): string {
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/(<head[^>]*>)/i, `$1${CONSOLE_BRIDGE_SCRIPT}`);
  }
  if (/<html[\s>]/i.test(html)) {
    return html.replace(/(<html[^>]*>)/i, `$1<head>${CONSOLE_BRIDGE_SCRIPT}</head>`);
  }
  return `<head>${CONSOLE_BRIDGE_SCRIPT}</head>${html}`;
}
