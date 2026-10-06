# Completion host coverage — 2026-10-03

紀錄時間：2026-10-03 15:41 TW / 07:41 UTC。本文件只記錄本次本機隔離 capture 與核心測試，正式 profile 仍 off/shadow。

## 單次真實宿主觀測

以已核准的 `/Users/untionglim/.local/bin/claude` 執行一次 synthetic loopback batch。Version 在 containment 內實際觀測為 **2.1.288**。Sandbox 證明真實 home 內容讀取被拒絕、external TEST-NET connection 被拒絕，以及只使用該 batch 的 loopback endpoint。

執行指令：

```bash
AIRKIT_VERIFY_COMPLETION_HOST=1 node scripts/capture-completion-contract.mjs isolated-enforce
```

程序 exit 0；六個 owned children 包含 containment probe、version、feedback、resume、compact、cancel，timeout 0、nonzero failure 0。每個 child 上限三十秒，所有 child admission/run 共用 batch 開始時建立的五分鐘 deadline，沒有 retry。Filesystem/setup、server startup、event aggregation 與 cleanup 都是 awaited，沒有獨立的硬性總 wall-clock 上限。Cleanup 已在回傳前等待 top-level child terminal close、關閉 server/connections、移除 owned temporary root；完整 descendant death 尚未驗證，本次沒有觀察到或重現 descendant leak。

以下為實際 sanitized output；沒有 raw prompt、headers、tool output、transcript 或 identity 值：

```json
{
  "status": "observed",
  "version": "2.1.288",
  "coverage": {
    "containment": true,
    "stopFeedbackContinue": true,
    "stopHookActive": true,
    "nativeIdentity": true,
    "userCancel": false,
    "compact": true,
    "resume": true,
    "nativeAcceptance": false,
    "exactTransportJoin": false,
    "continuousRevision": false,
    "enforcing": false
  },
  "counts": {
    "children": 6,
    "childTimeouts": 0,
    "childFailures": 0,
    "requests": 5,
    "feedbackContinuations": 1,
    "stop": 3,
    "activeStop": 1,
    "feedback": 1,
    "userPrompt": 3,
    "sessionStart": 5,
    "sessionEnd": 4,
    "postCompact": 1,
    "resume": 2,
    "compact": 1,
    "sessionIdentity": 16,
    "userIdentity": 0,
    "approval": 0,
    "exactRoute": 0
  },
  "reasons": [
    "native_acceptance_unknown",
    "exact_transport_join_unknown",
    "continuous_revision_unknown",
    "multi_target_revision_closure_unknown",
    "native_user_cancel_unverified",
    "native_approval_unverified"
  ]
}
```

`nativeIdentity: true` 僅指觀測到 `session_id` 欄位存在，不是完整 native RequestKey／generation／user identity coverage。User ID、approval、exact route 計數 0 是這次案例未觀測到，不代表該宿主永久沒有其他欄位。

Standalone Stop fixture 發出一次與目前 dispatcher 相同欄位形狀的 block response；實際宿主接收後送出包含 `pending_work` 的 continuation，並正常 exit。`stop_hook_active` 的 native boolean 被觀測到。這不是 production shadow hook 阻擋測試，也沒有新增可信 decoder。

SIGINT case 的 process 正常 exit，但沒有可驗收的同 generation user-cancel event，所以 `userCancel` 維持 false。Compact／resume 有 native hook event source 與正常 child exit；這些 mechanics 不會自動建立 acceptance、route 或 revision provenance。

## Core 與 native coverage 分開判讀

| 情境 | Core／fixture 證據 | 本次 native coverage |
| --- | --- | --- |
| 多交付漏一項 | `test/completion-host.test.mjs` 的 missing deliverables case：一項 verified，另一項仍列為 pending ID | 任務 authority/acceptance 未建立，unknown |
| 驗收未跑 | `test/completion-core.test.mjs` model assertions case：沒有 receipt 仍需 continue | 未執行 native accepted target，unknown |
| 驗收失敗／stale | `test/completion-verifier.test.mjs` exit one、mutation、unreadable revision；core later receipt supersedes success | 未建立 native verifier lifecycle，unknown |
| must-finish agent | Host test 的 background true/false 對照；native-adapter fixture 的 exact task binding | 未建立 native accepted agent contract，unknown |
| 純問答 | Core pure question 沒有 checkpoint 仍 allow | synthetic end-turn＋Stop mechanics 已觀測；production acceptance policy unknown |
| 等待權限 | Core authority waits；verifier permission denial 不啟動 target | approval 欄位計數 0，unknown |
| 外部 blocker | Core blocker 只在無剩餘安全工作時 allow | 沒有可信 native blocker producer，unknown |
| long-running server | Core non-must-finish running background allow | 未建立 native accepted background provenance，unknown |
| oversize | Checkpoint 8193-byte 拒絕；dispatcher 65537-byte bounded stdin；real-store schema/size tests | native load boundary 尚未驗收 |
| concurrent Stop | Real-store eight simultaneous Stops，single authoritative debit/output | 未對 actual host 發動 concurrent Stop，unverified |
| expiry／no progress | Core 十分鐘／budget／progress gate；real dispatcher single deadline／late I/O tests | 宿主 timeout bound 已套用；native policy expiry 未驗收 |
| Stop feedback／recursion | Dedicated dispatch fixture budget與active-stop gate | feedback→continuation→normal exit 與 active boolean 已觀測 |
| cancel | Core/native-adapter fixture＋owned verifier cancellation cleanup | SIGINT 有 terminal exit，可信 native cancel 仍 unverified |
| compact／resume | Native-adapter fixture不建立新generation | actual PostCompact／SessionStart source與normal exit已觀測 |
| exact routing | Fixture complete RequestKey/provider/model/transport tuple，conflict poison與opaque digest | exact route 欄位計數 0，unknown |
| 持續 revision／多 target closure | Owned point observer與receipt binding測試 | 完整 ingestion、fresh continuous coverage、多 target shared revision scheme 未完成 |

## 驗證與限制

Fake CLI 沒有 Stop、stdout 只回 PASS、沒有 native request join 時都不能變成 enforcing；unsafe home／non-loopback constraints 在啟動前被拒絕。實際宿主 opt-in test 在一般 suite 中 skip 不算 native PASS；上面的單次 CLI capture 是本次 native observation 證據，沒有為了讓 opt-in test 變綠再重播一次。

初次 fake-CLI 測試發現 macOS sandbox profile 只接受 `localhost`／`*` host 語法，不能使用 numeric IPv4 filter。用 `/usr/bin/true` 確認錯誤後改成精確的 owned `localhost:<port>`，fake containment 測試才通過；失敗紀錄保留。本次 actual batch 僅在正面 containment 證據成立後啟動。

本階段 full-suite/check/pack 與 overlay verification 的原始命令結果會記錄於 plan workspace 的 `task-6-report.md`，獨立 whole-branch review 完成前不宣稱分支驗收結束。

`coverage.enforcing` 明確為 false。缺少 native acceptance／exact join／continuous revision／multi-target closure 時應交付 unknown/shadow；不能自行把 fixture capability 命名為 validated production contract。

本機 capture script、文件與本報告未列入 npm package explicit files；此階段交付是 local tooling/report。沒有修改 package.json、production services、live session、auth/MCP、Codex／Pi native protocol、簽章或 opaque continuation，也沒有付費模型品質評測。
