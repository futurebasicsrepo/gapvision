(function(){
"use strict";
var RM = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
var $ = function(s,r){return (r||document).querySelector(s)};
var $$ = function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s))};
var P = new URLSearchParams(location.search);

/* ── decode on arrival ────────────────────────────────────────
   Per-character scramble → settle, grouped into per-word spans that
   carry white-space:nowrap, because bare per-character inline-blocks
   break words mid-word at a wrap point. Timeout backstop included:
   in a background tab rAF never fires and text must settle to its
   real value rather than sit on noise. */
var CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789·%$/+-";
function decode(el){
  if (el.dataset.done) return; el.dataset.done = "1";
  var text = el.textContent, settled = false;
  if (RM) return;
  var words = text.split(/(\s+)/);
  el.textContent = "";
  var spans = [];
  words.forEach(function(w){
    if (/^\s+$/.test(w)) { el.appendChild(document.createTextNode(w)); return; }
    var s = document.createElement("span");
    s.style.whiteSpace = "nowrap"; s.textContent = w; el.appendChild(s); spans.push(s);
  });
  var chars = [];
  spans.forEach(function(s){
    var w = s.textContent; s.textContent = "";
    for (var i=0;i<w.length;i++){
      var c = document.createElement("span"); c.dataset.f = w[i];
      c.textContent = /\S/.test(w[i]) ? CHARSET[(Math.random()*CHARSET.length)|0] : w[i];
      s.appendChild(c); chars.push(c);
    }
  });
  var t0 = performance.now(), DUR = 430, STAG = 26, TICK = 44, last = 0;
  function settle(){ chars.forEach(function(c){c.textContent=c.dataset.f;c.style.color=""}); settled=true; }
  function frame(now){
    if (settled) return;
    var done = true;
    if (now - last > TICK){
      last = now;
      chars.forEach(function(c,i){
        var t = now - t0 - i*STAG;
        if (t < 0){ done = false; return; }
        if (t < DUR){
          done = false;
          c.textContent = /\S/.test(c.dataset.f) ? CHARSET[(Math.random()*CHARSET.length)|0] : c.dataset.f;
        } else if (c.textContent !== c.dataset.f){
          c.textContent = c.dataset.f;
          c.style.color = "var(--sea2)";              /* the lit flash as it lands — sea, not green: green is the lens's */
          setTimeout(function(){ c.style.color = ""; }, 150);
        }
      });
    } else { done = false; }
    if (done) settled = true; else requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  setTimeout(settle, DUR + chars.length*STAG + 900);   /* backstop */
}

/* ── counters ─────────────────────────────────────────────── */
function count(el){
  if (el.dataset.done) return; el.dataset.done = "1";
  var to = parseFloat(el.dataset.count), pre = el.dataset.prefix||"", suf = el.dataset.suffix||"";
  if (RM){ el.textContent = pre + to + suf; return; }
  var t0 = performance.now(), D = 1100;
  function step(now){
    var p = Math.min(1,(now-t0)/D), e = 1 - Math.pow(1-p,3);
    el.textContent = pre + Math.round(to*e) + suf;
    if (p < 1) requestAnimationFrame(step); else el.textContent = pre + to + suf;
  }
  requestAnimationFrame(step);
  setTimeout(function(){ el.textContent = pre + to + suf; }, D + 600);
}

/* ── arrival observer ─────────────────────────────────────── */
var io = new IntersectionObserver(function(es){
  es.forEach(function(e){
    if (!e.isIntersecting) return;
    var s = e.target; s.classList.add("in");
    $$("[data-decode]", s).forEach(decode);
    $$("[data-count]", s).forEach(count);
    $$(".fill", s).forEach(function(f){ f.style.width = f.dataset.w + "%"; });
    $$(".arr .b", s).forEach(function(b){ b.style.height = b.dataset.h + "%"; });
    io.unobserve(s);
  });
}, { threshold: 0.14, rootMargin: "0px 0px -8% 0px" });
$$("section").forEach(function(s){ io.observe(s); });
$$(".hero [data-decode]").forEach(decode);

/* ── section label in the bar + scroll progress ───────────── */
var secs = $$("section[data-sec]"), label = $("#secLabel"), prog = $("#prog");
var ticking = false;
function onScroll(){
  if (ticking) return; ticking = true;
  requestAnimationFrame(function(){
    ticking = false;
    var y = window.scrollY, h = document.documentElement.scrollHeight - innerHeight;
    prog.style.width = (h > 0 ? (y/h)*100 : 0) + "%";
    var cur = secs[0];
    secs.forEach(function(s){ if (s.getBoundingClientRect().top <= innerHeight*0.45) cur = s; });
    var t = cur.dataset.sec;
    if (label.textContent !== t) label.textContent = t;
    room();
  });
}

/* ── the pinned room: scroll changes the cue ──────────────────
   Progress is read from the section's own geometry rather than
   written per frame from JS style writes. */
var ROOMS = window.CUE_ROOMS || [];
var pin = ROOMS.length ? $("#rooms") : null, rl = $$("[data-rl]"), cur = -1;
function setRoom(i){
  if (i === cur) return; cur = i;
  var r = ROOMS[i];
  $("#rTag").textContent = r.tag; $("#rLat").textContent = r.lat;
  $("#rName").textContent = r.name; $("#rMod").textContent = r.mod;
  $("#rZone").textContent = r.zone; $("#rIdx").textContent = r.idx;
  $("#rFacts").innerHTML = r.facts.map(function(f){return "<li>"+f+"</li>"}).join("");
  rl.forEach(function(el,n){
    el.textContent = r.lines[n] || "";
    if (RM) return;
    el.style.opacity = "0"; el.style.transform = "translateY(4px)";
    el.style.transition = "none";
    setTimeout(function(){
      el.style.transition = "opacity .34s ease " + (n*70) + "ms, transform .34s ease " + (n*70) + "ms";
      el.style.opacity = "1"; el.style.transform = "none";
    }, 20);
  });
  $$(".step").forEach(function(s){ s.classList.toggle("on", +s.dataset.step === i); });
}
function room(){
  if (!pin) return;
  var r = pin.getBoundingClientRect(), span = pin.offsetHeight - innerHeight;
  if (span <= 0) return;
  var p = Math.min(1, Math.max(0, -r.top / span));
  setRoom(Math.min(ROOMS.length-1, Math.floor(p * ROOMS.length)));
}
$$(".step").forEach(function(s){
  s.addEventListener("click", function(){
    var i = +s.dataset.step, span = pin.offsetHeight - innerHeight;
    window.scrollTo({ top: pin.offsetTop + span * (i/ROOMS.length) + 40, behavior: RM ? "auto" : "smooth" });
  });
});
addEventListener("scroll", onScroll, { passive:true });
addEventListener("resize", onScroll);
onScroll();

/* ── hero lens: the deck's own product, cycling three cues once ── */
var HERO = window.CUE_HERO || [];
(function heroCycle(){
  if (RM || !HERO.length) return;
  var lens = $("#heroLens"); if (!lens) return;
  var lines = $$(".l-line", lens), tag = $(".l-card .t", lens),
      foot = $$(".l-foot span", lens), i = 0, shown = 0;
  var timer = setInterval(function(){
    if (document.hidden) return;
    if (++shown > 8) { clearInterval(timer); return; }   /* nothing loops forever */
    i = (i+1) % HERO.length;
    tag.textContent = "CUE · " + (i+1) + "/3";
    foot[1].textContent = (i+1) + "/3";
    lines.forEach(function(el,n){
      el.style.transition = "none"; el.style.opacity = ".15";
      setTimeout(function(){
        el.textContent = HERO[i][n];
        el.style.transition = "opacity .3s ease " + (n*60) + "ms";
        el.style.opacity = "1";
      }, 120 + n*60);
    });
  }, 4200);
})();

/* ── who this was prepared for ────────────────────────────── */
var to = P.get("to");
if (to){
  var f = $("#forwho");
  f.textContent = "Prepared for " + to.slice(0,60);
  f.classList.add("on");
}

/* ── share sheet ──────────────────────────────────────────────
   The link is built client-side. It carries a recipient and a gate
   flag; it is a lead gate, not authentication — anyone with the URL
   can strip the parameter. Say that out loud rather than implying
   the deck is protected. */
var shareScrim = $("#shareScrim"), shareTo = $("#shareTo"), shareGate = $("#shareGate"), shareLink = $("#shareLink");
function buildLink(){
  var u = new URL(location.href.split("?")[0].split("#")[0]);
  if (shareTo.value.trim()) u.searchParams.set("to", shareTo.value.trim());
  if (shareGate.checked) u.searchParams.set("gate", "1");
  u.searchParams.set("src", "share");
  shareLink.textContent = u.toString();
  return u.toString();
}
$("#shareBtn").addEventListener("click", function(){ buildLink(); shareScrim.classList.add("on"); shareTo.focus(); });
$("#closeShare").addEventListener("click", function(){ shareScrim.classList.remove("on"); });
shareScrim.addEventListener("click", function(e){ if (e.target === shareScrim) shareScrim.classList.remove("on"); });
[shareTo, shareGate].forEach(function(el){ el.addEventListener("input", buildLink); });
$("#copyLink").addEventListener("click", function(){
  var link = buildLink();
  var done = function(){ $("#copied").classList.add("on"); setTimeout(function(){ $("#copied").classList.remove("on"); }, 1800); };
  if (navigator.clipboard) navigator.clipboard.writeText(link).then(done, done);
  else { var t = document.createElement("textarea"); t.value = link; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); done(); }
});
if (navigator.share){
  var ns = $("#nativeShare"); ns.hidden = false;
  ns.addEventListener("click", function(){
    navigator.share({ title: "cuesea — pre-seed", text: "The floor's request-and-answer loop.", url: buildLink() }).catch(function(){});
  });
}
addEventListener("keydown", function(e){ if (e.key === "Escape") shareScrim.classList.remove("on"); });

