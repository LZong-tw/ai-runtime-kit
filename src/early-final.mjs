// early-final: a GPT final answer that promises more work instead of doing it
// (plan docs/superpowers/plans/2026-11-09-completion-guard-v2.md §3).
//
// Pure functions only: the education hook owns state, budgets and logging.
// The classifier is deliberately biased towards letting a final through. A
// missed early final costs the user one "continue"; a wrong block pushes the
// model past a gate the user asked it to hold, which is what the legacy guard
// did (7 of its 94 blocks led to unauthorized actions).
//
// So a final only continues when its promised step is local workspace work
// (read, check, run tests, edit): the verb has to be on an allowlist, and the
// step must not name anything destructive, external or production. Listing
// the unsafe steps instead would never be finished.

const PROMISE_CHARS = 120;
// A promise can sit above a sign-off, a status paragraph or a long table.
const SCAN_PARAGRAPHS = 3;

// A compaction summary or task capsule emitted as the final. Continuing from
// it means acting on the capsule's next_action without the user (hist-020).
const SUMMARY = /<\/summary>|<summary>|\[\/?AIRKIT_TASK_CAPSULE\]/;

// Work the model says it will do next. Only the marker: whether the step is
// workspace work is decided by WORK_STEP below.
const PROMISE = new RegExp([
  String.raw`(?:我們|咱們|我)(?:現在|接著|隨後|馬上|立即|立刻|這就|現在就|就|也)?(?:會|將|要(?!求)|先(?!前)|再(?!次)|繼續|來|去(?!年)|正在|打算|準備)`,
  String.raw`接下來|下一步|下一個(?:具體)?(?:驗證點|證據點|步驟|動作|先)|我可以下一步`,
  String.raw`\b(?:I|we)(?:['’]ll|\s+will|['’]m going to|\s+am going to|['’]re going to|\s+are going to)\b`,
  String.raw`\b(?:Next|Now|Then),?\s+(?:I|we)\b`,
  String.raw`\bLet me\b`,
].join("|"), "i");

