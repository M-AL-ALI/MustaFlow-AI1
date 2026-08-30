/**
 * Visual Edit Bridge (Task #539)
 *
 * Injected into authenticated owner preview HTML by either the API static
 * fallback or the runtime preview gateway. Published apps never receive it.
 * The script:
 *
 * 1. Walks the DOM after load and assigns each candidate element a stable
 *    `data-mfm-id` (path-based selector so the parent can deep-link back to
 *    the same node after reloads).
 * 2. Listens for a parent → child postMessage `{__mustaflow_edit:true, type}`
 *    to toggle visual-edit mode on/off and to apply optimistic patches
 *    (preview-only — server-side persistence is the parent's job).
 * 3. On click in edit-mode, sends `{__mustaflow_edit:true, type:"click", ...}`
 *    to the parent with the element's mfmId, current text content, color, and
 *    bounding rect (so the parent can render an inline toolbar positioned
 *    over the element).
 *
 * Deliberately dependency-free so it can be shared by the static preview and
 * streamed runtime preview paths. No separate browser build step is required:
 * the result is emitted as a literal <script> string.
 */
export const VISUAL_EDIT_SCRIPT = `<script>(function(){
  if (window.__MFM_VISUAL__) return; window.__MFM_VISUAL__ = true;
  var TRUSTED_PARENT_ORIGINS = [
    "https://www.mustaflow.com",
    "https://musta-flow-ai.replit.app",
    "http://localhost:5173",
    "http://127.0.0.1:5173"
  ];
  function isTrustedParent(ev){
    return ev.source === window.parent && TRUSTED_PARENT_ORIGINS.indexOf(ev.origin) !== -1;
  }
  function tellParent(payload){
    for (var i=0;i<TRUSTED_PARENT_ORIGINS.length;i++) {
      try { window.parent.postMessage(payload, TRUSTED_PARENT_ORIGINS[i]); } catch(_) {}
    }
  }
  var MODE = false; // visual-edit toggle
  var STYLE_ID = "__mfm_ve_style";
  function ensureStyle(){
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style"); s.id = STYLE_ID;
    s.textContent = "[data-mfm-id]{cursor:default}" +
      "html.__mfm_ve [data-mfm-id]:hover{outline:2px solid #8b5cf6 !important;outline-offset:1px;cursor:pointer !important}" +
      "html.__mfm_ve [data-mfm-id].__mfm_sel{outline:2px solid #6d28d9 !important;outline-offset:1px;background:rgba(139,92,246,0.08) !important}";
    document.head.appendChild(s);
  }
  function pathOf(el){
    // Build a CSS-path-ish id like "body>div:nth-child(2)>h1" — stable across reloads
    // as long as the DOM structure hasn't changed.
    if (!el || el === document.body) return "body";
    var parts = []; var node = el;
    while (node && node !== document.body && node.parentNode) {
      var name = node.nodeName.toLowerCase();
      var parent = node.parentNode;
      var idx = 1;
      if (parent && parent.children) {
        for (var i=0;i<parent.children.length;i++){
          if (parent.children[i] === node) { idx = i+1; break; }
        }
      }
      parts.unshift(name + ":nth-child(" + idx + ")");
      if (parts.length > 8) break;
      node = parent;
    }
    return "body>" + parts.join(">");
  }
  function isCandidate(el){
    if (!el || el.nodeType !== 1) return false;
    var skip = ["SCRIPT","STYLE","HEAD","META","LINK","TITLE","NOSCRIPT","HTML","BODY"];
    if (skip.indexOf(el.nodeName) !== -1) return false;
    // Must have either direct text or be a leaf-ish container with a colour.
    var txt = (el.textContent || "").trim();
    if (txt.length > 0) return true;
    return ["IMG","SVG","VIDEO","CANVAS","INPUT","BUTTON","A"].indexOf(el.nodeName) !== -1;
  }
  function annotateAll(){
    var all = document.body ? document.body.querySelectorAll("*") : [];
    for (var i=0;i<all.length;i++){
      var el = all[i];
      if (!isCandidate(el)) continue;
      if (el.hasAttribute("data-mfm-id")) continue;
      try { el.setAttribute("data-mfm-id", pathOf(el)); } catch(_) {}
    }
  }
  function onClick(e){
    if (!MODE) return;
    var el = e.target;
    while (el && el !== document.body && !el.hasAttribute("data-mfm-id")) el = el.parentNode;
    if (!el || el === document.body) return;
    e.preventDefault(); e.stopPropagation();
    var additive = !!e.shiftKey;
    if (!additive) {
      var previous = document.querySelectorAll(".__mfm_sel");
      for (var p=0;p<previous.length;p++) previous[p].classList.remove("__mfm_sel");
    }
    if (additive && el.classList.contains("__mfm_sel")) el.classList.remove("__mfm_sel");
    else el.classList.add("__mfm_sel");
    var rect = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    var payload = {
      __mustaflow_edit: true,
      type: "click",
      additive: additive,
      selected: el.classList.contains("__mfm_sel"),
      mfmId: el.getAttribute("data-mfm-id"),
      tag: el.nodeName.toLowerCase(),
      text: (el.textContent || "").trim().slice(0, 500),
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      padding: cs.padding,
      margin: cs.margin,
      width: cs.width,
      height: cs.height,
      display: cs.display,
      textAlign: cs.textAlign,
      fontFamily: cs.fontFamily,
      fontWeight: cs.fontWeight,
      href: typeof el.href === "string" ? el.getAttribute("href") || "" : "",
      src: typeof el.src === "string" ? el.getAttribute("src") || "" : "",
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
    };
    tellParent(payload);
  }
  function setMode(on){
    MODE = !!on;
    if (MODE) { document.documentElement.classList.add("__mfm_ve"); }
    else {
      document.documentElement.classList.remove("__mfm_ve");
      var previous = document.querySelectorAll(".__mfm_sel");
      for (var p=0;p<previous.length;p++) previous[p].classList.remove("__mfm_sel");
    }
  }
  function applyOptimistic(msg){
    if (!msg || !msg.mfmId) return;
    var el = document.querySelector('[data-mfm-id="' + msg.mfmId.replace(/"/g,'\\\\"') + '"]');
    if (!el) return;
    if (msg.action === "setText" && typeof msg.text === "string") el.textContent = msg.text;
    else if (msg.action === "setColor" && typeof msg.color === "string") el.style.color = msg.color;
    else if (msg.action === "setBackgroundColor" && typeof msg.color === "string") el.style.backgroundColor = msg.color;
    else if (msg.action === "setPadding" && typeof msg.padding === "string") el.style.padding = msg.padding;
    else if (msg.action === "setStyle" && typeof msg.property === "string" && typeof msg.value === "string") el.style[msg.property] = msg.value;
    else if (msg.action === "setAttribute" && typeof msg.attribute === "string" && typeof msg.value === "string") el.setAttribute(msg.attribute, msg.value);
    else if (msg.action === "move" && (msg.direction === "up" || msg.direction === "down")) {
      var sibling = msg.direction === "up" ? el.previousElementSibling : el.nextElementSibling;
      if (sibling && el.parentNode) {
        if (msg.direction === "up") el.parentNode.insertBefore(el, sibling);
        else el.parentNode.insertBefore(sibling, el);
      }
    }
    else if (msg.action === "delete") { if (el.parentNode) el.parentNode.removeChild(el); }
  }
  function describePoint(msg){
    if (!msg || typeof msg.x !== "number" || typeof msg.y !== "number") return;
    var el = document.elementFromPoint(msg.x, msg.y);
    if (!el) return;
    var rect = el.getBoundingClientRect();
    try {
      tellParent({
        __mustaflow_edit: true,
        type: "pointContext",
        requestId: msg.requestId,
        mfmId: el.getAttribute("data-mfm-id") || pathOf(el),
        tag: el.nodeName.toLowerCase(),
        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
      });
    } catch(_) {}
  }
  window.addEventListener("message", function(ev){
    if (!isTrustedParent(ev)) return;
    var d = ev.data; if (!d || typeof d !== "object" || !d.__mustaflow_edit) return;
    if (d.type === "setMode") {
      setMode(d.on);
      tellParent({__mustaflow_edit:true,type:"modeApplied"});
    }
    else if (d.type === "apply") applyOptimistic(d);
    else if (d.type === "describePoint") describePoint(d);
  });
  function init(){
    ensureStyle(); annotateAll();
    document.addEventListener("click", onClick, true);
    // Re-annotate on DOM mutations (SPA renders, dynamic content)
    if (window.MutationObserver) {
      var mo = new MutationObserver(function(){ annotateAll(); });
      mo.observe(document.body, { childList: true, subtree: true });
    }
    tellParent({__mustaflow_edit:true,type:"ready"});
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();</script>`;
