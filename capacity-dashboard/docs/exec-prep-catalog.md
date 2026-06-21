# 実行準備フレームワーク 深化カタログ（研究→統合・2026-06-21）

> status: **設計確定（実装待ち）**。研究Workflow(w1r166k63・7エージェント)が軍事/PM/研究/仕事術・行動科学/政治段取り/リスク監視の6領域を収集→統合。
> 全プラグインは既存 plugin shape `{id,label,icon,max,symptoms,defaults,render,wire,score}` に準拠し、onApply は既存データ(Vikunjaリレーション/plan/comment/label/priority/保護枠/backcast/notify/pomodoro)のみに還元（新規DB不要）。
> 正本ハンドオフ: docs/exec-support-handoff-20260620.md。実装は exec-support.js への委譲（マーカー方式）。

## ロールアップ

既存7プラグインを基盤に、6領域（軍事ドクトリン/PM/研究エンジニアリング/仕事術・行動科学/政治・段取り/リスク監視）から重複排除して新規16個を統合し、計23プラグインのカタログを設計した。設計原則は「実装可能性最優先」＝全プラグインが既存の plugin shape({id,label,icon,max,symptoms,defaults,render,wire,score})に厳密準拠し、onApply は Vikunjaの既存リレーション(precedes/follows/blocked)・plan枠(start_minute)・comment・label・priority・protected windows・backcast・notify・pomodoro という既存機能だけに還元する（新規データ基盤ゼロ）。「絶対に期限内」を担保する三本柱: (1)上流で曖昧を殺す(commanders_intent/backbrief/hypothesis_dod)、(2)他者依存と未知を最前方で前倒し解消(dependencies/unknowns_register/stakeholders/raci_delegate)、(3)ペースのズレを早期検知し再逆算で巻き返す(schedule-CCPM/review_cadence/early_warning/kill_pivot/aar)。7つのシナリオ別ワンクリックセットで状況に応じた合理的な順序付き布陣を提供。メーターは既存の『有効プラグインのみで正規化』を踏襲し、載せた手法を全充足しないと100%にならない＝「もう実行されるしかない状態」の意味を保つ。段階導入は基盤→逆算強化→他者依存監視→学習ループの4波。

## プラグイン・カタログ（32個）

### next_step — 次の一歩  〔既存・core・20pt〕
- 目的: 2分で始まる最小物理動作を1つ決め、着手の壁を物理的に下げる
- 症状(symptom): 曖昧/着手の壁
- 入力(fields): text(2分で始められる最小の物理動作・1行)
- 反映(onApply): 「今すぐ着手」導線と連動。押下でポモドーロ(startFocusFor)起動。データはprep保存のみ

### steps — 段取り  〔既存・core・15pt〕
- 目的: 順序付き手順+各手順に見積/期日。締切からの逆算スケジュールの母体
- 症状(symptom): 大きすぎ/曖昧
- 入力(fields): items:[{title, est(見積h), due, done, doing(WIP用), is_gate, gate_criteria, slice(骨格縦), main_effort(主努力), kind(自作業/承認/レビュー/外部待ち), waitOn}]
- 反映(onApply): 既存: 並べ替え・done管理。拡張: is_gate→内部マイルストーン強調+notify、slice=true群を先頭へ並べbackcastで今日寄り前方配置(walking skeleton)、main_effort→priority>=4でdeep枠解放、kind!=自作業はリードタイムh分容量消費。backcastが各手順にdue割当

### schedule — 予定化（逆算＋バッファ＋fever）  〔既存・core・15pt〕
- 目的: 締切から逆算しカレンダー時刻枠/期日へ。容量/祝日/休暇/保護枠/バッファ考慮＋CCPM前倒し締切とバッファ消費率の信号化
- 症状(symptom): 計画が予定に落ちてない/先延ばし
- 入力(fields): due, note, blockStart(時刻枠), blockMin, personalDueOffset(前倒し営業日数・既定2), aggressive_pct(各手順から抜く安全余裕率・既定30), project_buffer_days(自動算出=抜いた合計の半分・上書き可), buffer_alert(緑<黄<赤%・既定50/75)。保護時間帯エディタ流用
- 反映(onApply): 既存: due変更でupdateTask(due_date)反映+backcast実行+overcommitバナー。拡張: 前倒し締切ISO(本due-N営業日)をbackcastのdeadlineIsoに渡し全手順を手前圧縮、各手順estをest×(1-aggressive%)に縮め余裕を末尾project_bufferへ集約、committedByDayと経過から推定バッファ消費率を計算しfeverバー(緑/黄/赤)描画、赤でovercommitBanner点灯+巻き返し誘導。blockStart指定でlogPlan(start_minute)時刻枠予約

### if_then — if-then トリガー（複数・連鎖）  〔既存・core・15pt〕
- 目的: 状況→行動を着手・再開・誘惑遮断で複数連鎖配線し、実行の意志判断を迂回
- 症状(symptom): 先延ばし/割り込み
- 入力(fields): items:[{kind(着手/再開/誘惑遮断 select), when(いつ・どこで), then(何をする)}]（後方互換: 先頭itemをwhen/thenにも写す）
- 反映(onApply): prep保存+後方互換。「今すぐ着手」時に着手kindのトリガー文をトースト表示しリハーサル。再開/誘惑遮断は中断復帰の手がかり。データ反映のみ(plan/通知は他プラグイン担当)

