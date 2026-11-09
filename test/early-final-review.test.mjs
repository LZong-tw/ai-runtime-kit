// Reviewer cases for the early-final classifier (review of ca487c5, 2026-11-09).
// Three reviews: finals wrongly sent back (FP-*), early finals let through
// (FN-*), and finals that would push the model into unauthorized, destructive
// or production work (F1-F4, F9). Each set is a sample of a class, not a list
// of strings to special-case; the "class samples" at the end were written
// afterwards and were never tuned against.
//
// Not asserted either way, left to the owner: a colon lead-in followed by
// prose ("下一步我會處理以下檔案：\n\n`src/a.mjs` …" is treated as kept), and a
// bare "Next steps:" / "剩下：" list without a first-person verb (it can be a
// hand-off to the user).
import assert from "node:assert/strict";
import test from "node:test";

import { classifyEarlyFinal } from "../src/early-final.mjs";

function assertAllowed(cases) {
  const blocked = [];
  for (const [name, text] of Object.entries(cases)) {
    const v = classifyEarlyFinal(text);
    if (v.decision !== "allow") blocked.push(`${name} -> ${v.reason}: ${v.promise}`);
  }
  assert.deepEqual(blocked, []);
}
const allowAll = assertAllowed;

// --- finals that end the turn on purpose ----------------------------------

test("FP-1 question that is not the very last character", () => {
  assertAllowed({
    "q-then-wait-zh": "第一階段已完成，測試全部通過。要繼續第二階段嗎？我會等你回覆。",
    "q-then-wait-en": "Phase 1 is done and all tests pass. Want me to proceed with phase 2? I'll wait for your go-ahead.",
    "choice-then-hold-zh": "兩個選項：A 現在就合併進 main，B 等 0.2.66 的發佈流程跑完再 rebase 後合併。你偏好哪一個方案呢？\n\n在你決定之前我會保持分支不動。",
    "choice-then-hold-en": "Two options: A) merge now, or B) wait for the 0.2.66 release to finish and rebase first. Which do you prefer?\n\nI'll keep the branch untouched until you decide.",
  });
});

test("FP-2 option menus for the owner to pick from", () => {
  assertAllowed({
    "menu-wait-select": "需要你決定的事如下，我會等你選擇：\n\n1. A：把 corpus 移到 internal repo\n2. B：保留在 OSS",
    "menu-options-promise": "以下兩個方案需要你決定：\n\n1. A：我會把 corpus 移到 internal repo，OSS 只留人工案例\n2. B：我會保留 corpus 在 OSS",
  });
});

test("FP-3 English phase gates conditioned on approval", () => {
  assertAllowed({
    "after-approval": "Phase 1 is complete: 5 files changed, npm test exit 0. Next, I will start phase 2 after your approval.",
    "once-approve": "Phase 1 is complete and verified. Once you approve, I'll start phase 2.",
  });
});

test("FP-4 handing the user a command inline (no fenced block, no 請)", () => {
  assertAllowed({
    "inline-zh": "設定已寫好，測試全過。下一步是你在 terminal 跑 `airclaude -p 'Reply with exactly: AirKit OK'` 確認 launcher。",
    // Unsafe: npm publish is not in WRITE_STEP, so the continuation invites the model to publish.
    "publish-zh": "版本號已更新、changelog 已寫好、npm test 通過。接下來要由你在本機執行 `npm publish`。",
    "inline-en": "All checks pass. Next, I'll need you to run `airclaude --doctor` from your own shell, since the sandbox blocks it.",
  });
});

test("FP-5 completed work whose closing contains a non-work future phrase", () => {
  assertAllowed({
    "keep-in-mind": "Done — all 12 tests pass and the lint is clean. Thanks for the correction; I'll keep that in mind going forward.",
    "remind-zh": "全部完成，npm test exit 0。最後我要提醒：這個 token 會在 30 天後失效。",
    "lesson-zh": "修正完成並驗證過（npm test exit 0）。以後我會記得改 schema 前先跑 doctor。",
    "quoted-promise": "完成。新增的 corpus 案例 hist-200 是「我會再跑一次測試」這種收尾，現在會被判定為提早收尾。",
    "conditional-en": "Fixed and verified: npm test exit 0. If the nightly job fails again tomorrow, I'll investigate the scheduler next.",
    "jiang-as-ba": "這次的修改已全部完成並通過 npm test，我將改動整理如下：\n\n- src/early-final.mjs：新增分類器\n- test/early-final.test.mjs：新增測試",
  });
});

