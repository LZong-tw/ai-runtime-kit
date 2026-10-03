# Bounded completion guard

目前安裝預設為 off；明確指定 `completionMode: "shadow"` 才加入專用 Stop 入口。Shadow 不會阻擋完成、不會扣除 continuation budget，也不會從 stdin 接受 native decoder 或授權宣告。正式 profile 啟用與 production enforcing 仍需另外確認。

## 已實作的核心邊界

`src/completion` 使用同一份具 RequestKey／generation 的 ledger。只有已接受的 contract 能註冊 required target；model checkpoint 只能提出 bounded metadata，不能自授權、建立可信 receipt 或改寫 authoritative verification。

Verifier 只在已授權的一般工作流程執行 side-effect-free target，並產生與 execution、target、RequestKey、content revision 綁定的 receipt。零 exit code、stdout PASS、model 宣告完成都不足以證明成功；failed、stale、cancelled 或 unknown receipt 不能完成驗收。Stop 不執行 verifier、不重新讀全部 transcript、不呼叫模型。

Stop dispatcher 有單一一秒 deadline，stdin 上限 64 KiB，checkpoint positional tail 上限 8 KiB。Verified GPT coverage 下最多介入兩次，十分鐘失效；沒有實際進展不再介入。回饋最多三個 pending item ID。User cancel、等待新權限且沒有剩餘安全工作、外部 blocker、non-must-finish background server 均有獨立 gate。這些是核心 fixture 的驗證結果，不能替代 native provenance。

`renderHeartbeatManagedFiles(configDir, runtimeModuleUrl, { completionMode })` 保留既有兩參數使用方式。Shadow 只加入一個 dedicated Stop command；context/audit lifecycle hooks 與 MCP/auth/settings 路徑維持既有契約。Shadow heartbeat 會在該 hook process 將舊 `AIRCLAUDE_COMPLETION_GUARD_MAX_STOP_BLOCKS` 設為 `0`，避免第二份 legacy budget；off 模式保留舊 prompt-only 行為。

## 隔離的 native capture

本機工具：

```bash
AIRKIT_VERIFY_COMPLETION_HOST=1 node scripts/capture-completion-contract.mjs isolated-enforce
```

未明確 opt-in 的 CLI 回傳 `not-run`。`test/completion-host.test.mjs` 的 actual-host case 也需要此環境變數；一般 suite 的 skip 不算 native PASS。以上指令會執行一個實際 capture batch，不應在未知失敗下反覆重播。

`runCompletionCapture({ claudePath, mode })` 只回傳 sanitized `{status,version,coverage,counts,reasons}`。Mode 僅接受 `shadow` 或 `isolated-enforce`；後者是 standalone protocol probe，沒有啟用 production completion hook。Optional `home`／`baseUrl` 僅檢查並拒絕 unsafe constraint，不會取代 owned temporary home 或 generated loopback endpoint。

Capture 建立 owned temp home/config/workspace，使用固定 synthetic API key 與 fake upstream。macOS `sandbox-exec` 拒絕真實 home 的內容讀寫與外部網路，只允許該 batch 的 localhost port；執行前必須實測 home denied、external TEST-NET socket denied、loopback 204 三個正面 containment 證據。缺少證據就回傳 unsupported，不能以 fake CLI 或 process exit 代替 containment 證明。

每個 owned child 最多三十秒；containment/version 與所有案例的 child admission/run 共用 batch 開始時建立的五分鐘 deadline。Filesystem/setup、server startup、event aggregation 與 cleanup 都會等待完成，但沒有獨立的硬性總 wall-clock 上限。Timeout 終止 owned process group，等待 top-level child terminal close；最後關閉 owned server/connections 並清除只有本次建立的 temp root。完整 descendant death 尚未驗證，本次沒有觀察到或重現 descendant leak。Child stdout/stderr 不進入 report；native hook 僅保存 bounded event enum 與欄位存在的 boolean，不保存 prompt、headers、tool output、session/user ID 值或 transcript。宿主必要的 synthetic session 檔案只短暫存在 owned temp root。

Standalone probe 會給 fake upstream 的 end-turn 一次 bounded Stop feedback，檢查宿主是否送出含該 feedback 的 continuation 並正常 exit；另嘗試 owned synthetic session 的 resume、compact，以及 held upstream 的 SIGINT。SIGINT 後正常 exit 不代表收到可信 user-cancel 事件。

## Native observations 與 enforcing gate

2026-10-03 的 Claude Code 2.1.288 單次 capture 觀察到 Stop feedback→continuation→normal exit、`stop_hook_active`、PostCompact 和 SessionStart resume／compact source。這證明 standalone protocol mechanics；fake upstream 不能證明 GPT 品質。

`coverage.nativeIdentity` 只表示 native event 帶有非空 `session_id` 欄位。它不表示完整 RequestKey、user identity、acceptance authority 或 transport route 已建立。此次 user ID、approval、exact transport/provider/model tuple 的計數均為零；對該宿主／情境以外的欄位或行為不做推論。

Production enforcing 仍是 false，因為以下條件未完成：

- 獨立驗收的 native lifecycle／user acceptance／cancel producer 與同 generation 身分綁定。
- 原始 provider/model/transport 與完整 RequestKey 的 exact join。Persisted `modelId` 是 opaque digest，不能當作 upstream model 名稱。
- 一般工作流程的完整 fresh revision observations、同 generation cancellation，以及持續修改 coverage。單次 point observation／成功 receipt 不是未來變動監測。
- 多個不同 target file set 的一致 revision closure。不同 file set 的 digest 不能直接宣稱全部 target 共用同一 revision。

以上條件都維持 unknown；capture 不建立 `validatedContract`，不以 fixture decoder 冒充 production producer。若需要修改 gateway 或 native launcher seam，應另開經核准的至多五檔階段。

Claude→Codex／Pi 的 native 適配僅列為 future spec。本階段沒有修改其協定、簽章或 opaque continuation。跨模型品質評測、付費 API 與正式啟用也不屬於已完成事項。

## 發布範圍

`src/completion` 已包含於既有 package 的 `src` 與 export-copy 路徑。本機 capture script、此文件與 coverage report 未列入 package 的 explicit files，因此本階段不會隨 npm package 發布。它們是 local tooling/report；新增 package entries 需另行安排，不能由本階段偷偷修改第五個產品檔案。

本次觀測與 core/native coverage 對照見 [completion-host-coverage-2026-10-03.md](../reports/completion-host-coverage-2026-10-03.md)。