### prereqs — 必要なもの（外部前提・承認対応）  〔既存・core・15pt〕
- 目的: 物/情報/承認のチェックリスト＋他者が握る外部前提を入手先・入手期限まで踏み込み依存タスク化
- 症状(symptom): 準備不足/依存
- 入力(fields): items:[{text, done, source(入手先=人/部署/システム), needBy(入手期限), externalKind(自分で用意/承認/アクセス権/他者成果/確定情報), waitTaskId}]
- 反映(onApply): 既存: done率で加点。拡張: externalKind!=自分で用意 の未入手行に「依存を張る/入手依頼」→既存taskあればaddRelation(self,waitTaskId,'blocked')、無ければcreateTaskInProject+addAssignee(source)+due=needByで入手タスク発行しblocked関連。needByをnotify前日リマインド。全前提doneで「着手可能(ready)」バッジ

### obstacles — 想定する壁＋対策（WOOP/プレモーテム）  〔既存・high・12pt〕
- 目的: 想定する壁＋対策(WOOP)を、致命的失敗シナリオから逆算する事前検死で網羅化し各敗因に予防・検知・対応を持たせる
- 症状(symptom): 不安/不確実性/挫折予感
- 入力(fields): items:[{obstacle, plan}]＋premortemモード: scenario(失敗の一文), risks:[{cause, likelihood(low/mid/high), prevent(予防), signal(早期警告サイン), contingency(発生時即応)}]
- 反映(onApply): 既存: 壁+対策。拡張(premortem): preventをprereqsへ転記、依存先起因のcauseは確認/督促を子タスク化+addRelation(precedes)で先行依存、signalはearly_warningへ供給、contingencyはbackcastのバッファ判断材料。likelihood=highの未対策があればschedule daily_buffer_pct引き上げ提案+次の一手に昇格

### dod — 完了の定義（仮説と合否ライン）  〔既存・high・10pt〕
- 目的: 「これができたら終わり」を一言で。検証可能な仮説と合格ラインに変換しスコープ暴走と過剰品質を止める
- 症状(symptom): ゴール不明確
- 入力(fields): text(完了状態)＋hypothesis(検証する仮説), metric(測る指標), threshold(合格ライン), verifyHow(検証方法), result(実測記入欄)
- 反映(onApply): 既存: 非空で加点。拡張: hypothesis+metric+thresholdをtask.descriptionの受け入れ条件として追記(updateTask)、verifyHowをsteps末尾に[検証]手順として追加しbackcastで締切直前枠確保、result>=thresholdの時のみ満点+logActivity「目的達成」+percent_done=100候補トースト。未達はkill_pivot/再逆算へ誘導

### commanders_intent — 指揮官の意図  〔新規・high・15pt〕
- 目的: 上位目的・終末状態・絶対外さない必須条件を1段落で固定し、計画が崩れても目的を見失わず自己裁定できる北極星を作る
- 症状(symptom): 曖昧/不確実性/燃え尽き
- 入力(fields): purpose(上位目的=なぜやるか・1行), endState(終末状態=終わったとき世界はどうなっているか・1行), mustHold(絶対外さない必須条件1〜3個 配列), acceptableLoss(間に合わなければ削ってよい要素・任意)
- 反映(onApply): purpose+endStateが非空でtask.description先頭に「◎意図/終末状態」ブロックをupsert(updateTask)。mustHoldはobstacles/stepsの必須フラグへ内部タグで橋渡し。今すぐ着手/逆算の確認ダイアログ冒頭にendStateを再掲し「目的に照らしてこの手順か」を一拍置かせる

### mit_today — 今日のカエル（最重要・朝イチ枠）  〔新規・high・15pt〕
- 目的: 今日これだけは絶対の1件を意志力最大の朝イチ枠に物理確保し、着手遅延を0にする
- 症状(symptom): 曖昧/先延ばし
- 入力(fields): frog(今日これだけは絶対の1件・本タスク名を既定流用), slotDate(既定=今日), slotStart(時刻・既定09:00), estMin(確保分数・既定=タスク見積or 60), isFrog(このタスクを今日のカエルに指定)
- 反映(onApply): isFrog=ONでlogPlan(taskId, estMin*60, slotDate, '今日のカエル', me.id, slotStart→start_minute)を呼び日別planの最早枠に確保→committedHoursByDayへ即反映され他タスク逆算がこの枠を避ける。updateTaskでstart_date=今日。朝イチ枠配置済みで満点、日付のみ半分

### dependencies — 依存・連絡待ちを先に起動  〔新規・high・15pt〕
- 目的: 他者・承認・データ・外部納品など自分が制御できない待ち時間を最前方で起動し、相手のリードタイムを逆算に織り込む（真のボトルネック）
- 症状(symptom): 依存/忘却/不確実性
- 入力(fields): items:[{what(必要なもの・例 部長承認/APIキー), from(相手/出所), leadDays(相手の所要日数), requestedOn(依頼日・既定今日), neededBy(必要期日・締切逆算), followUpOn(催促日), arrived(入手済)}]。leadDaysから最遅依頼日を自動算出し過ぎれば赤
- 反映(onApply): 未依頼行に「今すぐ依頼」→setTaskWaiting(連絡待ちlabel)。leadDaysをbackcastの前段オフセットとして引き作業開始可能日を後ろにずらす(依存が解けるまで実作業を置かない)。followUpOnをnotifyリマインダ登録。関連他タスクにaddRelation(follows)。全arrived=trueで「依存クリア・着手可」。requested=ONで催促忘れ防止のため完了相当扱い