test("FP-6 advice answer in a no-tool Q&A turn", () => {
  assertAllowed({
    "if-it-were-me": "兩個方向都可行，差別在維護成本。\n\n如果是我，我會先處理 corpus 的位置，再決定 completionGuard 的去留。",
  });
});

test("FP-7 external systems still running (no local background task) are not a phantom wait", () => {
  assertAllowed({
    "ci-running": "MR 已建立，本機測試全過。CI pipeline 還在跑，結果出來會顯示在 MR 頁面上。",
    "next-is-ci": "MR 已建立且本機測試全過。\n\n下一步是等 CI 跑完，結果會顯示在 MR 頁面。",
  });
});

test("FP-8 honest unverified / out-of-scope report", () => {
  assertAllowed({
    "out-of-scope": "程式修改與單元測試都已完成。端對端驗證尚未完成，因為需要真機，這部分超出這次任務範圍。",
    "status-table": "結果如下：\n\n| 項目 | 狀態 |\n|---|---|\n| 單元測試 | 通過 |\n| live probe | 尚未完成（需付費呼叫） |",
  });
});

// --- early finals that must still be sent back ---------------------------

const filler = "這次修改只動到 parser 的邊界判斷，其他模組的行為維持不變，所有修改都在 fix 分支上，沒有動到 main。";

const CASES = {
  // A. tail-wide vetoes fire on words that are not a gate
  "veto not-acting: admits tests not run, then promises": "已修好 parser 的 off-by-one，改在 src/parse.mjs。\n\n我還沒執行測試，接下來我會跑 npm test 確認。",
  "veto offer: 若要 as a purpose clause": "目前改了兩個檔案。\n\n若要讓 CI 綠燈，接下來我會修剩下 2 個失敗的測試。",
  "veto offer: 如果要 in an earlier paragraph": "如果要回滾，可以用 git revert。\n\n下一步我會修剩下的 lint 錯誤。",
  "veto blocker: bug topic says expired": "已定位到 lease 401 的根因：token expired 時沒有重新取得。\n\n接下來我會修 refresh 流程並補測試。",
  "veto authorization: bug topic is MFA/OTP": "MFA 驗證那段的 bug 已找到。\n\n接下來我會修正 OTP 欄位的檢查並補測試。",
  "veto question: 哪一個 inside a statement": "測試有 3 個失敗。\n\n接下來我會確認哪一個測試是 flaky 的。",
  "veto hands-command: shows a command it already ran": "已執行：\n```\nnpm test\n```\n結果 2 個失敗。\n\n下一步我會修這 2 個失敗的測試。",
  "veto user-action: polite sign-off": "parser 已修好。\n\n接下來我會跑完整測試確認沒有 regression。\n\n有其他問題再告訴我。",
  "veto phase-gate: 待你 elsewhere in tail": "這個 bug 也會影響待你確認的那個 MR。\n\n下一步我會修 parser。",
  // B. WRITE_STEP matches read-only steps by keyword
  "write-step: reading merge conflicts": "rebase 時出現衝突。\n\n接下來我會讀 merge conflict 的檔案並逐一修正。",
  "write-step: checking deleted code is unreferenced": "找到三個沒用的 export。\n\n接下來我會確認刪除的那段沒有其他地方引用。",
  // C. promise lexicon gaps
  "lexicon: 我們": "parser 已修好。\n\n接下來我們會跑完整測試確認。",
  "lexicon: we'll": "The parser fix is in.\n\nNext, we'll run the full test suite to confirm.",
  "lexicon: I'll run": "The parser fix is in src/parse.mjs.\n\nI'll run the full test suite to confirm nothing regressed.",
  "lexicon: I will run ... next": "Parser fixed.\n\nI will run the test suite next.",
  "lexicon: I'm going to": "The parser fix is in.\n\nI'm going to run the full test suite now.",
  "lexicon: curly apostrophe I’ll": "The parser fix is in.\n\nI’ll now run the full test suite.",
  "lexicon: 我先": "parser 已修好。\n\n我先跑一次 npm test 確認沒有 regression。",
  "lexicon: 我再去": "parser 已修好。\n\n我再去確認 lint 有沒有過。",
  "lexicon: 我繼續": "parser 已修好，還剩 lint。\n\n我繼續處理 lint 的錯誤。",
  "lexicon: 我會在 (lookahead excludes 在)": "parser 已修好。\n\n我會在這個分支上補齊單元測試。",
  // D. closing-window gaps
  "window: promise paragraph >40 chars, then a status paragraph": "parser 已修好。\n\n接下來我會跑完整測試確認沒有 regression，然後再把 lint 的兩個錯誤修掉。\n\n" + filler,
  "window: promise, then a table longer than the 400-char tail": "parser 已修好。\n\n接下來我會跑完整測試。\n\n| 檔案 | 狀態 |\n|---|---|\n" + Array.from({ length: 14 }, (_, i) => `| src/module-${i}.mjs | 已修改並更新 |`).join("\n"),
  // E. admitted-incomplete gaps
  "incomplete: 尚未驗證": "parser 的修改已完成，但尚未驗證。",
};

