// early-final: a GPT final answer that promises more work instead of doing it
// (plan docs/superpowers/plans/2026-11-09-completion-guard-v2.md §3).
//
// Pure functions only: the education hook owns state, budgets and logging.
// The classifier is deliberately biased towards letting a final through. A
// missed early final costs the user one "continue"; a wrong block pushes the
// model past a gate the user asked it to hold, which is what the legacy guard
// did (7 of its 94 blocks led to unauthorized actions).

const TAIL_CHARS = 400;
const PROMISE_CHARS = 120;

// A compaction summary or task capsule emitted as the final. Continuing from
// it means acting on the capsule's next_action without the user (hist-020).
const SUMMARY = /<\/summary>|<summary>|\[\/?AIRKIT_TASK_CAPSULE\]/;

// Work the model says it will do next, in the closing paragraph.
const PROMISE = new RegExp([
  String.raw`我(?:現在|接著|隨後|馬上|立即|立刻)?(?:會|將|要)(?:先|繼續|再|接著|立即|立刻|馬上|直接)?(?!等|在|是|選|建議|推薦|把這份)`,
  String.raw`我正在`,
  String.raw`我(?:這就|現在就)?(?:去|來)(?:查|看|跑|改|修|補|確認|驗證|處理)`,
  String.raw`接下來(?:我)?(?:會|將|要|先|回到)`,
  String.raw`下一步(?:我)?(?:會|將|是|應|先|要|就)`,
  String.raw`下一個(?:具體)?(?:驗證點|證據點|步驟|動作|先)`,
  String.raw`我可以下一步`,
  String.raw`\bI(?:'ll| will| am going to)\s+(?:now|next|then|continue|proceed|go ahead|start|keep|re-?run|check|verify|fix|update|look|investigate|finish)\b`,
  String.raw`\b(?:Next|Now),?\s+I(?:'ll| will)\b`,
  String.raw`\bLet me (?:now |next )?(?:check|verify|run|look|fix|update|investigate|confirm|try|re-?run)\b`,
].join("|"), "i");

// The final itself says the work is not finished.
const INCOMPLETE = /(?:收尾|工作|任務|驗證|修正|部分)?(?:尚未|還沒有?|仍未)(?:全部)?完成|not (?:yet )?(?:finished|complete|done)\b/i;