### raci_delegate — 役割分担と委譲  〔新規・high・15pt〕
- 目的: 作業ごとにR/A/C/Iを割り当て、自分がRでない部分を相手の期日付きタスクとして即発行し抱え込み(=確定遅延)を解消
- 症状(symptom): 依存/燃え尽き/曖昧
- 入力(fields): items:[{part(作業/成果物), r(実行者), a(最終責任者・1人必須), c(相談先), i(報告先), dueRaw(相手期日), est(相手見積h), delegated(発行済み), taskId(発行先id)}]。A複数はWARN
- 反映(onApply): r≠自分の行に「委譲する」→createTaskInProject({title:親—part, due_date, time_estimate})+addAssignee+addRelation(newId,self,'follows')(相手完了が先行)+delegated記録。委譲済み未完了はsetTaskWaiting相当で連絡待ち。aをassigneesへaddAssignee。i(報告先)はcomms_planへ引き継ぎ。自分がRの作業0なら満点、あれば委譲率比例

### stakeholders — 関係者と根回し  〔新規・high・15pt〕
- 目的: 成否を左右する関係者を権力×関心で象限化し、承認者・意思決定者に先回りで合意形成して承認No/No-Responseを構造的に封じる
- 症状(symptom): 依存/不確実性/割り込み
- 入力(fields): items:[{name, role(意思決定者/承認/影響/被影響/協力), power(高/中/低), interest(高/中/低), stance(賛成/中立/反対/不明), need(この人が必要とすること), action(先回りアクション), done(接触済み)}]。象限はpower×interestでバッジ自動算出
- 反映(onApply): action入り行を「○○へ根回し: △△」としてprereqsへ注入(チェックリスト化)。意思決定者/承認ロールでdone=falseが残るうちは「承認者未接触」警告をovercommitバナー脇に表示。協力者をaddAssignee候補に。stance=反対が1人以上残ればobstaclesへ「○○が反対→対策」自動生成。意思決定者/承認が1人以上登録され全員doneで満点、接触率比例

### unknowns_register — 未知を先に潰す  〔新規・high・18pt〕
- 目的: まだ分からないこと・最も崩れたら致命的な前提を列挙し、解消方法・証拠条件・期日を持たせ締切逆算で最優先で今日寄りに前方配置（終盤崩壊の指数的コストを前倒しで殺す最高ROI）
- 症状(symptom): 不確実性/依存/先延ばし
- 入力(fields): items:[{unknown(未知/前提), impact(high/med/low), resolveBy(解消方法・例 試しに1件APIを叩く), evidence(解消の証拠条件・例 200が返る), due(解消期日), resolved(済)}]。impact=high未解消は強調
- 反映(onApply): impact=high未解消行→stepsへ「[先行検証] {unknown}」をest/due付き自動挿入しbackcastで締切手前でなく今日寄りに前方配置(floor=今日)。各dueをカレンダー枠/notify(lead)に載せ、resolveBy未記入の高impactは予定化カードに赤バナー。resolved=trueでlogActivity「未知解消」記録

### eisenhower — 緊急×重要（今これを確定）  〔新規・high・10pt〕
- 目的: 緊急度×重要度の2軸で象限化しDo/Schedule/Delegate/Deleteを機械的に確定、選択麻痺と雑務侵食を止める
- 症状(symptom): 曖昧/割り込み
- 入力(fields): important(重要か), urgent(緊急か=due_dateと今日差から自動初期化・上書き可), action(自動: 今すぐ着手/予定化/委譲/やめる), delegateTo(委譲先・象限が委譲のとき)
- 反映(onApply): 重要×緊急→updateTask(priority=4)+「今すぐ着手」強調。重要×非緊急→scheduleの予定化へ自動誘導。非重要×緊急→delegateToをassignee変更orraci_delegateへ。非重要×非緊急→取り下げ提案(done/削除)。important/urgent判定済み+action確定で満点

### kill_pivot — 撤退・方針転換・Plan-B分岐  〔新規・high・12pt〕
- 目的: 「この条件・期日に達したら別手段に切替/縮小して締切死守」を着手前に数値・期日で固定し、サンクコストで沈む方針にしがみつくのを防ぐ安全弁
- 症状(symptom): 不確実性/依存/燃え尽き
- 入力(fields): items:[{trigger(発火条件・例 6/25に結合テストが通らない), checkDate(判定日), fallback(代替/縮小案), kind(縮小/委譲/代替/撤退), owner(誰が判断)}]。checkDate行はカレンダー化
- 反映(onApply): checkDateをnotifyリマインダ+当日plan枠に登録し「撤退条件チェック」を強制想起。fallbackをobstaclesの対策側にミラー。発火時ワンタップでschedule再逆算(fallbackの縮小手順で締切に収め直す)。kind=委譲はaddRelation(follows)/担当変更導線。判定日超過でresolvedされない行はメーター赤字で放置可視化

### early_warning — 早期警告サイン（トリップワイヤー）  〔新規・high・10pt〕
- 目的: 「この先行指標がこの閾値を踏んだら手を打つ」を登録し各種既存データで自動監視→赤信号で能動通知（遂行率の最後の安全網）
- 症状(symptom): 発覚遅れ/停滞放置/不確実性
- 入力(fields): wires:[{indicator(中間ゲート未達/バッファ消費超過/着手後N日無進捗/見積超過率/依存タスク未完 select), threshold(閾値・例 3日/120%), action(踏んだらどうする)}], stallDays(無進捗を停滞とみなす営業日・既定3)
- 反映(onApply): 各wireを既存データで評価—無進捗はactivity/getTimes最終日とstallDays比較、見積超過率はestimateVsActual、依存未完はrelated_tasks、ゲート未達/バッファ超過はsteps gate/schedule fever結果参照。踏んだwireはnotifyEvents経路で能動通知+home/activityに赤信号+action提示。logActivityに発火記録。未対応発火は次の一手最優先に昇格