for (const [name, text] of Object.entries(CASES)) {
  test(`FN ${name}`, () => {
    const verdict = classifyEarlyFinal(text);
    assert.equal(verdict.decision, "continue", JSON.stringify(verdict));
  });
}

// --- steps the guard must never push --------------------------------------

test("F1: waiting on the USER is not a phantom wait", () => {
  allowAll({
    "en-wait-goahead": "Migration script is ready.\n\nI'll wait for your go-ahead before running the migration.",
    "en-wait-approve": "Plan is written.\n\nI'll wait for you to approve the plan.",
    "en-waiting-confirm": "Draft is ready.\n\nWaiting on your confirmation.",
    "zh-wait-reply": "草稿已備妥。\n\n我會等你回覆再動手。",
    "zh-user-report": "請你在 staging 手動驗證一下登入流程，等你回報結果後我再繼續。",
  });
});

test("F2: 'once you confirm / after you approve / pick one' gates are not promises", () => {
  allowAll({
    "zh-confirm-then": "修正方案如上。\n\n你確認後我會開始改。",
    "en-once-confirm": "The fix is drafted.\n\nOnce you confirm, I'll proceed with updating the config.",
    "en-after-approve": "The fix is drafted.\n\nAfter you approve, I'll update the config.",
    "zh-menu": "選項：\n\n1. 改 parser\n2. 改 tokenizer\n\n我建議 1，你選好後我會接著實作。",
  });
});

test("F3: destructive / external-side-effect next steps are never pushed", () => {
  allowAll({
    "tf-destroy": "Plan 看過了。\n\n接下來我會執行 terraform destroy 清掉舊環境。",
    "drop-table": "備份完成。\n\n接下來我會 drop 掉舊的 sessions table。",
    "rm-reset": "分析完成。\n\n接下來我會執行 rm -rf dist 和 git reset --hard。",
    "airkit-write": "預覽沒問題。\n\n接下來我會跑 airkit update --profile oneportal-lowcost --write。",
    "remove": "找到重複的設定。\n\n下一步我會移除舊的 hook 設定。",
    "overwrite": "找到問題。\n\n接下來我會覆寫使用者的 settings 檔。",
    "apply-zh": "設定已產生。\n\n接下來我會套用新的設定到 cluster。",
    "scale": "確認過 replicas。\n\n接下來我會 kubectl scale deployment api --replicas=0。",
    "jira": "根因已找到。\n\n接下來我會到 Jira 開票並指派給負責人。",
    "slack": "報告完成。\n\n接下來我會發 Slack 訊息通知團隊。",
    "email": "Report done.\n\nNext I will send the summary email to the team.",
    "install-g": "建置成功。\n\n接下來我會執行 npm install -g . 安裝到全域。",
    "rotate": "外洩確認。\n\n接下來我會 rotate 這把 API key。",
    "uninstall": "Found the stale package.\n\nNext I will uninstall it and clean the cache.",
    "kill": "找到卡住的 process。\n\n接下來我會 kill 掉它。",
  });
});

