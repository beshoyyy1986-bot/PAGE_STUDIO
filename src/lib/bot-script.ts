// Script executed inside the Facebook inbox tab. It inserts the saved reply named "BM AUTO"
// (the tool's marker) and sends it. It refuses to send anything else.

export const SAVED_REPLY_MARKER = "BM AUTO";

export type BotStatus =
  | "sent"
  | "no_compose"
  | "blocked"
  | "name_mismatch"
  | "no_btn"
  | "no_marker_reply"
  | "compose_fail"
  | "no_send"
  | "send_fail";

export function buildBotScript(opts: { expectedName?: string; marker?: string }): string {
  const cfg = JSON.stringify({ expectedName: opts.expectedName ?? "", marker: opts.marker ?? SAVED_REPLY_MARKER });
  return String.raw`
(async () => {
  const cfg = ${cfg};
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const rnd = (a,b) => Math.floor(Math.random()*(b-a+1)+a);
  const react = () => wait(rnd(300,700));
  const norm = s => (s||'').replace(/\s+/g,' ').trim().toLowerCase();
  const out = (status, reason) => JSON.stringify({ status, reason });
  const esc = () => document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));

  let box = null;
  for (let i=0;i<30;i++){ box = document.querySelector('[contenteditable="true"][role="textbox"]'); if(box) break; await wait(400); }
  if (!box) return out('no_compose','مربع الكتابة لم يظهر');

  const bodyText = document.body.innerText;
  if (bodyText.includes('لا يمكنك الرد') || bodyText.includes("You can't reply")) return out('blocked','لا يمكن الرد على هذه المحادثة');

  if (cfg.expectedName && cfg.expectedName !== 'بدون اسم') {
    const first = norm(cfg.expectedName).split(' ')[0];
    if (first && !norm(bodyText).includes(first)) return out('name_mismatch','اسم العميل غير ظاهر في المحادثة المفتوحة');
  }

  const selectors = ['[aria-label*="إدراج رد محفوظ"]','[aria-label*="الردود المحفوظة"]','[aria-label*="Insert saved reply"]','[aria-label*="Saved replies"]','[aria-label*="saved repl" i]'];
  let savedBtn = null;
  for (const s of selectors){ try { savedBtn = document.querySelector(s); } catch(_){} if (savedBtn) break; }
  if (!savedBtn) return out('no_btn','زر الردود المحفوظة غير موجود');

  await react();
  savedBtn.click();

  const marker = norm(cfg.marker);
  let replyEl = null;
  for (let i=0;i<20 && !replyEl;i++){
    await wait(350);
    const cands = document.querySelectorAll('[role="menuitem"],[role="option"],[role="button"],[aria-label="Pressable"],li,div[tabindex]');
    for (const el of cands){
      const t = norm(el.innerText);
      if (t && t.length < 400 && t.includes(marker)) { replyEl = el; break; }
    }
  }
  if (!replyEl){ esc(); return out('no_marker_reply','الرد المحفوظ "'+cfg.marker+'" غير موجود'); }

  const before = box.innerText.trim();
  await react();
  replyEl.click();
  for (let i=0;i<20;i++){ await wait(250); const now = box.innerText.trim(); if (now !== before && now !== '') break; }
  if (box.innerText.trim() === before){ esc(); return out('compose_fail','نص الرد لم يُدرج'); }

  await wait(rnd(500,1200));
  let sendBtn = document.querySelector('[aria-label="إرسال"]') || document.querySelector('[aria-label="Send"]') || document.querySelector('[aria-label*="إرسال"]') || document.querySelector('[aria-label*="Send"]');
  if (!sendBtn){ for (const b of document.querySelectorAll('div[role="button"]')){ if (b.innerText==='إرسال'||b.innerText==='Send'){ sendBtn=b; break; } } }
  if (!sendBtn) return out('no_send','زر الإرسال غير موجود');

  const sentText = box.innerText.trim();
  await react();
  sendBtn.click();
  for (let i=0;i<20;i++){ await wait(300); const now = box.innerText.trim(); if (now==='' || now!==sentText) break; }
  if (box.innerText.trim() === sentText && sentText !== '') return out('send_fail','مربع الكتابة لم يُفرغ بعد الإرسال');
  return out('sent');
})()
`;
}