### review_cadence — 進捗レビュー・中間ゲート（定例）  〔新規・medium・10pt〕
- 目的: 締切までに到達目標%付き中間チェックポイント/関門を等間隔に置き通知、遅延を小刻みに早期検知して巻き返し可能なうちに軌道修正
- 症状(symptom): 先延ばし/燃え尽き/不確実性
- 入力(fields): interval(毎日/2日/毎週), checkpoints:[{date(締切まで等間隔自動生成・編集可), target_pct(線形配分・編集可), title(関門名・任意), deliverable(この時点で出来ているべき状態・任意ゲート用)}], share_with(共有先), notify_lead(リマインド前倒し)
- 反映(onApply): 本体dueとintervalでcheckpoint日付を等間隔生成しtarget_pct線形配分。各checkpointをnotify登録(当日「目標◯%到達してる?」)。現在percent_done<target_pctなら遅延フラグ+巻き返し導線。deliverable付きはゲートとして手前の手順全doneまで未通過表示。share_with指定で各checkpointにcreateComment足跡

### deadline_nego — 締切交渉の準備（確約日）  〔新規・medium・10pt〕
- 目的: 対外締切と現実的確約日を分け容量で実現可能性を判定。無理ならTarget/Reservation/BATNAを持って交渉し達成可能な期日へ再設定（黙って遅れる代わりに早期交渉）
- 症状(symptom): 不確実性/先延ばし/割り込み
- 入力(fields): counterpart(交渉相手), external_due(対外要求締切), target(理想の新期日), reservation(これ以上崩せない妥協期日), batna(合意できない場合の代替=スコープ削減/委譲/別担当), justification(根拠・逆算unplaced数を自動プレフィル), scriptDraft(切り出しの一言・自動下書き), agreedDue(交渉後確定期日)
- 反映(onApply): external_due+stepsからbackcast即試算しunplaced>0なら「この締切は不可能」判定+交渉入力を促す(overcommit連動)。justificationを逆算結果から自動生成。agreedDue確定でupdateTask(due_date)→再backcast→overcommit解消確認。scriptDraftをcreateComment記録。overcommit無ければ満点(交渉不要)、あればtarget+batna両方で満点・片方半分。feasible=可になるまで満点保留

### escalation — エスカレーション経路  〔新規・medium・10pt〕
- 目的: 「N営業日返答が無ければ次は誰へ・どの手段で上げるか」を着手前にif-thenで固定し、催促をためらう心理的摩擦を事前合意済みルールに置換して待ちの滞留に上限をかける
- 症状(symptom): 依存/割り込み/先延ばし
- 入力(fields): items:[{waitOn(待っている相手/事柄), thresholdDays(返答待ちの上限営業日), level1(まず誰へ何で=本人催促/同僚へ), level2(それでもダメなら=上長), channel(対面/チャット/会議), armed(発動監視ON)}]
- 反映(onApply): armed行ごとに「待ち開始日+thresholdDays」を期日とする監視→その日にnotify(lead=0)で「閾値超え→level1へ」発火。対応待ちタスクにsetTaskWaiting+閾値超過でsmartlist連絡待ちに赤フラグ。level1/level2をワンクリックでcreateComment(催促文下書き)or委譲タスク化。if_thenへ「N日返答無ければ→level1」を1組コピー。threshold&level1埋まり1件以上で満点、待ち無し設計も満点

### comms_plan — 報連相プラン  〔新規・medium・10pt〕
- 目的: 誰に何をどの頻度・手段で報告/連絡/相談するかを定例化し報告枠をカレンダーに確保、情報不足由来の横やり・手戻りを軽量な定期同期で前倒し
- 症状(symptom): 割り込み/不確実性/燃え尽き
- 入力(fields): items:[{audience(相手), type(報告/連絡/相談), content(何を), cadence(都度/日次/週次/マイルストン), channel(チャット/会議/メール), nextRaw(次回実施日), startMin(時刻・任意), estMin(所要分), scheduled(枠確保済み)}]
- 反映(onApply): nextRaw入り行に「枠を取る」→logPlan(taskId, estMin*60, nextRaw, content, userId, startMin)で当日枠確保→scheduled=true。notify(lead)で報告枠前にリマインド。type=相談で未実施はobstaclesへ「○○の判断未確定→相談で解消」生成。報告実施をcreateComment記録。確保枠はcommittedHoursByDay経由で逆算容量に反映。report/相談含む行が1つ以上scheduledで満点、scheduled率比例

### commitment — 退路を断つ（締切の約束化）  〔新規・medium・10pt〕
- 目的: 締切や宣言を破ると痛い形にして自分に約束させる（公開宣言・監視者・期限前通知・中間報告）。現在バイアスの逆を作り遂行率を底上げ
- 症状(symptom): 先延ばし/忘却
- 入力(fields): publicPromise(誰に何を宣言したか・例 課長に金曜提出と言った), partnerName(進捗を報告する相手・任意), remindLead(締切の何時間/日前に通知・既定1日前), checkinDate(中間報告日・任意), stakeNote(破った時の代償・任意)
- 反映(onApply): remindLeadから本体dueを基準にnotifyリマインダ(notifyPrefs/saveNotifyPrefs)へlead登録。checkinDateありでlogPlonで中間報告の短い枠(15分)確保+partnerNameありならdescription/commentへ「○○へ△△を約束」追記。publicPromise記入で基礎、remindLead設定(通知が張れたら)で満点

