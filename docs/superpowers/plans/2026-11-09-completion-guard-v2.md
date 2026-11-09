# GPT early-final guard v2（completion guard 重建）架構計畫

日期：2026-11-09（Asia/Taipei）。分支：`fix/completion-guard-v2`（clone `/tmp/claude-501/airkit-oss-final-guard`，基底 `db26602`）。
範圍：只有計畫與 corpus，還沒有實作程式。不動 OSS main、不發布、不 push。

## 0. 結論

把 early-final 偵測做成 education 的一條新規則 `early-final`，不復活舊的 `processCompletionGuardHook`。education 已經有六項需求要的東西：Stop 掛勾、`background_tasks`、以 session 為單位的 state、off/shadow/enforce 分級、`airkit-education.jsonl` 紀錄、只對非 Claude 模型生效，以及 `education report`。舊 guard 的 Stop 入口自 `c161546` 起已經不存在，剩下的程式是死碼，這次一併移除。舊的 `completionGuard` 設定鍵保留，改成對應到新規則。

## 1. 現況（已查證）

| 項目 | 事實 | 證據 |
|---|---|---|
| 舊 guard 的 Stop 入口 | `c161546`（2026-08-31 13:52 TW）從 heartbeat `hooks.json` 拿掉 `Stop`，同時加上 `gptCompletionDisciplinePrompt` | [VERIFIED: `git show c161546`] |
| 舊 guard 程式仍在 | `processCompletionGuardHook` 在 `src/context-heartbeat.mjs:236`，呼叫點在 `:103-104`；`UserPromptSubmit` 清 state（`:243-246`），`PostToolUse` arm（`:248-252`），`Stop` 遇到 `stop_hook_active` 就放行（`:254`） | [VERIFIED: 檔案行號] |
| log 模式為什麼沒有紀錄 | `c5ad470`（2026-10-27）加了 `mode:"log"`，但 Stop 已經沒有註冊，所以只會 arm，不會寫 `decisions.jsonl`。實機 `~/.claude/plugins/data/airkit-context-inline/completion-guard/` 只有 state 檔，沒有 decisions 檔 | [VERIFIED: `ls` 該目錄；`context-heartbeat.mjs:394-470` 的 hooks 沒有 Stop] |
| 設定鍵 | `launch.modes.<mode>.completionGuard` 的驗證在 `src/airkit.mjs:2042-2065`，注入環境變數在 `:3455-3459`；internal catalog 的 `gpt61-sol`、`gpt6-luna` 設 `{maxStopBlocks:1, mode:"log", models:["^gpt-"]}` | [VERIFIED: 檔案行號；`profiles/catalog.json` 解析結果] |
| prompt 規則 | `gptCompletionDisciplinePrompt` 在 `src/airkit.mjs:82`，只在 route 含 `gpt-*` 時放進 routing prompt（`:3621`） | [VERIFIED] |
| education 的 Stop | `onStop`（`src/education.mjs:975-1007`）已經讀 `background_tasks`、`stop_hook_active`、`last_assistant_message`，並用 `state.stopBlockedTurn` 限制一輪最多擋一次 | [VERIFIED] |
| education 實機紀錄 | `~/.claude-code-router/logs/airkit-education.jsonl` 共 1796 筆，其中 `Stop/running-note` 34 筆、`Stop/unread-result` 106 筆，表示 Stop 的 `background_tasks` 真的有帶進來 | [VERIFIED: 讀 log 統計] |
| state 以 session 為鍵 | `statePath` 用 `hash(session_id)`（`education.mjs:454-457`），所以 fork 出新的 session id 時，state 天生是空的 | [VERIFIED] |
| `src/completion/*` | 這是 `completionMode:"shadow"` 的 bounded completion controller，和舊 `completionGuard` 無關；這次不碰 | [VERIFIED: `src/completion/hook.mjs`、`context-heartbeat.mjs:451,511`] |

