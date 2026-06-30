// ユーザー/担当の判定 SSoT（葉モジュール＝他 lib を import しない＝循環なし）。
// AI 担当・人間担当の判定を各 lib/view が再実装していたのをここへ集約（横断監査 Q7/Q19/Q36/Q43）。

// AI 担当アカウント（副担当として選択可だが、人間のキャパ計算・メンバー列からは除外する）。
// 実行系: taskstation-fable systemd タイマーが fable 担当タスクを巡回し Claude Code(MAXプラン) で提案コメント。
export const AI_USERNAMES = new Set(["fable"]);

// AI（fable 等）担当かどうか。username で判定（id は WS により異なるため使わない）。
export const isAiUser = (u) => !!u && AI_USERNAMES.has(u.username);

// タスクの人間担当（AI=fable を除外した assignees）。未アサイン扱いの判定はこれを使う。
export const humanAssignees = (t) => (t.assignees || []).filter((a) => !isAiUser(a));

// 人間担当の先頭1人（なければ null）。「担当アバター1人を出す」系の SSoT。
export const firstHuman = (t) => humanAssignees(t)[0] || null;