### runbook — 再現手順（環境・コマンド・期待結果）  〔新規・medium・10pt〕
- 目的: 誰がいつ動かしても同じ結果になるよう前提環境・実行内容・期待出力を手順に明記し、再開・引き継ぎの立ち上がりコストをゼロに（割り込み中断からの再開摩擦を潰す）
- 症状(symptom): 忘却/割り込み/曖昧
- 入力(fields): prereqs/steps各行に: command(実行内容/コマンド), expected(期待結果・検証法・例 テスト緑/出力にOK), env(前提環境・例 node18,データX)。command持つ行は実行可能チェックリストとして連番表示
- 反映(onApply): command+expected揃った行をtask.descriptionへRunbookブロックとして非破壊追記(updateTask Markdown)＝再現手順が常駐し引き継ぎ可能。expectedをsteps各手順の暗黙DoDに紐付け全充足をdodへ自動反映。env未充足は「今すぐ着手」押下時に警告(空着手防止)

### backbrief — 復唱確認  〔新規・medium・8pt〕
- 目的: 計画を自分の言葉で「こう理解しこう実行する」と要約し直し、理解のズレ・前提の抜けを着手前に炙り出す
- 症状(symptom): 曖昧/依存/先延ばし
- 入力(fields): myUnderstanding(この依頼を自分はこう理解した・1〜2行), firstThreeMoves(最初の3手を自分の言葉で), successTest(成功と言える判定=DoDと矛盾しないか), openQuestions(着手前に確認が要る不明点 配列)
- 反映(onApply): openQuestionsが1件以上で「確認待ち」子タスク生成(createTaskInProject)+addRelation(precedes)で本タスクを後続化(確認が済むまで実行が前に出ない)+WAITING_LABEL付与(setTaskWaiting)。myUnderstandingがDoD/意図と食い違えばwarn。提出済みbackbriefをcreateComment記録

### main_effort — 重点（主努力）  〔新規・medium・8pt〕
- 目的: 全手順を平等に扱わず「これが成れば勝ち」の主努力を1つ指定し最良の時間帯・最大集中を先に確保、残りは支援/間引き対象に格付け
- 症状(symptom): 曖昧/燃え尽き/割り込み
- 入力(fields): mainEffortStep(成否を決める主努力の手順を1つ指定), why(なぜ決定点か・1行), supportingSteps(支える手順=自動格付け), trimCandidates(間に合わない時に削る支援作業)
- 反映(onApply): mainEffortStepに印+priorityを高(>=4)へ引き上げbackcastでディープワーク枠を実空きに使う。主努力手順を逆算で最も保護された/早い時間帯へ優先配置しlogPlan(start_minute)で集中枠予約。trimCandidatesはovercommit発火時に「まずここを削る」候補として提示し主努力を守ったまま容量超過解消

### timebox — タイムボックス＋前倒し締切  〔新規・medium・12pt〕
- 目的: 各手順に使い切る時間の上限を課し本締切手前に人工締切を置く。完璧主義の磨きすぎを断ち楽観見積りの事故を構造的に防ぐ
- 症状(symptom): 先延ばし/不確実性
- 入力(fields): personalDueOffset(本締切の何営業日手前を自分の締切に・既定2), defaultBoxMin(各手順の既定タイムボックス分・例30), hardStop(ボックス超過で次手順へ強制移行運用にするか), paretoNote(80点で良い範囲のメモ・任意)
- 反映(onApply): personalDueOffsetから前倒し締切ISO(本due_dateを営業日でN日戻す)を算出しbackcastのdeadlineIsoに渡す(全手順を手前圧縮・バッファ確保)。defaultBoxMinをsteps各est空欄へ流し込みlogPlan枠長にも使用。hardStop=ONで「今すぐ着手」のポモドーロをボックス長で起動。注: scheduleのpersonalDueOffsetと重複するため単独有効化時のみ使用、schedule併用時はscheduleが優先

### vertical_slice — まず薄く一本通す  〔新規・medium・8pt〕
- 目的: 層ごとに積むのでなく入口から出口まで最小品質で貫通する細い縦の筋を最初に完成させ、統合リスクを早期解消し時間切れでも動く最小成果を残す
- 症状(symptom): 大きすぎ/不確実性/燃え尽き
- 入力(fields): steps各行にslice(この手順は骨格(縦)か)。骨格手順を先頭グループに集約し「最初の一周(動く最小)」として可視化、残りは肉付けグループ。骨格だけの所要h合算で最短で動く版の見積表示
- 反映(onApply): slice=true群をsteps先頭へ並べ替えbackcastでまず骨格群を今日寄り前方配置(最短walking skeleton完成日確保)。骨格完了日を中間マイルストーン化(plan枠+notify)。骨格全完了で「動く最小版あり」logActivity+percent_doneを骨格比率で暫定更新(時間切れでも部分点)。肉付けはkill_pivotのfallback候補に