歷史數據（2026-11-08 評估報告 `/private/tmp/claude-501/-Users-untionglim-projects-web-ai-runtime-kit/08b022c3-234a-449f-83de-ba4b48e3587d/scratchpad/gpt-completion-guard-eval-2026-11-08.md`）：舊 guard 在 GPT 上擋了 94 次，真的太早的約 13 次（約 14%），其中 7 次續行後做出越權動作（例如自己在 production 跑 `kubectl create job`）。漏判有兩種：一輪只擋一次，以及沒用工具的回覆不會被 arm。9/1 之後只靠 prompt，明顯的 early final 約 1–2%。[INFERENCE：單人人工標記]

## 2. Corpus

- 路徑：`/tmp/claude-501/airkit-oss-final-guard/test/fixtures/completion-guard/corpus.jsonl`（161 筆，欄位說明在同目錄 `README.md`）
- 組成：`hist-*` 94 筆（舊 guard 擋下的全部 GPT final）、`miss-*` 2 筆（08-25 預算用完被放行的 early final）、`post-*` 65 筆（8/31 之後只剩 prompt 的期間：regex 命中的、已知漏判，加 30 筆 seed 20261109 隨機樣本；其中 7 筆是 8/31 13:52 前 guard 期間沒被擋的 final）
- 標籤：`expected:continue` 18 筆（easy 3、medium 8、hard 7）；`must_allow` 22 筆，包含舊 guard 造成越權的 7 筆、等待迴圈 8 筆，以及使用者設下的授權或階段 gate
- `truth` 和 `expected` 刻意不一致的 6 筆：`hist-024`、`hist-051`、`hist-059`（背景還在跑，依規則 2 放行）、`post-201`（compact capsule 當成 final，依規則 1 放行）、`post-090`、`post-091`（模型錯報 blocker，不屬於這個 guard 處理的範圍）。這些就是這個設計放棄的部分
- 遮蔽：只保留 final 最後 400 字，URL、主機、路徑、檔名、ticket、MR、帳號、hash、內部服務名都換成佔位符，不存使用者 prompt。未遮蔽的 master、原始評估資料與產生腳本在 `/Users/untionglim/projects/web/ai-runtime-kit/reports/local/completion-guard-corpus/`（該目錄有內容為 `*` 的 `.gitignore`，不會進任何 repo）；`source_ref` 是指向 `master.json` 的 hash。用常見姓氏規則掃過人名，沒有命中，但中文人名沒辦法完整自動檢查 [unverified]
- `next_step_touches_production: true` 標在 4 筆 `continue` 上（`hist-012`、`hist-097`、`hist-099`、`post-134`），這幾筆的下一步是 production 的唯讀查詢或觀察，見 §6 第 7 項
- 參考基準：用簡單 regex（承諾詞＋問句／授權／指令 veto＋背景／capsule 放行）跑 corpus，得到 tp=9、fp=7、fn=9，`must_allow` 被誤擋 2 筆（`post-132`、`post-196`）[VERIFIED: `python3 scratchpad/cg2/baseline.py corpus.jsonl`]。舊 guard 在同一份 corpus 上擋了全部 94 筆 hist，其中 `must_allow` 15 筆、應該續行的只有 8 筆

## 3. 設計

### 3.1 位置與檔案

