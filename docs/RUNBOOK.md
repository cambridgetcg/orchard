# Runbook：淨係 Yu 先做得嘅步驟

呢份係 Account Holder（即係你）親手要做嘅步驟，已經按次序排好。每一步都寫低「點解」、「點做」、「點驗」。

Agent 唔代你做呢啲嘢，原因有三：要用你嘅 Apple Account 或者 admin 密碼；係法律協議；或者會將嘢放上 Apple／GitHub，做咗之後好難收返。

寫於 2026-10-20。Apple 會改介面字眼：畫面同呢度唔同嘅話，跟畫面做，再話俾 agent 知，等佢改返份文件。標住「（未驗）」嘅位，係 agent 憑推斷寫，未喺真機或者真畫面見過。會證到 ladder 某一級嘅步驟，都有寫明係邊級（ladder 見 [DESIGN.md §1](../DESIGN.md#1-the-ladder)）。

- [x] 0. 確認 Membership，抄低 Team ID（2026-10-20 完成：Mindicraft Limited，`ZXUWDK4J3C`）
- [ ] 1. 裝 Xcode 27.1
- [ ] 2. Xcode 登入 Mindicraft team
- [ ] 3. 接受最新協議
- [ ] 4. EU DSA trader status
- [ ] 5. Mythseal 嘅 Xcode Cloud onboarding
- [ ] 6. TestFlight internal group 同 testers
- [ ] 7. iPhone 上裝嚟試
- [ ] 8. （可選）GitHub Actions 後備路線
- [ ] 9. 免費 app 唔使做嘅嘢
- [ ] 附加：TaxSorted Local（macOS）嘅 Developer ID

---

## 0. 確認 Membership 係 Mindicraft Limited，抄低 Team ID

**點解：** 今日已經決定用 Mindicraft Limited 嘅 organization team 發佈。不過舊 notes 有啲寫 Cambridge TCG Limited，而單靠 email 分唔出係邊個 team 啟用咗。淨係 Membership 頁先講得準。呢一步要喺建立任何 bundle ID 或者 app record 之前做，因為佢哋一建立就跟住嗰個 team，之後要搬就要做 app transfer（淨係 Account Holder 做得，而且唔係即時）。

**點做：**
1. 登入 <https://developer.apple.com/account>，打開 **Membership details**。
2. 對清楚四樣嘢：entity name 係 **Mindicraft Limited**；類型係 **Organization**；你嘅 role 係 **Account Holder**；仲有 **Team ID**（10 個字元）。
3. Team ID 唔係 secret，佢本身就會出現喺 Xcode project 同 AASA 檔入面。將佢填入 `~/orchard/orchard.json` 嘅 `team.teamId`，或者話俾 agent 聽，等佢填。

**點驗：** `node bin/orchard doctor` 入面 Team ID 嗰項唔再係 UNKNOWN。

**如果見到嘅唔係 Mindicraft：** 停喺度，唔好行落去，同 agent 傾過先。

## 1. 裝 Xcode 27.1

**點解：** simulator loop 要本機 Xcode，而 Xcode Cloud 嘅第一個 workflow 一定要喺 Xcode app 入面建立。呢部 Mac（macOS 26.6.2、M2）符合 Xcode 27.x 嘅要求（macOS Tahoe 26.6 或以上，Apple silicon），唔使升 macOS。今日部機淨係有 Command Line Tools 26.4，`xcodebuild` 同 `simctl` 都用唔到。

**點做：**
1. 用 Mac App Store 搜 **Xcode**，然後 **Get** / **Install**，用你自己嘅 Apple Account。
   - 空間：部機有大約 92 GiB 空位。Xcode、iOS simulator runtime（大約 8 GB）同 build cache 加埋，預留 15–25 GB（推斷，Apple 冇公佈實數）。
2. 開一次 Xcode。佢會叫你同意 license 同安裝 components。揀 platform 嗰版剔 **iOS**，咁就會下載 simulator。
3. 想用 Terminal 做都得，效果一樣：

   ```sh
   sudo /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -license accept
   sudo /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -runFirstLaunch
   /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -downloadPlatform iOS
   ```

   用 full path，係因為 `xcode-select` 而家指住 Command Line Tools。Agent 用 `DEVELOPER_DIR` 揀 Xcode，所以唔需要你改 `xcode-select`。如果你自己想喺 Terminal 直接打 `xcodebuild`，可以行 `sudo xcode-select -s /Applications/Xcode.app`，係你嘅選擇，orchard 唔靠佢。

唔好經 agent 用 `xcodes` 或者 `mas` 裝。佢哋要你嘅 Apple Account 密碼、2FA 同 sudo，而且 Apple 一改登入流程就會壞。

**點驗：**

```sh
/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -version
# 應該見到 Xcode 27.1 / Build version 27A9275
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl list runtimes
# 應該見到 iOS 27.x
```

之後 `node bin/orchard doctor` 嘅 toolchain 嗰組應該係 READY。

**留意：** Xcode 27.2 RC 已經喺 2026-10-19 出咗，App Store 可能好快推 27.2。orchard 而家 pin 住 27.1。如果 App Store 俾你嘅係 27.2，話俾 agent 知。另外，**唔好**喺 File inspector 將 project 轉做新嘅 JSON `.xcproj` 格式：Capacitor 嘅 `cap sync` 遇到佢會靜靜雞壞，exit code 照樣係 0（issue #8607，未修好）。

## 2. Xcode > Settings > Accounts 登入

**點解：** 純 simulator 唔使登入，但係真機 build、Xcode Cloud onboarding 同 automatic signing，都要 Xcode 知道你喺 Mindicraft team。

**點做：** **Xcode > Settings… > Accounts**，撳左下角 **+**，揀 **Apple Account**，然後登入。

**唔使**撳 **Manage Certificates…** 整 Apple Distribution certificate。原因：release 交俾 Apple 雲端簽（cloud-managed signing）；部機一有 Apple Distribution cert，Xcode 就會改用本機簽，certificate 就會開始散落喺 laptop。開發用嘅 development certificate，Xcode 有需要會自己整，冇問題。

**點驗：** Accounts 頁右邊嘅 team 列表見到 **Mindicraft Limited**，role 係 Account Holder。

## 3. 接受最新協議

**點解：** Apple 喺 2026-10-13 更新咗 Apple Developer Program License Agreement（DPLA），而淨係 Account Holder 先可以接受。未接受嘅話，可能會擋住建 app 同提交。（Apple 明寫未接受最新 Paid Apps Agreement 會擋建 app；DPLA 會唔會一樣擋，agent 未讀到原文，屬推斷。）

**點做：**
1. 登入 <https://developer.apple.com/account>。如果頂部有 agreement banner，就 review，然後 agree。
2. 再入 App Store Connect（<https://appstoreconnect.apple.com>）嘅 **Business**，睇下有冇 agreement 等緊你接受。（**Business** 呢個名嚟自 Apple 嘅 roles 頁，agent 未見過真畫面。）
3. 免費 app 唔需要 Paid Apps Agreement，見第 9 步。

**點驗：** 兩邊都冇 pending agreement 嘅提示。

## 4. EU DSA trader status

**點解：** Apple 要求每個 developer 申報 trader status，**就算唔喺 EU 發佈都要報**。冇已驗證 trader status 嘅 app，由 2025-02-17 起會喺 EU App Store 落架。報做 trader 嘅話，EU 產品頁會公開一個電話同一個 email；organization 嘅地址就自動用 D-U-N-S 登記地址。

**點做：** 跟 Apple 嘅 help page「[Manage European Union Digital Services Act trader requirements](https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-trader-requirements)」做（Account Holder 或 Admin 做得）。

- 刻意揀聯絡資料：用公司專用嘅電話同 email，唔好用私人電話。電話同 email 要過 2FA 驗證，另外要 upload 公司文件。
- 另一條路係暫時唔喺 EU 上架（Mythseal 嘅 territories 剔走 EU 國家），但係 status 照樣要報。
- Mindicraft 係公司，報做 non-trader 啱唔啱係法律判斷，research 冇定論。

**點驗：** App Store Connect 顯示 trader status 已經 verified。

## 5. Mythseal 嘅 Xcode Cloud onboarding

**前提：**
- 第 0 至 3 步已經做完。
- Agent 喺 mythseal repo 嘅 `ios/first-flight` branch 已經 commit 咗 `Package.resolved` 同 `ios/App/ci_scripts/ci_post_clone.sh`。`Package.resolved` 要先 commit，因為 Xcode Cloud 唔會自己 resolve package；呢個檔要部機有 Xcode 先整得出，所以排喺第 1 步之後。
- 個 branch 已經 push 上 GitHub。Push 係對外動作，要你開口先做。

**點解：** Xcode Cloud 係主要 release 路線。Apple 喺雲端幫你簽，冇 key、冇 certificate 經過 runner；membership 每個月包 25 compute hours。第一個 workflow 一定要喺 Xcode app 入面建立。

**點做：**
1. 喺 `~/Games/mythseal-orchard`（branch `ios/first-flight`）打開 `ios/App/App.xcodeproj`。
2. 揀 **App** target，打開 **Signing & Capabilities**：
   - **Team** 揀 **Mindicraft Limited**；
   - **Bundle Identifier** 應該係 `com.mythseal.game`；
   - **Automatically manage signing** 剔住。

   如果 Xcode 因此改咗 `project.pbxproj`（例如加咗 `DEVELOPMENT_TEAM`），叫 agent commit。（未驗）
3. 喺 Report navigator 撳 **Cloud** 掣，再撳 **Get Started**（Apple 文件嘅寫法）；menu 嘅 **Integrate > Create Workflow…** 都得（未驗）。去到 **Select a Product** 揀 **App**。如果 Xcode 問你揀 team，揀 **Mindicraft Limited**。
4. 去到 **Review Workflow**，撳 **Edit Workflow** 改以下幾項：
   - **Environment**：Xcode 揀 **27.1**，唔好揀「最新版」嗰類選項，因為佢會自己跳版本；macOS 用預設。
   - **Start Conditions**：Xcode 預設係 default branch（main）每次有改動、同埋每個 PR，都會 build 一次。呢個預設要改走，否則會食 compute hours，仲可能每次都上傳 build；而且佢根本唔包 `ios/first-flight`。建議分兩步：
     - **第一次 build**：刪走 **Branch Changes** 同 **Pull Request Changes**，加 **Manual Start**，揀 **Custom Branches**，填 `ios/first-flight`。Apple 文件講明，手動 start 淨係用得喺 Manual Start 列明嘅 branch、tag 或者 PR，所以呢個 branch 一定要喺度，第 7 步先揀得到佢。
     - **第一次 build 綠咗之後**：再加 **Tag Changes**，揀「Tags beginning with」，填 `mythseal-ios-v`（同 GitHub Actions 後備用嘅 `mobile-v*` 分開，免得一個 tag 觸發兩條路線）。之後正式 release 就靠 tag。
     - **唔好**第一次就淨係用 tag 觸發：咁樣 `ios/first-flight` 唔會喺 Start Build 嘅選單度，要 build 就要 push tag，而 push tag 係對外動作。
     （Manual Start、Branch Changes、Tag Changes、Custom Branches 呢幾個名嚟自 Apple 嘅「Configuring start conditions」文件；真畫面未見過，未驗。）
   - **Actions**：**Archive**，platform 揀 iOS。部署準備嗰項建議揀可以去 App Store 嗰個（類似「TestFlight and App Store」）。原因：標住「TestFlight Internal Only」上傳嘅 build，之後**永遠**唔可以俾 external testers 或者上 App Store（呢點已核實；選項名未驗）。
   - **Post-Actions**：加 **TestFlight Internal Testing**，揀第 6 步嘅 group。未有 group 都唔緊要，之後喺 App Store Connect 加返。
5. 去到 **Grant Access**，Xcode 會帶你去 GitHub 授權 Xcode Cloud。`cambridgetcg` 係 personal account，唔係 organization，所以要 repo admin 先授權得，即係你。建議淨係授權 `cambridgetcg/mythseal`，唔好揀全部 repo。
6. 如果未有 App Store Connect app record，Xcode 會幫你開一個。要填：
   - Name：store 名，未定，見 [apps/mythseal.md](apps/mythseal.md) 嘅未決問題；
   - Primary Language；
   - Bundle ID：`com.mythseal.game`；
   - SKU：內部用，例如 `mythseal-ios`。

   **記住：** app record 同 bundle ID 跟 team 走；seller name 一定係 Mindicraft Limited，因為 organization 帳戶用法人名，唔收 trade name。
7. 揀 branch `ios/first-flight`，撳 **Start Build**。（未驗）如果選單冇 `ios/first-flight`，返去 **Edit Workflow**，喺 **Manual Start** 加返呢個 branch 再試；唔好為咗 start build 去 push tag。選單實際出咗邊啲 branch 同 tag，話俾 agent 知，記入 [DECISIONS.md](DECISIONS.md)。

**點驗：**
- Report navigator 嘅 Cloud 見到個 build。
- Archive 成功，就證到 `signed-archive`。
- App Store Connect 嘅 TestFlight 見到 build 處理完，就證到 `testflight-internal`。
- 失敗嘅話，喺 report 撳 **Logs**，將 log 交俾 agent。Log 冇 secret，可以照交。

**未親眼見過嘅位（推斷應該得）：** `ci_post_clone.sh` 喺雲端整出嚟嘅嘢（`node_modules`、`cap sync` 嘅輸出）留唔留到 build 同 archive？Apple 自己教用 CocoaPods 而唔 commit `Pods` 嘅 project，喺 `ci_post_clone.sh` 行 `pod install`，即係 post-clone 整出嚟嘅檔要留到 `xcodebuild`；Flutter 官方文件都係咁做。Apple 嗰句「Xcode Cloud deletes any files a custom build script creates」下半句係「As a result, downloadable Xcode Cloud build artifacts don't include files you create with custom build scripts」，講嘅係下載得返嘅 artifacts，唔係 build 本身。同一段又話 script 整嘅檔「aren't available to other custom build scripts」，所以將來如果加 `ci_pre_xcodebuild.sh`，唔好靠 post-clone 整嘅檔。第一次 build 就係證明（[FACTS.md](FACTS.md#xcode-cloud)）。

## 6. TestFlight internal group 同 testers

**點解：** internal testing 唔使經 Beta App Review。最多可以有 100 個 internal testers，但每一個都要係 App Store Connect user。

**點做：**
1. App Store Connect > **Apps** > Mythseal > **TestFlight**。喺 **Internal Testing** 旁邊撳 **+** 建立 group（例如 `Mindicraft internal`），然後加 testers。
2. 要加新人，就先喺 **Users and Access** 邀請佢做 user，揀做到嘢最少嘅 role。（label 未驗）

**點驗：** tester 收到 TestFlight 邀請。注意每個 build 只可以測 90 日。

## 7. iPhone 上裝嚟試

有兩條路：

**a. 經 TestFlight 裝（`testflight-internal` 之後）**
- iPhone 裝 **TestFlight** app，用 tester 嘅 Apple Account 接受邀請，然後 **Install**。
- 呢條路唔使開 Developer Mode，亦唔使登記 device。
- Mythseal first flight 嘅最低版本係 iOS 16。

**b. 經 Xcode 直接 run（開發 build，即係 `device` rung）**
- 用線將 iPhone 駁落 Mac，揀 Trust。之後喺 **Settings > Privacy & Security > Developer Mode** 打開，重啟再確認一次。
- Xcode 會自動將部機登記落 Mindicraft team。新 membership 頭 10 部 device 即刻用得；第 11 至 100 部要等 24–72 小時處理。
- Xcode 27.1 淨係 debug 到 iOS 17 或以上嘅 device。

**點驗：** app 喺 iPhone 開到，玩到一局，再用 share sheet export 一個存檔出嚟。將結果寫入 [apps/mythseal.md](apps/mythseal.md)：`device` 呢級淨係人先證得到。

## 8. （可選）GitHub Actions 後備路線

淨係 Xcode Cloud 用唔到嗰陣先需要。**Xcode Cloud 唔使 key。**

**點解要諗清楚先做：**
- App Store Connect 嘅 team key 涵蓋 team 入面每個 app，包括將來嘅 TaxSorted。
- Key 嘅 role 建立之後改唔到。
- `.p8` 淨係下載到一次，Apple 唔留副本；revoke 咗就唔可以復原。
- 經 `xcodebuild` 雲端簽，據報要 Admin role。呢個係 forum 報告，Apple 冇明寫。

**點做：**
1. 作為 Account Holder，先 request App Store Connect API access。Apple 會逐個個案批。
2. 喺 App Store Connect **Users and Access** 嘅 API keys 嗰度（Team Keys）generate 一條 key，起個認得嘅名，揀你決定嘅 role，再抄低 Key ID 同 Issuer ID（兩樣都唔係 secret）。然後 download `.p8`，記住只得一次機會。（label 未驗）
3. 存入 Keychain：

   ```sh
   node bin/orchard key import ~/Downloads/AuthKey_XXXXXXXXXX.p8 --key-id XXXXXXXXXX --issuer-id <issuer-uuid>
   node bin/orchard key check
   ```

   佢會將 key 存入 login Keychain，用 hash 驗證存得啱，然後提你自己刪咗個下載檔（佢唔會代你刪）。如果同一個 key ID 已經有 item，佢會拒絕，唔會靜靜雞覆蓋；真係要換先加 `--replace`。

   **要你揀：** 預設之下，任何以你身份行嘅程式（例如某個 npm package 嘅 install script）都可以唔問你就讀到條 key。加 `--require-approval` 嘅話，每次讀都會彈 Keychain 對話框，要你撳 **Allow**（千祈唔好撳 **Always Allow**，一撳就返轉頭變返唔使問）；代價係 `key check` 同 `gh-secret` 每次都要你喺部機前面。詳情同取捨見 [KEYS.md](KEYS.md#what-the-keychain-does-and-doesnt-protect)。
4. 喺 GitHub `cambridgetcg/mythseal` 嘅 **Settings > Environments** 建立 `mobile-stores`。建議加 **Required reviewers**（你自己）：public repo 之下，呢個係 tag push 之後唯一要人手批嘅閘。
5. 將 secrets 放上 GitHub：`node bin/orchard key gh-secret mythseal --yes`。佢經 stdin 寫入 `mobile-stores`，唔經 argv。
6. 設定兩個 **variable**（唔係 secret，可以照打喺 command line）：

   ```sh
   gh variable set APPLE_TEAM_ID --env mobile-stores --repo cambridgetcg/mythseal --body ZXUWDK4J3C
   gh variable set MOBILE_BUILD_OFFSET --repo cambridgetcg/mythseal --body 100000
   ```

   - `APPLE_TEAM_ID`：workflow 嘅 secrets 檢查一定要有佢，冇就喺 build 之前停低。
   - `MOBILE_BUILD_OFFSET`：Xcode Cloud 嘅 build number 由 1 開始數，後備路線用 `run_number` 都係由 1 左右開始，唔加 offset 嘅話，後備第一次上傳就會撞返 Xcode Cloud 用過嘅 build number，App Store Connect 會拒收。100000 令兩條路線嘅號碼唔重疊。iOS 只要求同一個 marketing version 入面 build number 唔重複；但 Android 嘅 versionCode 都用同一個 offset，而 Google Play 只收越嚟越大嘅數，所以呢個 offset **只可以加，唔可以減**。（點解同其他做法見 [DESIGN.md §2](../DESIGN.md#2-release-routes)。）
7. 喺 [DECISIONS.md](DECISIONS.md) 記低用咗咩 role、點解，同埋 offset 幾時設咗做幾多。

**留意：** `workflow_dispatch` 要 workflow 檔已經喺 default branch（main）先 trigger 到。所以 `mobile.yml` merge 入 main 之前，唯一嘅 trigger 就係 push 一個 `mobile-v*` tag，而嗰個就係真上傳。

**留意：** 後備路線用 Xcode 26.6（`macos-26` image 冇 Xcode 27），Xcode Cloud 用 27.1。兩個都上傳得，直到 Apple 2027 年 4 月起要求 iOS 27 SDK；喺嗰之前後備路線要轉 Xcode 27。

**點驗：** `orchard key check` 係 READY；GitHub environment 見到三個 secret 名（`ASC_KEY_P8_B64`、`ASC_KEY_ID`、`ASC_ISSUER_ID`）同一個 variable（`APPLE_TEAM_ID`），repo 層面見到 `MOBILE_BUILD_OFFSET`。睇唔到 secret 嘅值係正常嘅。`node bin/orchard doctor mythseal --online` 嘅 `backup.environment` 會逐個講有冇。

## 9. 免費 app 唔使做嘅嘢

Paid Apps Agreement、banking、tax forms 都唔使做。呢三樣淨係賣 app 或者有 IAP 先需要，而 Mythseal 同 TaxSorted 都係免費。

如果將來要收錢：
- Paid Apps Agreement 一簽就撤回唔到；
- tax forms 要先簽 Paid Apps 先填得；
- banking 要 tax forms 交齊先會處理；
- 英國公司大概要填 W-8BEN-E（推斷，未行過 Apple 嘅問卷）。

## 附加：TaxSorted Local（macOS）嘅 Developer ID（可選，快贏）

**點解：** TaxSorted Local 個 desktop app 而家係 ad-hoc 簽、冇 notarise，用戶一開就會見到 Gatekeeper 警告。同一個 membership 已經包埋 Developer ID。直接派 DMG 唔受 App Store 條款約束，所以 AGPL 同 App Store 嘅衝突唔適用（推斷）。

**點做：** Developer ID Application certificate 淨係 Account Holder 先建得。（cloud-managed 版本嘅話，獲授權嘅 Admin 都得。）喺 developer.apple.com/account 嘅 **Certificates, Identifiers & Profiles** 建立。之後 notarise 嘅設定（electron-builder、notarytool）屬於 taxsorted.io repo，要經 maintainers 開 PR，唔係喺 orchard 做。

**點驗：** 喺另一部 Mac 下載個 DMG，開嘅時候冇 Gatekeeper 警告。