### spike — 探りスパイク  〔新規・optional・8pt〕
- 目的: 本実装前に判断に必要な答えだけを得る使い捨て小実験を時間箱固定で走らせ、終了時に必ず学びを記録して打ち切る（沼で時間を溶かすのを物理的に止める）
- 症状(symptom): 先延ばし/不確実性/燃え尽き
- 入力(fields): question(答えたい問い・例 この量をこのライブラリで捌けるか), box(時間箱h・既定2), startWhen(いつやる), throwaway(使い捨て前提・既定on), finding(学び/結論・終了後記入), decision(続行/方針変更/中止)
- 反映(onApply): question+box記入でif_thenへ「{startWhen}になったら{box}hタイマーで{question}を試す」を1組生成+ポモドーロ(startFocusFor)をbox長で起動。box終了をnotifyで打ち切り通知。finding記入でlogActivity学び記録、decision=方針変更/中止でkill_pivot or schedule再逆算トースト。throwaway成果物はDoDに含めない

### rehearsal — 予行（ドライラン）  〔新規・optional・8pt〕
- 目的: 本番前に手順を声出し/紙上で一度通し走行し、詰まる箇所・所要時間・抜けを実地で洗い出して見積りを較正（逆算精度が跳ね上がる）
- 症状(symptom): 準備不足/曖昧/着手の壁
- 入力(fields): walkthroughDone(各手順を口頭/紙で通したか=手順ごとチェック), frictionFound(通しで詰まった箇所 配列), estRevised(較正後見積り上書きフラグ), firstMoveTried(最初の一手を実際に1分試したか)
- 反映(onApply): frictionFoundから不足判明でprereqsへ自動追加。estRevisedでsteps[].estを較正値更新+直後にbackcast再実行を促す(予行の現実見積りが期日割当へ即反映)。firstMoveTried=trueはnext_step充足と連動し着手の壁を下げる。予行完了をlogActivity記録

### wip_pace — 進行中を1つに絞る＋持続可能ペース  〔新規・optional・8pt〕
- 目的: 同時着手をWIP上限に絞り1件ずつ完遂させ、1日上限負荷・休憩リズム・同時タスク数で容量超過と燃え尽きを着手前に止める
- 症状(symptom): 割り込み/燃え尽き/曖昧
- 入力(fields): steps各行にdoing(着手中・doneと別軸), wipLimit(同時着手上限・既定1), dailyCapH(1日割ける上限h), restEvery(連続作業◯分で休憩=ポモ長), noWeekend(週末は入れない)
- 反映(onApply): doing=true手順を最上部固定+ポモドーロ対象をその手順に束ねる。doing>wipLimitで警告トースト。手順done化で次の未着手へdoing繰り上げ。dailyCapH/noWeekendをbackcastへ追加制約で渡し上限超の日に置かない。restEveryをstartFocusForへ。上限超過で入り切らなければovercommit合流

### reward_bundle — ごほうび設計（誘惑を味方に）  〔新規・optional・8pt〕
- 目的: 苦手な作業を好きな何かとセットにし完了時の小報酬と着手の儀式を設計、報酬が遠いタスクの現在バイアスを相殺し開始摩擦を下げる
- 症状(symptom): 燃え尽き/先延ばし
- 入力(fields): ritual(着手の儀式・例 コーヒー淹れてイヤホン), bundle(作業中だけ許す好きな事・例 この作業中だけポッドキャスト), microReward(完了時の小さなご褒美), rewardAtPct(メーター何%到達でご褒美合図・既定100)
- 反映(onApply): 「今すぐ着手」時にritual/bundleをトースト表示し着手儀式を促す。メーターがrewardAtPct到達時にmicroRewardを達成演出(es-meter-done)に重ねて表示=即時報酬可視化。完了(logActivity type=done)時にmicroRewardトースト。ritualとmicroReward両方で満点、片方半分

### ooda_recheck — 観測トリガーと再点検  〔新規・optional・8pt〕
- 目的: 実行中に「どの観測が起きたら計画を見直すか」を事前定義し定期re-orient点を置く、逆算を1回計算で終わりでなく観測駆動で回し続けるループへ昇格
- 症状(symptom): 不確実性/先延ばし/割り込み
- 入力(fields): checkCadence(再点検頻度=毎日/隔日/週次), triggers(再計画する観測条件 配列・例 手順が1つでも期日超過/この前提が崩れた), lastReorient(最終点検日=自動記録)
- 反映(onApply): checkCadenceに応じてnotifyリマインダ(lead付き)登録し当日「進捗を観測→逆算し直すか?」を促す。triggers該当(いずれかのstep.due<今日かつ未done等)検知でscheduleカードに「再OODA: 逆算し直す」バナー自動表示しbackcast再実行へ誘導。lastReorientをprep記録+logActivity点検イベント

### aar — 事後ふりかえり（AAR）  〔新規・optional・6pt〕
- 目的: 完了直後に狙い/実際/差分理由/次回改善の4問で短く検死し、見積り精度と手法の効きを次タスクへ累積学習（回るほど精度が上がるシステムにする閉じ手）
- 症状(symptom): 不確実性/燃え尽き/曖昧
- 入力(fields): intended(狙い通りだった点), actual(実際どうだったか), variance(差分理由=見積り過小/割り込み/依存遅延など分類), nextTime(次回への具体改善1〜3個), estAccuracy(見積りh対実績hの自動比較)
- 反映(onApply): 完了時(setTaskStarted→完了)にAARを促し回答をcreateComment永続記録+logActivity学習イベント化。estAccuracyを集計し次タスクのschedule daily_buffer_pct推奨値へ反映(慢性過小見積りなら高め提案)。varianceが依存遅延偏重なら次回backbrief/dependencies、割り込み偏重なら保護時間帯追加を提案=AARが他プラグイン推奨に還流

## シナリオ別セット（7個・1クリックで有効化）

