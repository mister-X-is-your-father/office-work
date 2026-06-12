// 設定（チーム共有・mock17 相当の実装版）。保存先は taskstation-exec（許可ユーザーのみ書き込み可）。
// ここで 8h/対象WS のハードコードが解消される（HANDOFF §8 の懸案）。
import { load, invalidate, TEMPLATE_WS } from "../lib/store.js";
import { getSettings, saveSettings } from "../lib/exec.js";
import { C, esc } from "../lib/ui.js";

export async function render(root) {
  const { projects, templateProject } = await load();
  let cur = null, canEdit = false;
  try {
    const d = await getSettings();
    cur = d.settings; canEdit = !!d.can_edit;
  } catch {
    root.innerHTML = `<h1 class="vtitle">設定</h1><div class="card"><div class="loading">設定サービス（taskstation-exec）に接続できません。既定値（8h/平日・全WS集計）で動作中です。</div></div>`;
    return;
  }
  const wsList = (projects || []).filter((p) => !templateProject || p.id !== templateProject.id);
  const excluded = new Set(cur.excluded_project_ids || []);
  const hourOpts = (sel) => Array.from({ length: 24 }, (_, h) =>
    `<option value="${h}"${h === sel ? " selected" : ""}>${h}:00</option>`).join("");

  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">設定 <small>チーム共有 ${canEdit ? "" : "・閲覧のみ（変更は管理者）"}</small></h1>
    <div class="st-grid">
      <div class="card st-card">
        <div class="st-h">容量</div>
        <label class="st-l">1人あたりの容量（h/日） <span class="st-hint">（空き・負荷・超過の基準。平日のみ・週末/祝日/休暇は0）</span></label>
        <input id="st-cap" class="st-in st-num" type="number" min="1" max="24" step="0.5" value="${cur.cap_hours}" ${canEdit ? "" : "disabled"}>
      </div>
      <div class="card st-card">
        <div class="st-h">時刻カレンダー</div>
        <div class="st-row">
          <label class="st-l">表示開始
            <select id="st-cal0" class="st-in" ${canEdit ? "" : "disabled"}>${hourOpts(cur.cal_start)}</select></label>
          <label class="st-l">表示終了
            <select id="st-cal1" class="st-in" ${canEdit ? "" : "disabled"}>${hourOpts(cur.cal_end)}</select></label>
        </div>
      </div>
      <div class="card st-card">
        <div class="st-h">集計対象ワークスペース</div>
        <div class="st-hint" style="margin-bottom:8px">チェックを外したWSのタスクは負荷・空き・一覧に含めません（デモ・アーカイブ向け）。</div>
        ${wsList.map((p) => `
          <label class="st-ws"><input type="checkbox" data-ws="${p.id}" ${excluded.has(p.id) ? "" : "checked"} ${canEdit ? "" : "disabled"}> ${esc(p.title)}</label>`).join("")}
        <div class="st-hint" style="margin-top:6px">※「${esc(TEMPLATE_WS)}」WSは常に集計対象外です。</div>
      </div>
    </div>
    <div class="st-acts">
      <span class="st-msg" id="st-msg"></span>
      ${canEdit ? `<button id="st-save" class="st-save">保存</button>` : ""}
    </div>`;

  const btn = root.querySelector("#st-save");
  if (btn) btn.onclick = async () => {
    const msg = root.querySelector("#st-msg");
    const cap = parseFloat(root.querySelector("#st-cap").value);
    const c0 = +root.querySelector("#st-cal0").value, c1 = +root.querySelector("#st-cal1").value;
    if (!isFinite(cap) || cap < 1 || cap > 24) { msg.className = "st-msg err"; msg.textContent = "容量は1〜24で入力してください。"; return; }
    if (c1 <= c0) { msg.className = "st-msg err"; msg.textContent = "カレンダーの終了は開始より後にしてください。"; return; }
    const excludedIds = [...root.querySelectorAll("[data-ws]")].filter((b) => !b.checked).map((b) => +b.dataset.ws);
    btn.disabled = true;
    try {
      await saveSettings({ cap_hours: cap, cal_start: c0, cal_end: c1, excluded_project_ids: excludedIds });
      invalidate(); // 全ビューに即反映
      msg.className = "st-msg ok"; msg.textContent = "✓ 保存しました（全員のビューに反映されます）";
    } catch (e) {
      msg.className = "st-msg err"; msg.textContent = "× " + e.message;
    }
    btn.disabled = false;
  };
}

function css() {
  return `
  .st-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;align-items:start}
  .st-card{padding:16px 18px}
  .st-h{font-size:13.5px;font-weight:700;margin-bottom:10px}
  .st-l{display:block;font-size:12px;color:${C.muted};font-weight:600;margin:8px 0 5px}
  .st-hint{font-weight:400;color:${C.muted};font-size:11px}
  .st-in{font:inherit;font-size:13.5px;padding:8px 10px;border:1px solid ${C.line};border-radius:9px;background:#fff;box-sizing:border-box}
  .st-in:disabled{background:#f4f6f9;color:${C.muted}}
  .st-num{width:110px}
  .st-row{display:flex;gap:16px}
  .st-ws{display:flex;align-items:center;gap:7px;font-size:13px;padding:4px 0;cursor:pointer}
  .st-acts{display:flex;align-items:center;justify-content:flex-end;gap:12px;margin-top:14px}
  .st-msg{font-size:12.5px;font-weight:600;min-height:16px}
  .st-msg.ok{color:${C.free}}.st-msg.err{color:${C.over}}
  .st-save{font:inherit;font-size:13.5px;font-weight:700;padding:9px 22px;border-radius:9px;border:1px solid ${C.fill};background:${C.fill};color:#fff;cursor:pointer}
  .st-save:hover{filter:brightness(1.05)}
  .st-save:disabled{opacity:.6}`;
}
