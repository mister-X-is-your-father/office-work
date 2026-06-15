// エクスポート（バックアップ）— 各エンティティを CSV でフルバックアップ。
// 読み取り＋ダウンロードのみ（破壊的操作なし）。
// データ源: store.load() の集約キャッシュ。load() に無いもの（祝日/休暇の生レコード）は api.js で補完。
import { load } from "../lib/store.js";
import { getHolidays, getUnavailability } from "../lib/api.js";
import { C, esc, todayISO } from "../lib/ui.js";

// ── CSV シリアライザ（RFC4180）。値内の , " 改行 をダブルクオート囲み＋ " → "" でエスケープ。
// 先頭に UTF-8 BOM を付与（Excel 日本語の文字化け防止）。ヘッダ＝全行のキー和集合。
// ネスト値（配列/オブジェクト）は JSON.stringify してセルに入れる。
const BOM = "﻿";

function cell(v) {
  if (v == null) return "";
  const s = (typeof v === "object") ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows) {
  const arr = Array.isArray(rows) ? rows : [];
  // ヘッダ＝全オブジェクトのキー和集合（出現順を保持）
  const keys = [];
  const seen = new Set();
  for (const r of arr) {
    if (r && typeof r === "object" && !Array.isArray(r)) {
      for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
    }
  }
  if (keys.length === 0) keys.push("value"); // スカラ配列でも空にしない
  const head = keys.map(cell).join(",");
  const body = arr.map((r) => {
    if (r && typeof r === "object" && !Array.isArray(r)) return keys.map((k) => cell(r[k])).join(",");
    return keys.map((k) => cell(k === "value" ? r : undefined)).join(",");
  });
  return BOM + [head, ...body].join("\r\n") + "\r\n";
}

// Blob + createObjectURL + 一時 <a download> でダウンロード。
function downloadCsv(entity, rows) {
  const csv = toCsv(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `taskstation_${entity}_${todayISO()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 大きめの遅延で revoke（Safari 等で click 直後の revoke がDL中断する事故を防ぐ）
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function render(root) {
  root.innerHTML = `<h1 class="vtitle">エクスポート（バックアップ）</h1>
    <div class="loading" style="padding:34px;text-align:center;color:${C.muted}">読み込み中…</div>`;

  let d;
  try {
    d = await load();
  } catch (e) {
    root.innerHTML = `<h1 class="vtitle">エクスポート（バックアップ）</h1>
      <div class="card" style="padding:20px;color:${C.over}">読み込みに失敗しました: ${esc(e.message || String(e))}</div>`;
    return;
  }

  // 祝日・休暇は store では Set/Map に潰されているため、生レコードを api.js から取り直す（失敗しても全体は止めない）。
  const [holidays, unavailability] = await Promise.all([
    getHolidays().catch(() => []),
    getUnavailability().catch(() => []),
  ]);

  // me を members に統合した名簿（重複は id でまとめる）。me 単独行も settings 隣に出す。
  const members = [...(d.members || [])];
  if (d.me && !members.some((m) => m.id === d.me.id)) members.push(d.me);

  // 設定はオブジェクト1個 → 1行の配列に正規化。
  const settingsRows = d.settings ? [d.settings] : [];
  // me 単体（whoami 全フィールド）。
  const meRows = d.me ? [d.me] : [];

  // エクスポート対象の定義（取得元はすべて上で確定済み＝ボタン押下時に再フェッチしない）。
  const ENTITIES = [
    { key: "tasks", label: "タスク", rows: d.tasks || [] },
    { key: "members", label: "ユーザー/メンバー", rows: members },
    { key: "me", label: "自分（ログインユーザー）", rows: meRows },
    { key: "projects", label: "ワークスペース（プロジェクト）", rows: d.projects || [] },
    { key: "labels", label: "分類ラベル", rows: d.labels || [] },
    { key: "recurrences", label: "定期/会議", rows: d.recurrences || [] },
    { key: "holidays", label: "祝日・休業日", rows: holidays || [] },
    { key: "unavailability", label: "個人休暇", rows: unavailability || [] },
    { key: "settings", label: "設定", rows: settingsRows },
  ];

  const rowsHtml = ENTITIES.map((e) => `
    <div class="ex-row" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 16px;border-bottom:1px solid ${C.line}">
      <div>
        <div style="font-weight:600;font-size:14px">${esc(e.label)}</div>
        <div style="font-size:11.5px;color:${C.muted};margin-top:2px">${e.rows.length} 件 ・ <code>taskstation_${e.key}_${todayISO()}.csv</code></div>
      </div>
      <button class="ex-btn" data-key="${e.key}" style="flex:none;padding:7px 14px;border:1px solid ${C.lineStrong};border-radius:8px;background:${C.card};color:${C.ink};font-weight:600;cursor:pointer">${esc(e.label)}をCSV</button>
    </div>`).join("");

  root.innerHTML = `
    <h1 class="vtitle">エクスポート（バックアップ）<small>各エンティティを CSV でダウンロード（読み取りのみ・破壊的操作なし）</small></h1>
    <div style="margin-bottom:14px">
      <button id="ex-all" style="padding:9px 18px;border:1px solid ${C.fill};border-radius:8px;background:${C.fill};color:#fff;font-weight:700;cursor:pointer">全部まとめてダウンロード</button>
      <span id="ex-status" style="margin-left:12px;font-size:12px;color:${C.muted}"></span>
    </div>
    <div class="card">${rowsHtml}</div>
    <div class="card" style="margin-top:14px;padding:14px 16px;font-size:12px;color:${C.muted};line-height:1.6">
      <b style="color:${C.ink}">補足</b><br>
      ・CSV は UTF-8 (BOM 付き)。Excel でそのまま開いても日本語が文字化けしません。<br>
      ・配列やオブジェクトのセルは JSON 文字列として格納されます。<br>
      ・権限（allowed_user_ids）は API 未公開のためエクスポート対象外です。
    </div>`;

  const byKey = new Map(ENTITIES.map((e) => [e.key, e]));

  root.querySelectorAll(".ex-btn").forEach((btn) => {
    btn.onclick = () => {
      const e = byKey.get(btn.dataset.key);
      if (e) downloadCsv(e.key, e.rows);
    };
  });

  const status = root.querySelector("#ex-status");
  const allBtn = root.querySelector("#ex-all");
  allBtn.onclick = async () => {
    allBtn.disabled = true;
    try {
      for (let i = 0; i < ENTITIES.length; i++) {
        const e = ENTITIES[i];
        status.textContent = `ダウンロード中… (${i + 1}/${ENTITIES.length}) ${e.label}`;
        downloadCsv(e.key, e.rows);
        // ブラウザの連続DL抑制を回避するため各DLの間に短い待機を挟む。
        await sleep(250);
      }
      status.textContent = `完了: ${ENTITIES.length} ファイルをダウンロードしました。`;
    } finally {
      allBtn.disabled = false;
    }
  };
}