### 重要締切プロジェクト完遂
- 対象: 絶対に落とせない重要な締切が決まった大型タスク。曖昧さ・他者依存・ペースのズレ・燃え尽きを全方位で潰す総合布陣
- 構成(順): commanders_intent → dod → steps → unknowns_register → dependencies → schedule → main_effort → review_cadence → early_warning → kill_pivot
- 根拠: 上流(意図+合否ライン)で目的とゴールを固定→手順化→最も怖い未知と他者依存を最前方で起動→CCPM逆算で前倒し締切+バッファ確保→主努力にdeep枠集中→中間ゲートと早期警告でズレを小刻みに検知→詰んだら撤退/縮小で締切死守。「絶対に期限内」の全要素(曖昧/不確実性/依存/ペース/安全弁)を一筆書きでカバーする最強セット

### 大きく曖昧なタスクの分解着手
- 対象: 何から手をつけるか分からない大きく曖昧なタスク。理解のズレを潰し最小の動く一本から着手の弾みをつける
- 構成(順): commanders_intent → backbrief → next_step → steps → vertical_slice → dod → schedule
- 根拠: 意図で「なぜ・どこまで」を1文化→backbriefで自分の理解と最初の3手・不明点を言語化(曖昧の表面化)→2分の次の一歩で着手の壁を物理的に下げる→手順化→骨格を薄く一本通して動く最小成果を早期確保→合否ラインでスコープ暴走を止める→逆算で日付化。着手不能と過剰品質の両方を潰す

### 割り込み多い環境で死守
- 対象: 会議・チャット・突発依頼で集中が断片化する環境。重要タスクの時間を会計的に守り中断から速く復帰する
- 構成(順): mit_today → main_effort → schedule → if_then → wip_pace → comms_plan → commitment
- 根拠: 今日のカエルを朝イチ枠に物理確保(意志力最大時+他タスク逆算が避ける)→主努力をdeep枠優先→保護時間帯で集中枠を会計的に確保→if-then連鎖で中断復帰トリガーを配線→WIP=1で今の1件を守る→報連相で情報不足由来の横やりを定期同期で先回り抑制→公開コミットで退路を断つ。割り込みのゼロサム侵食を構造的に止める

### 他者依存・承認待ちが多い
- 対象: 承認・レビュー・他部署成果・外部入力など自分が制御できない待ちが律速になるタスク。待ちを最前方で起動し放置を防ぐ
- 構成(順): stakeholders → dependencies → raci_delegate → prereqs → schedule → escalation → comms_plan
- 根拠: 関係者を権力×関心で象限化し承認者に先回り根回し→他者リードタイムを最遅依頼日付きで起動しbackcast前段オフセットに織り込む→自分がRでない作業を期日付き委譲→外部前提を入手期限まで棚卸ししblocked依存可視化→承認リードタイム込みで逆算→閾値超過で自動エスカレーション→報連相で横やり抑制。他者待ちの盲点を全て可視化し放置に上限をかける

### 研究・探索タスク
- 対象: 答えが見えない・技術検証が要る・終盤に未知が爆発しがちなタスク。怖いところを先に触り沼で時間を溶かさない
- 構成(順): commanders_intent → unknowns_register → spike → dod → kill_pivot → schedule → aar
- 根拠: 意図で終末状態を固定(手段が崩れても目的を見失わない)→未知を列挙し証拠条件付きで最優先前方配置→使い捨てスパイクを時間箱固定で走らせ沼を断つ→dodの仮説モードで「どこまでやれば終わりか」を客観化しスコープ暴走を止める→撤退条件で沈む方針にしがみつかない→逆算→AARで見積り精度を次へ累積。終盤崩壊と探索発散の両方を前倒しで殺す

### ルーティンを淡々と
- 対象: 中身が決まっている定常作業を確実に予定どおり消化したい。軽量に予定化し再開摩擦と忘却だけ潰す
- 構成(順): next_step → mit_today → schedule → runbook → if_then
- 根拠: 2分の次の一歩→今日のカエルで朝イチ枠確保→逆算で日付化→Runbookで環境・コマンド・期待結果を常駐させ再開コストゼロ→if-thenで着手トリガー配線。重い手法を載せず、ルーティンに必要な起点・枠・再現性・きっかけだけに絞った最小セット。メーターは少数プラグインで正規化されるので5つ全充足で100%到達しやすい

### 失敗できないリスク高タスク
- 対象: 失敗のコストが極端に高い一発勝負。あらゆる失敗シナリオを先に潰し早期警告と撤退路を完備する
- 構成(順): commanders_intent → obstacles → unknowns_register → rehearsal → review_cadence → early_warning → kill_pivot → commitment
- 根拠: 意図で譲れない必須条件を固定→プレモーテムで致命的失敗シナリオから予防・検知・対応を網羅→未知を前方解消→予行で机上と現実の差を較正→中間ゲートで節目判定→トリップワイヤーで先行指標を自動監視→撤退/縮小路で最悪でも目的死守→公開コミットで遂行を不可逆化。検知と代替の二重三重の安全網を張る

## 実行可能性メーターの設計

【正規化の考え方（既存踏襲）】 メーターは computeScore() が「有効プラグインだけ」の score 合計(got) ÷ max 合計(max) を 0-100% に正規化する。つまり各 scorePts は絶対値でなく『有効化された手法群の中での相対ウェイト』。だからセットで少数を選んでも100%到達可能で、手法を増やすと1つあたりの寄与が薄まる＝「載せた手法は全部充足しないと100%にならない」性質が保たれる。これが「もう実行されるしかない状態」の意味を担保する核。