| 檔案 | 變更 |
|---|---|
| `src/early-final.mjs`（新檔） | 純函式，不讀檔：`classifyEarlyFinal(text, { backgroundRunning })` 回傳 `{ decision: "allow"|"continue", reason, promise, vetoes }`；`earlyFinalReason(promise)` 產生續行提示。另外放 regex 常數。拆成獨立檔案，是因為 `education.mjs` 已經 1162 行，corpus 測試也需要能單獨呼叫分類器 |
| `src/education.mjs` | `EDUCATION_ENV.earlyFinal = "AIRCLAUDE_EDUCATION_EARLY_FINAL"`；模型清單 `AIRCLAUDE_EDUCATION_EARLY_FINAL_MODELS` 是 JSON 陣列，**不能**放進 `EDUCATION_ENV`：`readEducationConfig`（`:204-227`）會把每個鍵都當成等級解析，不合就記 config-error。要比照 `EDUCATION_RULES_ENV`（`:225`）另外讀；`EDUCATION_DEFAULTS.earlyFinal = "shadow"`；`LATER_FLAGS` 加 `earlyFinal`（舊 hook 腳本沒設時視為預設值，不算錯誤）；`EDUCATION_RULES["early-final"] = "earlyFinal"`；`EDUCATION_EVENTS` 加 `SessionStart`、`PostCompact`；`EDUCATION_RULES_VERSION` 6 → 7；`emptyState()` 加 `earlyFinal: { blocks: 0, lastBlockAt: null, lastPromiseHash: null, resetBy: null }`；`onUserPrompt` 重設 `earlyFinal`；新增 `onLifecycle`；`onStop` 加 early-final 分支；`processEducationHook` 分派新事件；`SAMPLED_DECISIONS` 不變（shadow 時 decision 仍記 `block`，`emitted:false`） |
| `src/context-heartbeat.mjs` | 刪掉舊 guard：`COMPLETION_GUARD_*` 常數與只給它用的 `TRANSCRIPT_TAIL_LIMIT`（`:22-26`）、`processCompletionGuardHook`（`:236-293`）及 helper（`:295-355`、`:581-620`；刪前再 grep 一次確認沒有其他呼叫者）、呼叫點（`:103-104`）、completion shadow 腳本裡的 `AIRCLAUDE_COMPLETION_GUARD_MAX_STOP_BLOCKS: "0"`（`:469`）。`educationHookEnv` 會自動帶出新旗標（它依 `EDUCATION_ENV` 迴圈產生），模型清單另外加 `AIRCLAUDE_EDUCATION_EARLY_FINAL_MODELS` |
| `src/airkit.mjs` | 保留 `completionGuard` 驗證（`:2042-2065`），讓 internal catalog 不用改就能載入。`profileEducation`（`:4358`）把它轉成 mode 層 education 旗標：`mode:"log"` → `earlyFinal:"shadow"`，`"block"` → `"enforce"`；`maxStopBlocks` 當一輪的上限；`models` 當模型清單。刪掉 `:3455-3459` 的環境變數注入。`gptCompletionDisciplinePrompt`（`:82`）保留，但措詞改成和允許停下的條件一致（見 3.4） |
| `docs/completion-guard.md` | 改寫 `:5-31` 舊 guard 的段落（目前描述的 log 路徑實際上不會寫入），說明對應規則與 shadow/enforce |
| `docs/profile-schema.md` | 補 `earlyFinal` 旗標與 `early-final` per-rule 開關 |

### 3.2 六項需求怎麼落地