// The model says it is waiting for something to come back.
const WAIT = /我會等|等待?.{0,24}(?:結果|完成|回報|回傳|回來)(?:再|後|才)|(?:仍在|還在|正在)(?:執行|跑|進行|查核)(?!的)|待.{0,16}(?:完成|回報|回傳)後|\bwaiting (?:for|on)\b|\bI(?:'ll| will) wait\b|\bonce .{0,40}(?:finishes|completes|returns)\b/i;

// Finals that end the turn on purpose. Any hit lets the final through.
const VETOES = Object.freeze([
  ["question", /[？?]\s*(?:\*\*)?\s*$|要不要|是否要|要我.{0,30}嗎|你要.{0,24}還是|請(?:你|您)?(?:選擇?|擇一|決定|確認是否)|哪一(?:個|種|項)|\b(?:do you want|would you like|should I|shall I|let me know)\b/i],
  ["authorization", /請允許|允許後|放行|授權後|核准後|批准後|請(?:先)?(?:授權|核准|批准)|需要(?:你|您)?.{0,12}(?:授權|核准|批准|MFA|OTP|登入)|\bMFA\b|\bOTP\b|\b(?:approve|approval|authori[sz]ation|permission) (?:is )?(?:needed|required)\b|\bplease (?:approve|allow|grant)\b/i],
  ["user-action", /請(?:先)?(?:在.{0,10})?執行|請在.{0,10}(?:終端|terminal)|完成後(?:回|告訴|通知)我|(?:執行|跑)完?後(?:回|告訴|通知)我|再告訴我|請(?:把|將).{0,40}(?:關掉|打開|設定|改|調整)|請調整.{0,12}權限|請提供|\bplease run\b|\brun (?:this|the following)\b|\blet me know when\b/i],
  ["phase-gate", /到此(?:為止|停止|暫停|告一段落)|這一?階段.{0,10}(?:完成|結束|停止)|(?:接下來|先|改為)?等(?:你|您)?的?.{0,6}(?:審查|審核|review|核准|批准|確認|決定|指示|指令)|交由(?:你|您)|由(?:你|您)決定|待(?:你|您)|\bstop(?:ping)? here\b|\b(?:pending|awaiting) (?:your )?(?:review|approval|decision)\b/i],
  ["offer", /若(?:你|您)(?:要|需要|想|同意|確認|決定)|如果(?:你|您)(?:要|需要|想|同意|確認)|若要|如果要|要的話|\bif you (?:want|would like|'d like|need|approve|agree)\b/i],
  ["not-acting", /我(?:尚未|還沒|沒有)(?:操作|執行|動手|down|合併|送出|套用|apply|sync)|不會(?:自行|擅自|主動)|未經.{0,8}(?:同意|授權|核准)前?不/i],
  ["blocker", /被(?:權限.{0,8})?(?:拒絕|擋|阻擋)|遭(?:到)?拒|權限不足|已過期|無法(?:存取|連線|連到|取得|登入|驗證身分)|\b(?:denied|forbidden|unauthori[sz]ed|expired|blocked by)\b/i],
]);

// A handed-over command: a fenced block of shell the final shows instead of
// running. The opening fence may sit before the 400-char tail.
const SHELL_FENCE = /```(?:bash|sh|shell|zsh|console)\n/;
const SHELL_LINE = /^\s*(?:[$!] |(?:bash|sh|aws(?:-vault)?|kubectl|helm|terraform|git|glab|gh|npm|npx|node|chmod|curl|psql|mysql|docker|devops|twg|acli|ccr|airkit|airclaude)\s)/m;

// Next steps that write somewhere the user has not cleared: they need a yes.
const WRITE_STEP = /轉\s*Ready|\bReady\b|合併|\bmerge\b|\bsync\b|\bapply\b|\bpush\b|推送|部署|\bdeploy\b|發布|\brelease\b|建立\s*(?:MR|PR)|刪除(?![前後時])|\bdelete\b|送出|留言|\bpost\b|rollout|重啟|restart/i;
// The stated next step touches production (plan §6 item 7, policy B).
const PRODUCTION = /production|\bprod\b|正式環境|正式站|線上環境/i;

function paragraphs(text) {
  return text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
}

const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)、])\s/;

// The closing paragraph, plus its lead-in when that is a heading or ends with
// a colon ("**下一個具體驗證點**", "接下來我會："). A lead-in followed by prose
// or a quote rather than a list is a promise already kept ("我會改成：> …").
function closingWindow(text) {
  const parts = paragraphs(text);
  if (parts.length === 0) return { closing: "", fulfilled: false };
  const last = parts.at(-1);
  const previous = parts.at(-2);
  if (!previous) return { closing: last, fulfilled: false };
  if (/[:：]\s*(?:\*\*)?$/.test(previous)) {
    return { closing: `${previous}\n${last}`, fulfilled: !LIST_ITEM.test(last) };
  }
  if (previous.length <= 40) return { closing: `${previous}\n${last}`, fulfilled: false };
  return { closing: last, fulfilled: false };
}

// The clause carrying a match: from the previous clause break to the next.
function clauseAt(text, index) {
  const breaks = /[。！；;\n]|[.!](?:\s|$)/g;
  let start = 0;
  let end = text.length;
  for (const match of text.matchAll(breaks)) {
    if (match.index < index) start = match.index + match[0].length;
    else {
      end = match.index;
      break;
    }
  }
  return text.slice(start, end).trim();
}

// Promise clauses go into logs and the continuation prompt, so they carry no
// URLs, paths, tokens or long hex.
export function redactPromise(text) {
  return String(text ?? "")
    .replaceAll(/[\u0000-\u001f\u007f]+/g, " ")
    .replaceAll(/https?:\/\/\S+/gi, "[url]")
    .replaceAll(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replaceAll(/\b(?:sk-|ghp_|glpat-|xox[baprs]-)[A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .replaceAll(/\b[A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)\s*[:=]\s*\S+/g, "[redacted]")
    .replaceAll(/(?:~|\.{0,2})\/[\w.@-]+(?:\/[\w.@-]+)+/g, "[path]")
    .replaceAll(/\b[0-9a-f]{12,}\b/gi, "[hex]")
    .replaceAll(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "[email]")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, PROMISE_CHARS);
}

function vetoesIn(tail, closing) {
  const hits = [];
  for (const [name, pattern] of VETOES) {
    // Questions only count where the turn ends; the rest anywhere in the tail.
    if (pattern.test(name === "question" ? closing : tail)) hits.push(name);
  }
  if (SHELL_FENCE.test(tail) || (tail.includes("```") && SHELL_LINE.test(tail))) hits.push("hands-command");
  return hits;
}

/**
 * Decide whether a final answer stopped early.
 *
 * @param {string} text the final assistant message
 * @param {{ backgroundRunning?: number, production?: "gate" | "allow" }} options
 *   backgroundRunning: background agents, workflows or shells still running;
 *   production: "gate" (default) lets a final through when its promised next
 *   step touches production, "allow" treats it like any other step.
 * @returns {{ decision: "allow" | "continue", reason: string, promise: string | null, vetoes: string[] }}
 */
export function classifyEarlyFinal(text, { backgroundRunning = 0, production = "gate" } = {}) {
  const full = String(text ?? "").replaceAll("\r\n", "\n");
  const tail = full.slice(-TAIL_CHARS);
  const allow = (reason, promise = null, vetoes = []) => ({ decision: "allow", reason, promise, vetoes });
  if (!tail.trim()) return allow("empty");
  if (SUMMARY.test(tail)) return allow("post-compact-summary");
  const { closing, fulfilled } = closingWindow(tail);
  const promiseMatch = PROMISE.exec(closing);
  const incompleteMatch = promiseMatch ? null : INCOMPLETE.exec(closing);
  const waitMatch = WAIT.exec(closing);
  const match = promiseMatch ?? incompleteMatch ?? waitMatch;
  if (!match) return allow("no-promise");
  const clause = clauseAt(closing, match.index);
  const promise = redactPromise(clause);
  if (backgroundRunning > 0) return allow("background-running", promise);
  if (fulfilled && promiseMatch && match.index < closing.indexOf("\n")) return allow("promise-fulfilled-inline", promise);
  const vetoes = vetoesIn(tail, closing);
  if (vetoes.length > 0) return allow("veto", promise, vetoes);
  if (WRITE_STEP.test(clause)) return allow("next-step-write", promise);
  if (production !== "allow" && PRODUCTION.test(clause)) return allow("production-gate", promise);
  if (WAIT.test(clause)) return { decision: "continue", reason: "phantom-wait", promise, vetoes };
  return { decision: "continue", reason: promiseMatch ? "promise" : "admitted-incomplete", promise, vetoes };
}

/**
 * The Stop reason Claude Code feeds back to the model. It only re-opens the
 * step the model already promised and the user already authorized.
 */
export function earlyFinalReason(promise, { phantomWait = false } = {}) {
  const quoted = redactPromise(promise) || "（未擷取到）";
  const opening = phantomWait
    ? `你的回覆說在等待結果（「${quoted}」），但目前沒有任何背景工作還在執行。`
    : `你的回覆在結尾承諾了還沒做的下一步：「${quoted}」。`;
  return [
    opening,
    "只做這一步，而且只在它屬於使用者已經要求並授權的範圍內；不要擴大範圍，不要開始新的工作。",
    "不要執行 production、破壞性、或使用者尚未核准的寫入動作（merge、apply、sync、deploy、刪除、對外發布）。",
    "如果這一步需要授權、使用者動作或決定，直接結束這一輪，明確提出請求或問題，不要自行繞過。",
    "如果做不到，說清楚卡在哪裡；如果其實已經完成，用證據回報即可。",
  ].join("\n");
}