【加点ウェイトの段階】 既存配点（next_step20 / steps15 / schedule15 / if_then15 / prereqs15 / obstacles10 / dod10）を基準線とし、新規は『実行を物理的に前進/不可逆化させる度合い』で配点:
- 最重量(15-18): 締切達成に直結し他に代替の効かないもの = commanders_intent(15, 北極星/曖昧の最上流), mit_today(15, 当日朝イチ枠確保=実行の起点), dependencies(15, 他者リードタイムは自力短縮不可の真のボトルネック), raci_delegate(15, 抱え込み=確定遅延の解消), unknowns_register(18, 終盤崩壊の指数的コストを前倒しで殺す最高ROI), stakeholders(15, 承認No/No-Responseの構造的封じ)。
- 中量(10-12): 計画の質・早期警告 = premortem(12), kill_pivot(12), timebox(12), eisenhower(10), deadline_nego(10), escalation(10), comms_plan(10), early_warning(10), review_cadence(10), commitment(10), runbook(10), hypothesis_dod(10)。
- 軽量(6-8): 補助・継続・演出 = backbrief(8), rehearsal(8), main_effort(8), wip_pace(8), focus_block(8), vertical_slice(8), spike(8), reward_bundle(8), ooda_recheck(8), aar(6)。

【充足度の刻み（score関数の作法）】 既存に倣い「不可逆な物理反映が起きたか」で満点判定: 単一入力は非空=満点(commanders_intent: purpose+endState両方), チェックリストは done率比例(dependencies: arrived率, prereqs既存踏襲), 2段は片方=半分(timebox/if_then既存), 安全弁=条件達成まで加点保留（deadline_nego: feasible可になるまで満点出さない / hypothesis_dod: threshold達成のみ満点 / dependencies: 依頼発射=requested で『完了相当』にし催促忘れを防ぐ）。これにより『無理な確約に満点を与えない』『未対策のhigh-impact未知を放置すると次の一手に昇格』など、メーターが嘘をつかない設計。

【次の一手ロジック】 既存の「未充足(sc<max)で不足ptが最大の1つを昇格」を維持しつつ、early_warning/kill_pivot/dependencies の発火（判定日超過・閾値踏み・依頼未発射）を最優先で昇格させる上書きルールを足す＝放置を可視化。

## 実装ノート（既存枠への載せ方・段階導入の4波）

【既存枠への載せ方】 全プラグインは既存の PLUGINS 配列要素 = { id, label, icon, max(=scorePts), symptoms, defaults(), render(data,ctx), wire(root,data,ctx,save), score(data) } に厳密準拠。新規プラグインも同じ shape で追加するだけで ON/OFF・並べ替え・メーター集計（computeScore の got/max 加算）に自動で乗る。onApply は既存 schedule カードの backcast 連携と同様、wire 内のボタン押下で api.js の既存ヘルパ（createTaskInProject / addRelation / requestReview / setTaskWaiting / logPlan / createComment / addAssignee / updateTask / saveProtectedWindows）と pomodoro.startFocusFor / notify を呼ぶ。新規データ依存ゼロ＝Vikunjaの既存リレーション(precedes/follows/blocked)・plan(start_minute)・comment・label・priority・protected windows・committedHoursByDay にすべて還元する。

【ハードルール遵守】 capacity-dashboard/CLAUDE.md の委譲契約に従う。exec-support.js は views/ 配下＝指示役は直接編集せず、touch /tmp/cap-view-edit-allow → Agent委譲 → rm の手順でサブエージェントに実装させる。backcast/loadBackcastCtx の拡張（前倒し締切・バッファ集約・floor）も同一ファイル内なので同じ委譲ウィンドウで。

【段階導入の順序】 波1(基盤・即効): commanders_intent / mit_today / focus_block(scheduleへ時刻枠plan追加) / eisenhower。既存7に最小追加で「曖昧→意図、当日→枠確保」を埋める。波2(逆算強化): schedule を CCPM(前倒し締切+集約バッファ+fever)へ拡張、steps に gate/slice/main_effort/wip のサブモード追加、unknowns_register。backcast 改修が要るので単体テスト(lib想定の純関数)を先に。波3(他者依存・監視): dependencies(承認リードタイム+follows+waiting+notify) / raci_delegate / escalation / review_cadence(checkpoints統合) / early_warning。notify.js と activity ログ参照を束ねる統合層なので最後。波4(学習ループ): aar / premortem(obstacles拡張) / kill_pivot / plan_b統合。完了時フックと再逆算誘導。各波ごとに node --check + ブラウザ目視(console 0)で検証し1波=1コミット。

【重複排除の方針】 同義の候補は1つに統合した: premortem(検死)×2→premortem(obstacles拡張); RACI×2 + stakeholders→raci_delegate + stakeholders を分離維持(役割固定 vs 根回し); CCPMバッファ×2→scheduleへ統合; gate/stage-gate×2→steps_gate; 依存先回り×4(critical_path/dependencies/prereqs拡張/approval-backcast)→dependencies 1本に集約+prereqs外部前提拡張; checkpoints/cadence/burndown→review_cadence + early_warning に再編; kill_criteria/plan_b/branches_sequels→kill_pivot 1本; WIP/pace/focus_shield→wip_pace + focus_block。OODA/backbrief/rehearsal/runbook/spike/hypothesis/timebox/vertical_slice/temptation_bundling は汎用度と実装容易性で取捨選択。