1. **compaction / resume / fork 重設**：`onLifecycle` 在 `SessionStart`（`source` 為 `resume`、`compact`、`clear`）和 `PostCompact` 時清掉 `state.earlyFinal`，並記 `resetBy`。fork 會拿到新的 session id，所以 state 一開始就是空的。重設只清計數和預算，不代表 compaction 後的 final 不會被判斷。如果 final 本身就是 compact 摘要（含 `</summary>` 或 `[AIRKIT_TASK_CAPSULE]`），一律放行並記 `allow: post-compact-summary`。這是 `hist-020` 的教訓：從 capsule 的 `next_action` 續行，會直接越權。
2. **背景工作還在跑就不擋**：`background_tasks` 裡只要有任何一筆 `status === "running"` 就放行，不限 `type`（agent、workflow、shell、teammate 都算）。`background_tasks` 不存在時，退回用 education 自己記的 `state.spawns`（`background && !endedAt`）。反過來，final 說「在等」但沒有任何東西在跑，就判為 `phantom-wait`，可以續行（`post-158`）。shadow 期間記下實際出現過的 `type`，用來驗證欄位格式，目前只確認過 `subagent`。
3. **允許停下的 final**（veto，命中任何一項就放行）：句尾是問句或請使用者選擇；請求授權、MFA、放行；交給使用者一段要執行的指令（fenced shell block、「請執行」「完成後回我」）；宣告停在階段 gate（「這一階段到此停止」「等審查」「再交給你決定」）；有條件的提議（「若你要我…」）；明說還沒動手、在等指令（「我尚未操作」「不會自行」）；陳述 blocker。下一步如果是寫入動作（轉 Ready、merge、sync、apply），也視為需要授權，一樣放行（`post-132`）。
4. **續行提示的界線**：引用偵測到的承諾句（最多 120 字，經過遮蔽），內容固定為：只做這句已經答應、而且使用者已經授權的那一步；不擴大範圍；不執行 production、破壞性或未經核准的寫入；如果下一步需要授權、使用者動作或決定，就直接結束這一輪並明確提出請求；做不到就講清楚卡在哪裡。不再使用舊的「Continue working when safe」，它被模型讀成「再做點什麼」。
5. **沒用工具的回覆也判斷，一輪可以擋多次但有上限**：不再靠 `PostToolUse` arm，每次 Stop 都判斷，所以 `post-106`（tools=0）會被抓到。`stop_hook_active === true` 時，必須同時符合三個條件才再擋一次：（a）`blocks < 上限`（預設 2，可用舊 `maxStopBlocks` 1–3 覆蓋）；（b）上次擋下後 transcript 有新的 `tool_use`；（c）這次的承諾句 hash 和上次不同。任何一項不成立就放行，並記 `allow: loop-stop`，避免舊 guard 那種冗餘文字迴圈。
6. **預設 shadow**：`earlyFinal` 預設 `"shadow"`，只寫 `airkit-education.jsonl`，不輸出 Stop 回應。`launch.education.earlyFinal: "enforce"`、mode 層的 `education`、或 `launch.education.rules["early-final"]: "enforce"` 都能改成實際擋下；設 `"off"` 是人工逃生口。紀錄格式比照現有規則：`{rule:"early-final", decision:"block"|"allow", emitted, reason, evidence:{promise, vetoes, backgroundRunning, blocks, progressTools, stopHookActive, resetBy}}`。只有偵測到承諾句或 phantom-wait 時才記錄（包括被 veto 放行的），一般 final 不記，避免 log 量暴增。

### 3.3 模型範圍

`gated()` 已經排除 Claude 模型。early-final 另外加模型清單，預設 `["^gpt-"]`（和舊設定一致），從 `AIRCLAUDE_EDUCATION_EARLY_FINAL_MODELS` 讀取。這樣 glm、kimi 這類 mode 在 session 中切到 GPT Sonnet lane 時也會涵蓋；背景 DeepSeek 不受影響。

### 3.4 prompt 層

`gptCompletionDisciplinePrompt` 改成兩段：還沒完成就不要送 final；但如果要問問題、請求授權、停在宣告的階段 gate、或把指令交給使用者執行，就應該結束這一輪，不要硬做。避免 prompt 和 Stop 規則互相矛盾。

## 4. 測試

| 檔案 | 內容 |
|---|---|
| `test/early-final.test.mjs`（新） | 每種 veto、phantom-wait、capsule 放行、承諾句擷取與遮蔽、續行提示不含擴權字樣 |
| `test/completion-guard-corpus.test.mjs`（新） | 逐筆用 `classifyEarlyFinal` 跑 corpus。門檻：`must_allow` 22/22 放行（硬性）；easy＋medium 的 `continue` 召回率 ≥ 0.8（共 11 筆）；整體 precision ≥ 0.8；`hard` 只回報數字，不設門檻 |
| `test/education.test.mjs` | onStop：背景還在跑時放行；tools=0 會判斷；`stop_hook_active` 有進展才擋第二次、沒進展就 `loop-stop`；達上限放行；shadow 不輸出；`SessionStart(resume/compact)`、`PostCompact` 會重設 |
| `test/education-wiring.test.mjs` | hooks.json 多出 `SessionStart`、`PostCompact` 的 education 項目；旗標與 models 環境變數有渲染 |
| `test/airkit.test.mjs` | `completionGuard` 轉成 education 旗標；不再注入 `AIRCLAUDE_COMPLETION_GUARD_*`；把約 76 處舊 guard 斷言改寫或刪除 |
| `test/completion-install.test.mjs` | 拿掉 `MAX_STOP_BLOCKS=0` 的斷言 |

