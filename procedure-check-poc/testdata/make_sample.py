#!/usr/bin/env python3
"""テスト用の模擬手順書 Excel を生成する（ケース別）。

sample_request.md（特殊手順追加指示）に完全準拠した「正しいベース手順書」を持ち、
そこへ観点ごとの誤りを1つだけ注入して単一障害ケースを作る（テスト仕様書 §2 の EC-*）。
誤りゼロのベース自体が負制御ケース（EC-NEG＝誤検出率の測定）になる。

使い方:
    python3 make_sample.py                     # 既定=mix（複合ケース EC-MIX）
    python3 make_sample.py --case base -o x.xlsx   # 正しいベース（負制御 EC-NEG）
    python3 make_sample.py --case B1           # 単一障害ケース（DB を検証環境へ）
    python3 make_sample.py --list              # ケース一覧
"""
import argparse
import copy

from openpyxl import Workbook

HEADER = ["No", "作業区分", "対象環境", "対象サーバ", "作業内容", "コマンド", "確認方法"]

# コメント行（No 列に "#"）を挟み、実物の非システマチックさを模す
COMMENT_AP = ("#", "", "", "", "★AP サーバ作業（作業者: インフラ担当）", "", "")
COMMENT_DB = ("#", "", "", "", "★DB サーバ作業（メンテナンス枠内で実施）", "", "")


def ap_block(server):
    """1台分の AP 作業（停止→変更→起動→稼働確認まで指示準拠）。"""
    return [
        ("事前確認", "本番", server, "現在の設定値を確認",
         "grep max_connections /etc/myapp/app.conf", "max_connections = 200 であること"),
        ("サービス停止", "本番", server, "myapp-web を停止",
         "systemctl stop myapp-web", "systemctl status myapp-web が inactive であること"),
        ("設定変更", "本番", server, "app.conf の max_connections を変更",
         "sed -i 's/max_connections = 200/max_connections = 300/' /etc/myapp/app.conf",
         "grep で max_connections = 300 を確認"),
        ("サービス起動", "本番", server, "myapp-web を起動",
         "systemctl start myapp-web", "systemctl status myapp-web が active であること"),
    ]


def db_block(env="本番", server="db-prd-01"):
    return [
        ("バックアップ", env, server, "DB バックアップを取得",
         "pg_dump myappdb > /backup/myappdb_$(date +%Y%m%d).sql", "バックアップファイルの存在確認"),
        ("パッチ適用", env, server, "patch-99.9.0.sql を適用",
         "psql myappdb < /patch/patch-99.9.0.sql", "適用ログにエラーが無いこと"),
    ]


def correct_base():
    """指示に完全準拠した正しい手順書（誤りゼロ）= 負制御 EC-NEG。"""
    steps = []
    steps.append(COMMENT_AP)
    steps.extend(ap_block("ap-prd-01"))
    steps.extend(ap_block("ap-prd-02"))
    steps.append(COMMENT_DB)
    steps.extend(db_block())
    return steps


# --- 誤り注入（ベースを受け取り、1観点だけ壊して返す） ---

def inject_A1(steps):
    """A1 反映漏れ(全体): DB パッチ適用の手順を丸ごと削除。"""
    return [s for s in steps if not (s[0] == "パッチ適用")]


def inject_A2(steps):
    """A2 反映漏れ(部分): ap-prd-02 の作業ブロックを削除。"""
    return [s for s in steps if s[2] != "ap-prd-02"]


def inject_B1(steps):
    """B1 適用環境の誤り: DB 作業を本番→検証(db-stg-01) にすり替え。"""
    out = []
    for s in steps:
        if s[2] == "db-prd-01":
            out.append((s[0], "検証", "db-stg-01", s[3], s[4], s[5]))
        else:
            out.append(s)
    return out


def inject_B2(steps):
    """B2 対象外環境への手順: 除外の検証環境(db-stg-01)への追加作業を挿入。

    本番 DB 作業は正しいまま残し、対象外の検証環境への手順を「追加」する点が B1 と異なる。
    """
    extra = ("事前検証", "検証", "db-stg-01", "検証環境でパッチを事前適用",
             "psql myappdb < /patch/patch-99.9.0.sql", "適用ログにエラーが無いこと")
    idx = steps.index(COMMENT_DB) + 1  # DB コメントの直後に差し込む
    return steps[:idx] + [extra] + steps[idx:]


def inject_B3(steps):
    """B3 環境名の転記ミス: ap-prd-02 を一箇所だけ ap-prd-002 と誤記。"""
    out, done = [], False
    for s in steps:
        if s[2] == "ap-prd-02" and not done:
            out.append((s[0], s[1], "ap-prd-002", s[3], s[4], s[5]))
            done = True
        else:
            out.append(s)
    return out