/* ── email gate ───────────────────────────────────────────── */
var gateScrim = $("#gateScrim");
var SEEN = "cuesea.deck.lead";
function openGate(){
  document.body.classList.add("gated");
  gateScrim.classList.add("on");
  document.body.style.overflow = "hidden";
  setTimeout(function(){ $("#gName").focus(); }, 350);
}
function passGate(lead){
  try { localStorage.setItem(SEEN, JSON.stringify(lead)); } catch(e){}
  document.body.classList.remove("gated");
  gateScrim.classList.remove("on");
  document.body.style.overflow = "";
}
if (P.get("gate") === "1"){
  var prior = null;
  try { prior = JSON.parse(localStorage.getItem(SEEN) || "null"); } catch(e){}
  if (!prior) openGate();
}
$("#gateGo").addEventListener("click", function(){
  var name = $("#gName").value.trim(), email = $("#gEmail").value.trim(), firm = $("#gFirm").value.trim();
  var ok = /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(email);
  if (!ok || !name){ $("#gateErr").classList.add("on"); return; }
  $("#gateErr").classList.remove("on");
  /* `deck` and `token` ride along because without them a lead is only
     "somebody opened a gated deck". With them it is "Reformation opened the
     link sent on Tuesday", which is the difference between a number and a
     follow-up. Both are read from where we already are rather than configured:
     the path says which deck, and `?t=` is the link's own token. */
  var deck = location.pathname.indexOf("fundraise") !== -1 ? "fundraise" : "floor";
  var lead = { deck:deck, name:name, email:email, firm:firm,
               preparedFor:P.get("to")||"", to:P.get("to")||"",
               token:P.get("t")||"", at:new Date().toISOString(),
               ref:document.referrer||"" };
  /* Best effort. If the endpoint is absent the deck still opens — a gate that
     traps a real investor behind a 500 costs more than a missed lead. */
  try {
    fetch("/api/lead", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(lead) }).catch(function(){});
  } catch(e){}
  passGate(lead);
});
$$("#gateScrim input").forEach(function(i){ i.addEventListener("keydown", function(e){ if (e.key === "Enter") $("#gateGo").click(); }); });

/* ── PDF: the file when it is deployed beside this page, the browser's own
      print-to-PDF when it is not. A 404 on a link an investor just clicked is
      worse than a print dialog. ─────────────────────────────────────────── */
(function(){
  var pdf = document.documentElement.getAttribute('data-pdf');
  var links = pdf ? $$('a[href="' + pdf + '"]') : [];
  if (!links.length) return;
  fetch(pdf, { method:"HEAD" }).then(function(r){
    if (r.ok) return;
    throw 0;
  }).catch(function(){
    links.forEach(function(a){
      a.removeAttribute("download"); a.setAttribute("href","#");
      a.addEventListener("click", function(e){ e.preventDefault(); window.print(); });
    });
  });
})();

/* stamp */
$("#stamp").textContent = new Date().toLocaleDateString("en-GB", { month:"long", year:"numeric" });
})();