驗證指令：`npm test`、`npm run check`。

## 5. 分階段（每階段 ≤ 5 個檔案，每階段結束停下等核准）

1. 刪舊碼：`context-heartbeat.mjs`、`airkit.mjs`（只拿掉 env 注入）、`airkit.test.mjs`、`completion-install.test.mjs` 的舊 guard 部分，單獨一個 commit
2. 分類器：`src/early-final.mjs`、`test/early-final.test.mjs`、`test/completion-guard-corpus.test.mjs`，用 corpus 調到過門檻
3. 接線：`education.mjs`（旗標、事件、state、onStop、onLifecycle）、`education.test.mjs`、`education-wiring.test.mjs`、`context-heartbeat.mjs`（models env）
4. 設定與文件：`airkit.mjs`（`profileEducation` 對應、prompt 措詞）、`docs/completion-guard.md`、`docs/profile-schema.md`
5. OSS 發版（等 0.2.66 那條 workflow 結束後再決定），internal repo pin 新版、`airkit update --write`、shadow 觀察 7 天，用 `education report --rules 7` 加人工抽樣（比照 `reports/model-education-shadow-TEMPLATE.md`），之後再決定要不要 enforce

internal repo 另外要處理（不在這個 clone 的範圍）：`profiles/catalog.json:425,444` 可以維持原樣（會自動轉成 shadow）；`CLAUDE.md` 裡 completionGuard 的描述需要更新。

## 6. 待你決定

1. **corpus 放哪裡**
   - A. 留在 OSS `test/fixtures/completion-guard/`（已遮蔽，但仍是工作對話片段，push 前要你逐筆看過）
   - B. corpus 放 internal repo，OSS 只放合成案例；corpus 測試改在 internal repo 跑
   - 建議 B：OSS 是公開 repo
2. **shadow log 要不要存句子片段**
   - A. 存 ≤120 字的遮蔽片段（人工抽樣才判斷得了誤擋）
   - B. 只存 hash 和 veto 類別
   - 建議 A：log 只在本機
3. **續行提示的語言**
   - A. zh-TW（和 rule set 6 的提示一致）
   - B. English
4. **一輪的上限預設值**
   - A. 2
   - B. 沿用舊 `maxStopBlocks:1`
   - 建議 A：舊漏判有一半是因為只能擋一次
5. **舊 `completionGuard` 鍵**
   - A. 轉成新規則（本計畫的做法）
   - B. 直接廢除，讓載入報錯，逼 catalog 改寫
6. **phantom-wait**（說在等但沒東西在跑）要不要一開始就納入 enforce，還是先只在 shadow 觀察
7. **下一步是 production 唯讀動作時怎麼處理**（`hist-012`、`hist-097`、`hist-099`、`post-134`；corpus 目前標 `continue`）
   - A. 照樣續行：唯讀不算越權，需要 production session 時模型會停下來要
   - B. 只要碰 production 就當成 gate：不論讀寫都放行，續行提示也不准碰 production
   - 建議 B：規則 4 要求不做 production 動作，而且舊 guard 的 7 次越權裡，有 3 次和 production 憑證或指令有關（`hist-008`、`hist-032`、`hist-108`）。選 B 的話，這 4 筆改成 `allow`，正例剩 14 筆。測試可以用這個欄位把兩種政策都跑一遍

## 7. 風險與未驗證

- `background_tasks` 除了 `subagent` 以外的 `type` 長什麼樣，還沒在實機 payload 看過 [unverified]
- `SessionStart` 在 fork 時帶什麼 `source` 沒有驗證；state 以 session id 為鍵，所以 fork 不靠這個也會重設 [INFERENCE]
- Claude Code 在 Stop 被 block 之後，下一次 Stop 會帶 `stop_hook_active: true`。這是依舊 guard 與 education 的既有寫法推論，這次沒有查文件 [INFERENCE]
- corpus 只有 18 筆正例，而且是單人標記；門檻只能當回歸保護，真正的誤判率要看 shadow 觀察
- `hard` 類（回報完成但交付物沒對完、只道歉沒動作）用文字規則抓不到，這次刻意不處理