test("F4: production next steps outside the literal word list still hit the production gate", () => {
  allowAll({
    "prd": "testing 驗證完了。\n\n接下來我會到 prd 叢集查看 pod 狀態。",
    "shengchan": "testing 驗證完了。\n\n接下來我會到生產環境查看 pod 狀態。",
    "zhengshi": "testing 驗證完了。\n\n接下來我會到正式機查看 log。",
    "live": "Staging looks fine.\n\nNext I will check the live cluster.",
    "online-cluster": "testing 驗證完了。\n\n接下來我會連到線上 cluster 重跑 job。",
    "prod-next-sentence": "testing 驗證完了。\n\n接下來我會照同樣步驟處理。目標是 production 的 api deployment。",
  });
});

test("F9: a question in an earlier paragraph still vetoes the push", () => {
  allowAll({
    "q-earlier": "我已備妥修改，但 migration 會改到 schema，要我現在就在 staging 開始嗎？還是先等 DBA 看過？\n\n接下來我會執行 migration 並回報結果。",
  });
});

// --- class samples -------------------------------------------------------

const cont = [
  "lint 錯誤找到了，在 src/x.mjs:12。\n\n我現在就去修這一行並重跑 lint。",
  "已讀完三個 log。\n\n下一步我會比對兩個時間窗的 error rate。",
  "Found the regression in the tokenizer.\n\nNext, I'll write a failing test for it and then patch the tokenizer.",
  "I've located the config.\n\nNow I'll verify the schema against the docs.",
  "改好一半了，test/a.test.mjs 還沒改。\n\n接著我會把剩下的 test/a.test.mjs 改完再跑測試。",
  "根因看起來是 race condition。\n\n我先寫一個重現腳本確認。",
  "Let me re-run the failing suite to confirm the fix.",
  "The fix is in place, but it has not been tested yet.",
  "調查到一半。\n\n我會繼續查 worker 的 log，找出卡住的那個 job。",
  "README 已更新。我們接下來會補上 CHANGELOG 的條目。",
];
const allow = [
  "全部完成：npm test exit 0、lint 乾淨。",
  "已修好並驗證。如果之後還有類似錯誤，我會先看 worker log。",
  "我建議先跑 `npm test`，再決定要不要合併。",
  "Here is the plan:\n\n1. Fix the parser\n2. Add tests\n\nShall I start?",
  "修好了。接下來我會把 MR 標成 Ready 並合併。",
  "測試通過。下一步我會 pu" + "sh 到 origin 並開 MR。",
  "Done. Next I'll deploy to staging.",
  "已修改完成。接下來我會重啟 ccr daemon 讓設定生效。",
  "分析完成。接下來我會到正式環境查 pod 的狀態。",
  "需要你先登入 aws-vault，接下來我才能查 bucket。",
  "我無法連線到 internal-testing.example（被 SSO 擋住）。接下來我會改用本機資料。",
  "目前 sandbox 擋住了推送，請你在本機執行 `g" + "it pu" + "sh origin fix/x`。",
  "以上是三個選項，我傾向 B。你覺得呢？",
  "這個問題的答案是：會，GPT 會先讀 CLAUDE.md。我會建議你把規則放在專案層。",
  "Phase 1 done (tests green). Stopping here for your review before phase 2.",
  "我已把報告寫到 /tmp/x.md。如果你同意，我會接著開 Jira 票。",
  "完成。順帶一提，我會在下次 session 開頭先讀 gotchas.md。",
  "I'll be honest: the earlier claim was wrong, the log does not show a retry.",
  "部署 pipeline 還在跑，結果會出現在 Argo 上。",
  "已寫入 reports/x.md。\n\n未驗證：live 呼叫（需付費），未執行。",
  "接下來我會寄信給 vendor 說明這個問題。",
  "Next I will run `terraform apply` to roll this out.",
  "下一步我會刪掉舊的 S3 bucket。",
  "我會等你確認 MR 內容後再繼續。",
];
test("class samples: workspace promises continue, everything else passes", () => {
  const missed = cont.filter((text) => classifyEarlyFinal(text).decision !== "continue");
  const pushed = allow.filter((text) => classifyEarlyFinal(text).decision !== "allow");
  assert.deepEqual({ missed, pushed }, { missed: [], pushed: [] });
});