def inject_C1(steps):
    """C1 順序誤り: DB ブロックを AP ブロックより前に移動（指示は AP→DB）。"""
    ap = [s for s in steps if s[2] in ("ap-prd-01", "ap-prd-02") or s == COMMENT_AP]
    db = [s for s in steps if s[2] == "db-prd-01" or s == COMMENT_DB]
    return db + ap


def inject_C2(steps):
    """C2 前提手順の後置: パッチ適用をバックアップより前へ。"""
    out = [s for s in steps if s[0] not in ("バックアップ", "パッチ適用")]
    patch = [s for s in steps if s[0] == "パッチ適用"]
    backup = [s for s in steps if s[0] == "バックアップ"]
    return out + patch + backup


def inject_D2(steps):
    """D2 停止漏れ: 設定変更前の myapp-web 停止手順を削除。"""
    return [s for s in steps if s[0] != "サービス停止"]


def inject_D3(steps):
    """D3 確認手順の欠落: 起動後の稼働確認を空にする。"""
    out = []
    for s in steps:
        if s[0] == "サービス起動":
            out.append((s[0], s[1], s[2], s[3], s[4], ""))
        else:
            out.append(s)
    return out


def inject_E1(steps):
    """E1 値の不一致: 変更後値を 300→250 に。"""
    out = []
    for s in steps:
        if s[0] == "設定変更":
            cmd = s[4].replace("max_connections = 300", "max_connections = 250")
            chk = s[5].replace("300", "250")
            out.append((s[0], s[1], s[2], s[3], cmd, chk))
        else:
            out.append(s)
    return out


def inject_E2(steps):
    """E2 記載の不整合: パッチ資材名を 99.9.0→99.9.1 に。"""
    out = []
    for s in steps:
        if s[0] == "パッチ適用":
            out.append((s[0], s[1], s[2], s[3], s[4].replace("99.9.0", "99.9.1"), s[5]))
        else:
            out.append(s)
    return out


def inject_F1(steps):
    """F 指示違反(残存): 除外指示に反し nginx 再起動を残す。"""
    extra = ("サービス再起動", "本番", "web-prd-01", "nginx を再起動",
             "systemctl restart nginx", "systemctl status nginx が active であること")
    # AP ブロックの末尾（DB コメントの前）に挿入
    idx = steps.index(COMMENT_DB)
    return steps[:idx] + [extra] + steps[idx:]


INJECTORS = {
    "A1": inject_A1, "A2": inject_A2, "B1": inject_B1, "B2": inject_B2, "B3": inject_B3,
    "C1": inject_C1, "C2": inject_C2, "D2": inject_D2, "D3": inject_D3,
    "E1": inject_E1, "E2": inject_E2, "F1": inject_F1,
}


def build_mix():
    """複合ケース EC-MIX: A2 + B1 + D2 + F1 を同時に。"""
    steps = correct_base()
    for fn in (inject_A2, inject_B1, inject_D2, inject_F1):
        steps = fn(steps)
    return steps


def numbered(steps):
    """コメント行(No='#')以外に連番を振り、7列のタプルへ整形。"""
    out, n = [], 0
    for s in steps:
        if s[0] == "#":
            out.append(s)
        else:
            n += 1
            out.append((str(n),) + tuple(s))
    return out


def build(case):
    if case == "base":
        return numbered(correct_base())
    if case == "mix":
        return numbered(build_mix())
    if case in INJECTORS:
        return numbered(INJECTORS[case](correct_base()))
    raise SystemExit(f"未知のケース: {case}（--list で一覧）")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", default="mix",
                        help="base(=負制御) / mix(=複合) / " + " / ".join(INJECTORS))
    parser.add_argument("-o", "--output")
    parser.add_argument("--list", action="store_true", help="ケース一覧を表示")
    args = parser.parse_args()

    if args.list:
        print("base  : 正しいベース（負制御 EC-NEG）")
        print("mix   : 複合ケース EC-MIX（A2+B1+D2+F1）")
        for k, fn in INJECTORS.items():
            print(f"{k:<6}: {fn.__doc__.splitlines()[0]}")
        return

    rows = build(args.case)
    wb = Workbook()
    ws = wb.active
    ws.title = "作業手順"
    ws.append(HEADER)
    for row in rows:
        ws.append(list(row))
    out = args.output or __file__.replace("make_sample.py", "sample_procedure.xlsx")
    wb.save(out)
    print(f"生成[{args.case}]: {out}")


if __name__ == "__main__":
    main()