// What stands between the marker and the verb: "接下來我會", "Next, I'll".
const LEAD = /^[\s,，:：*_]*(?:(?:我們|我|\bwe\b|\bI\b)\s*)?(?:(?:現在|接著|就|也|會|將|要|是|應該?|先|再|可以|\b(?:now|next|then|also|just|will|am going to|is to)\b|['’]ll)\s*)*/i;

// A promise whose verb is talk, not work: "我要提醒", "I'll keep that in mind".
const NOT_WORK = /^(?:不是|並非|選|挑|提醒|建議|推薦|說明|強調|記得|記住|分享|解釋|說|講|想|覺得|認為|希望|keep|remember|note|mention|recommend|suggest|say|think|hope|pick|choose|go with|apologi[sz]e|know)/i;

// Local, reversible workspace steps. A promise continues only with one of these.
const WORK_STEP = new RegExp([
  "讀|看|查|檢查|追|核對|比對|確認|驗證|測試|跑|執行|修|改|補|更新|整理|彙整|回報|處理|實作|重構|撰寫|寫|新增|加上|調整|搜尋|找|分析|排查|定位|研究|釐清|收斂|審查|重現|編譯|回顧|觀察|列出|盤點|對照|檢視",
  String.raw`\b(?:read|check|verify|inspect|look|investigate|run|re-?run|test|fix|update|edit|change|add|write|implement|refactor|compare|summari[sz]e|report|review|debug|reproduce|trace|search|grep|scan|build|lint|finish|continue|proceed|start|address|handle|clean up|tidy|confirm|validate|examine|audit|draft|patch|correct|resolve|try|re-?check|measure|analy[sz]e)\b`,
].join("|"), "i");

// Steps that write somewhere the user has not cleared, destroy something,
// reach outside the workspace or cost money. Any hit lets the final through.
// A Chinese verb followed by 的/了/過 is attributive or past ("刪除的那段").
const UNSAFE_STEP = new RegExp([
  String.raw`(?:合併(?!衝突)|刪(?!除)|部署|上線|發布|發佈|上架|推送|推上|套用|同步|刪除|刪掉|移除|清除|清空|覆寫|覆蓋|回滾|還原|重啟|重新啟動|停機|停用|遷移|解除安裝|全域安裝|輪換|撤銷|開票|開單|建單|留言|送出|寄出|寄信|發信|發送|通知|對外|擴容|縮容|付費|計費|開\s*(?:MR|PR)|建立\s*(?:MR|PR))(?![的了過前後時])`,
  String.raw`\b(?:merge(?!\s*(?:conflict|request))|deploy|release|publish|ship|push|apply|sync|delete|remove|uninstall|rm|drop|truncate|destroy|purge|wipe|overwrite|rollback|roll back|revert|restart|reboot|shutdown|kill|scale|migrate|migration|rotate|revoke|send|post|e-?mail|notify|rollout|roll out|chmod|chown|sudo|paid|billable|Jira|Slack|ticket)\b`,
  String.raw`install\s+-g|reset\s+--hard|--force\b|force[- ]push|--write\b|--replicas|live probe|轉\s*Ready|(?:標|設|改)(?:成|為)\s*Ready|\bmark\b.{0,20}\bready\b`,
].join("|"), "i");

// The stated next step touches production (plan §6 item 7, policy B).
const PRODUCTION = /production|\bprod\b|\bprd\b|生產環境|正式(?:環境|站|機|區|服)|線上\s*(?:環境|叢集|cluster|服務|機器|機|DB|資料庫|站)|\blive\s+(?:cluster|env(?:ironment)?|site|database|db|system|traffic|server|data)\b/i;

// The final itself says the work is not finished.
const INCOMPLETE = /(?:尚未|還沒有?|仍未)(?:全部|完整)?完成|(?:修改|修正|改動|變更|實作|程式碼?|patch|fix|change)[^。；\n]{0,16}(?:尚未|還沒有?|仍未)(?:經過)?(?:驗證|測試|跑)|(?:測試|驗證)(?:還沒|尚未)(?:跑|做|執行)?|\bnot (?:yet )?(?:finished|complete|done)\b|\b(?:haven['’]t|have not) (?:yet )?(?:run|verified|tested|finished)\b|\b(?:fix|change|patch)\b[^.\n]{0,30}\bnot (?:yet )?(?:been )?(?:verified|tested)\b/i;
// ...but says why it stops there: out of scope, needs hardware, money or the user.
const STATED_REASON = /因為|由於|需要|需(?=付費|真機|權限|授權|你|您)|超出|範圍外|不在.{0,8}範圍|付費|\bout of scope\b|\bbecause\b|\brequires?\b|\bneeds?\b|\bblocked\b|\bpending\b|待(?:你|您)/i;

// The model says it is waiting for something to come back.
const WAIT = /我會等|等待?.{0,24}(?:結果|完成|回報|回傳|回來)(?:再|後|才)|等.{0,16}(?:跑完|完成|結束|回來|出來)|(?:仍在|還在|正在)(?:執行|跑|進行|查核)(?!的)|待.{0,16}(?:完成|回報|回傳)後|\bwaiting (?:for|on)\b|\bI(?:['’]ll| will) wait\b|\bwait (?:for|until)\b|\bonce .{0,40}(?:finishes|completes|returns)\b/i;
// Waiting on a system outside the session is not a phantom wait.
const EXTERNAL = /\bCI\b|pipeline|管線|\bMR\b|\bPR\b|\bjobs?\b|\bbuild\b|workflow run|GitHub Actions|Argo|rollout|審核|reviewer|\bDBA\b|對方|他們|團隊|\bteam\b|客戶|廠商|vendor|上游|upstream|nightly|排程|cron/i;

// A condition placed before the promise: the step is not due yet
// ("完成後我再確認", "Once the job finishes, I'll …").
const CONDITION = /如果|若(?!要)|假如|萬一|一旦|要是|\b(?:if|unless|in case|once|after|when)\b|(?:後|之後|以後)[，,]?\s*$/i;
// A future that is not this turn: "以後我會記得", "going forward".
const LATER = /以後|往後|日後|下次|未來|改天|明天|有空|\bgoing forward\b|\bin the future\b|\bnext time\b|\btomorrow\b|\bfrom now on\b|\blater on\b/i;
// The promise is a lead-in to content shown right here ("我將改動整理如下：").
const PRESENTED = /(?:整理|列|彙整|說明|總結|摘要|歸納|附上|貼)(?:成|在|於|出)?(?:如下|以下|下面|下列)|(?:如下|以下)\s*[:：]|\bas follows\b|\bbelow\s*[:：]/i;
// "不會直接合併" is a promise not to act; its verbs are not the next step.
const NEGATED = /(?:不會|不要|不再|暫不|先不|並未|沒有|尚未|還沒)(?:直接|自行|擅自|主動|先|再|去)?[\u4e00-\u9fff]{0,6}|\b(?:won['’]t|will not|do not|don['’]t|never|without)\b(?:\s+[\w-]+){1,2}/gi;

// Finals that end the turn on purpose. Any hit anywhere from the paragraph
// before the promise to the end lets the final through.
const VETOES = Object.freeze([
  ["question", /[？]|\?(?=\s|$|[*_)）」"'])|要不要|是否要|要我.{0,30}嗎|你要.{0,24}還是|請(?:你|您)?(?:選擇?|擇一|決定|確認是否)|\b(?:do you want|would you like|should I|shall I)\b/i],
  ["authorization", /請(?:再|先)?(?:允許|授權|核准|批准)|允許後|放行|授權後|核准後|批准後|同意後|獲准|獲得.{0,6}(?:同意|授權|核准)|需要(?:你|您)(?:的)?.{0,12}(?:授權|核准|批准|同意|登入|MFA|OTP)|(?:輸入|提供|完成)\s*(?:MFA|OTP)|\b(?:approval|authori[sz]ation|permission|sign-off|go-ahead) (?:is )?(?:needed|required)\b|\bplease (?:approve|allow|grant|confirm)\b/i],
  ["phase-gate", /到此(?:為止|停止|暫停|告一段落)|這一?階段.{0,10}(?:完成|結束|停止)|等(?:你|您)|等.{0,4}(?:審查|審核|核准|批准|指示)|待(?:你|您)(?:確認|核准|審|決定|回覆|同意|選|指示)(?!的)|交(?:由|給)(?:你|您)|由(?:你|您)(?:決定|確認|選)|需要(?:你|您)(?:的)?(?:決定|確認|選擇|回覆)|(?:你|您)(?:確認|核准|同意|選好|選擇|決定|回覆|說\s*go|點頭|批准|看過|審過|允許|授權)了?(?:後|之後|以後|再|才)|在(?:你|您).{0,6}(?:決定|確認|核准|同意)(?:之前|前)|\b(?:once|after|when|until|before) you(?:['’]ve| have)?\s+(?:confirm|approve|decide|pick|choose|reply|review|say|give|sign off|ok)|\b(?:after|upon|with|pending|awaiting|on) your (?:approval|confirmation|review|go-ahead|decision|ok|sign-off|reply)\b|\bwait(?:ing)? (?:for|on) (?:you|your)\b|\bstop(?:ping)? here\b|\bneeds? your\b|\byour call\b/i],
  ["offer", /若(?:你|您)(?:要|需要|想|同意|確認|決定)|如果(?:你|您)(?:要|需要|想|同意|確認)|要的話|需要的話|\bif you (?:want|would like|['’]d like|need|approve|agree|prefer)\b|\bhappy to\b/i],
  ["user-action", /請(?:你|您)?(?:先)?(?:在.{0,10})?(?:執行|跑|輸入|貼|提供|調整|設定|開啟|關掉|打開|重新登入|登入)|(?:你|您)(?:自己|本人)?(?:在|到|於|從).{0,16}(?:跑|執行|輸入|貼上|操作)|由(?:你|您)(?:來|自行)?(?:執行|跑|操作|處理)|(?:你|您)(?:可以|可|需要|得|要)(?:自己)?(?:在.{0,12})?(?:跑|執行|輸入)|建議(?:你|您)|完成後(?:回|告訴|通知)我|(?:執行|跑)完?後(?:回|告訴|通知)我|結果(?:貼|回傳|告訴)給?我|\b(?:please|you(?:['’]ll)? (?:need to|can|could|should|may want to)) (?:run|execute|paste|enter|re-?login|log in)\b|\bneed you to\b|\bfrom your (?:own )?(?:shell|terminal|machine)\b|\blet me know (?:when|once|if|whether)\b/i],
  ["hypothetical", /如果是我|換作是我|換成是?我|要是我|若是我|\bif I were you\b|\bif it were me\b|\bin your (?:shoes|position)\b/i],
  ["not-acting", /不會(?:自行|擅自|主動|直接)|未經.{0,8}(?:同意|授權|核准)|我(?:尚未|還沒|沒有)(?:動手|合併|送出|套用|apply|sync|部署|發布|發佈|push|推送|執行任何)|\bwon['’]t (?:merge|push|deploy|apply|touch|proceed)\b|\bwithout your\b/i],
  ["blocker", /被(?:權限.{0,8})?(?:拒絕|擋|阻擋)|遭(?:到)?拒|權限不足|沒有權限|無法(?:存取|連線|連到|登入|驗證身分|取得權限)|\b(?:permission|access) (?:was |is )?denied\b|\bblocked by\b|\b(?:I|we) (?:don['’]t|do not|cannot|can['’]t) (?:have )?(?:access|permission)\b|sandbox.{0,10}(?:擋|阻擋|blocks?|blocked)/i],
]);

// A handed-over command: a fenced block of shell the final shows instead of
// running. A block introduced as already run ("已執行：") is evidence instead.
const SHELL_FENCE = /```(?:bash|sh|shell|zsh|console)?\n/g;
const SHELL_LINE = /^\s*(?:[$!] |(?:bash|sh|aws(?:-vault)?|kubectl|helm|terraform|git|glab|gh|npm|npx|node|chmod|curl|psql|mysql|docker|devops|twg|acli|ccr|airkit|airclaude)\s)/m;
const ALREADY_RAN = /已執行|已跑|跑了|執行了|\bran\b|\bexecuted\b|output|輸出|結果|result/i;

const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)、])\s/;
const CLAUSE_BREAK = /[。！；;\n]|[.!](?:\s|$)/g;

// Blank out code, quotes and URLs (same length, so indexes still line up):
// "「我會再跑一次測試」這種收尾" quotes a promise, it does not make one, and a
// "?" in a URL or regex is not a question.
function mask(text) {
  const blank = (match) => match.replace(/[^\n]/g, " ");
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/https?:\/\/\S+/gi, blank)
    .replace(/「[^」\n]{0,200}」|“[^”\n]{0,200}”|"[^"\n]{0,200}"|『[^』\n]{0,200}』/g, (match) => match[0] + blank(match.slice(1, -1)) + match.at(-1));
}

function paragraphs(text) {
  const parts = [];
  const pattern = /[^\n]*\S[^\n]*(?:\n(?!\s*\n)[^\n]*)*/g;
  for (const match of text.matchAll(pattern)) {
    if (match[0].trim()) parts.push({ start: match.index, end: match.index + match[0].length });
  }
  return parts;
}

function clauseBounds(text, index) {
  let start = 0;
  let end = text.length;
  for (const match of text.matchAll(CLAUSE_BREAK)) {
    if (match.index < index) start = match.index + match[0].length;
    else {
      end = match.index;
      break;
    }
  }
  return { start, end };
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

function handsCommand(raw) {
  for (const match of raw.matchAll(SHELL_FENCE)) {
    const body = raw.slice(match.index + match[0].length).split("```")[0];
    const before = raw.slice(Math.max(0, match.index - 24), match.index);
    if ((match[0] !== "```\n" || SHELL_LINE.test(body)) && !ALREADY_RAN.test(before)) return true;
  }
  return false;
}

function vetoesIn(raw, masked) {
  const hits = [];
  for (const [name, pattern] of VETOES) {
    // Questions are read without code and quotes; user-directed commands are
    // often inline code, so the rest see the raw text.
    if (pattern.test(name === "question" || name === "hypothetical" ? masked : raw)) hits.push(name);
  }
  if (handsCommand(raw)) hits.push("hands-command");
  return hits;
}

// Where the promise sits: the last paragraph first, then up to two above it.
// Waits and admissions only count in the last one; above it they are usually
// a procedure handed to the user ("3. 等待正在寫入的物件完成。").
function findPromise(masked, parts) {
  const last = parts.length - 1;
  for (let at = last; at >= Math.max(0, last - SCAN_PARAGRAPHS + 1); at -= 1) {
    const { start, end } = parts[at];
    const segment = masked.slice(start, end);
    const promise = PROMISE.exec(segment);
    if (promise) return { kind: "promise", index: start + promise.index, length: promise[0].length, para: at };
    if (at !== last) continue;
    const wait = WAIT.exec(segment);
    if (wait) return { kind: "wait", index: start + wait.index, length: 0, para: at };
    const incomplete = INCOMPLETE.exec(segment);
    if (incomplete) return { kind: "incomplete", index: start + incomplete.index, length: 0, para: at };
  }
  return null;
}

// A colon lead-in followed by prose or a quote is a promise already kept
// ("我會改成：> …"); followed by a list it is still a plan.
function keptInline(masked, parts, found) {
  const paragraph = masked.slice(parts[found.para].start, parts[found.para].end).trim();
  const next = parts[found.para + 1];
  if (!next || !/[:：]\s*(?:\*\*)?$/.test(paragraph)) return false;
  return !LIST_ITEM.test(masked.slice(next.start, next.end));
}

// The step itself: the rest of the clause after the marker, or the next
// paragraph when the marker is a heading or colon lead-in.
function stepText(raw, masked, parts, found, clause) {
  const own = raw.slice(found.index + found.length, clause.end);
  if (own.replace(/[\s*_:：，,。.]/g, "").length >= 4) return own;
  const next = parts[found.para + 1];
  if (!next) return own;
  const body = raw.slice(next.start, next.end);
  return `${own} ${body.slice(0, clauseBounds(body, 0).end)}`;
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
  const raw = String(text ?? "").replaceAll("\r\n", "\n");
  const allow = (reason, promise = null, vetoes = []) => ({ decision: "allow", reason, promise, vetoes });
  if (!raw.trim()) return allow("empty");
  if (SUMMARY.test(raw.slice(-400))) return allow("post-compact-summary");
  const masked = mask(raw);
  const parts = paragraphs(masked);
  const found = findPromise(masked, parts);
  if (!found) return allow("no-promise");
  const clause = clauseBounds(masked, found.index);
  const clauseRaw = raw.slice(clause.start, clause.end);
  const clauseMasked = masked.slice(clause.start, clause.end);
  const promise = redactPromise(clauseRaw);
  if (backgroundRunning > 0) return allow("background-running", promise);
  if (found.kind === "promise" && keptInline(masked, parts, found)) return allow("promise-fulfilled-inline", promise);
  if (PRESENTED.test(clauseMasked)) return allow("presented-inline", promise);

  const windowStart = parts[Math.max(0, found.para - 1)].start;
  const vetoes = vetoesIn(raw.slice(windowStart), masked.slice(windowStart));
  if (vetoes.length > 0) return allow("veto", promise, vetoes);

  const before = masked.slice(clause.start, found.index);
  if (CONDITION.test(before)) return allow("conditional", promise);
  if (LATER.test(clauseMasked)) return allow("later", promise);

  // Unsafe and production words count in the promise clause and the rest of
  // its paragraph ("…處理。目標是 production 的 api"), minus what it says it
  // will not do.
  const scope = raw.slice(clause.start, parts[found.para].end).replace(NEGATED, " ");
  if (UNSAFE_STEP.test(scope)) return allow("next-step-unsafe", promise);
  if (production !== "allow" && PRODUCTION.test(scope)) return allow("production-gate", promise);

  if (found.kind === "wait" || WAIT.test(clauseMasked)) {
    if (EXTERNAL.test(clauseRaw)) return allow("external-wait", promise);
    return { decision: "continue", reason: "phantom-wait", promise, vetoes };
  }
  if (found.kind === "incomplete") {
    if (STATED_REASON.test(clauseRaw)) return allow("incomplete-with-reason", promise);
    return { decision: "continue", reason: "admitted-incomplete", promise, vetoes };
  }
  const step = stepText(raw, masked, parts, found, clause).replace(LEAD, "");
  if (NOT_WORK.test(step)) return allow("not-work", promise);
  if (!WORK_STEP.test(step)) return allow("no-workspace-step", promise);
  return { decision: "continue", reason: "promise", promise, vetoes };
}

/**
 * The Stop reason Claude Code feeds back to the model. It only re-opens the
 * step the model already promised and the user already authorized.
 */
export function earlyFinalReason(promise, { phantomWait = false } = {}) {
  const quoted = redactPromise(promise) || "（未擷取到）";
  const opening = phantomWait
    ? `你的回覆說在等待結果（「${quoted}」），但這個 session 沒有追蹤到任何還在執行的背景工作。如果結果其實已經回來，就去讀它；如果是在等 session 以外的系統，直接結束這一輪並說明在等什麼。`
    : `你的回覆在結尾承諾了還沒做的下一步：「${quoted}」。`;
  return [
    opening,
    "只做這一步，而且只在它屬於使用者已經要求並授權的範圍內；不要擴大範圍，不要開始新的工作。",
    "不要執行 production、破壞性、對外或使用者尚未核准的寫入動作（merge、apply、套用、sync、deploy、刪除、移除、覆寫、發布、publish、安裝、通知或傳訊息、付費呼叫）。",
    "如果使用者這一輪只要計畫、要你停在某個階段，或這一步需要授權、使用者動作或決定，直接結束這一輪，明確提出請求或問題，不要自行繞過。",
    "如果做不到，說清楚卡在哪裡；如果其實已經完成，用證據回報即可。",
  ].join("\n");
}
