#!/usr/bin/env python3
"""誤りを埋め込んだ模擬手順書 Excel を生成する。

sample_request.md（特殊手順追加指示）に対し、意図的に以下の誤りを仕込む:
  誤り1 (A2 反映漏れ・部分): ap-prd-02 の設定変更手順が無い（ap-prd-01 のみ）
  誤り2 (D2 停止忘れ):       myapp-web の停止手順が無く、いきなり設定変更
  誤り3 (B1 環境違い):       DB パッチの適用先が db-stg-01（検証）になっている
  誤り4 (F 指示違反・残存):  「実施しない」と除外指示された nginx 再起動が残っている

正しい要素: バックアップ→パッチの順序、変更後の起動・確認手順（ap-prd-01 分）

また、実物の手順書が「あまりシステマチックでない」点を模すため、
手順行の間にコメント行（1列だけ埋まった注記）を混在させる。

期待検出: 誤り4件（テスト仕様書の誤り埋め込みテストケース E-01〜E-04 に対応）
"""
from openpyxl import Workbook

# (No, 作業区分, 対象環境, 対象サーバ, 作業内容, コマンド, 確認方法)
# コメント行は No 列に "#" を置き、作業内容列に注記を書く（実物のクセを模擬）
ROWS = [
    ("#", "", "", "", "★AP サーバ作業（作業者: インフラ担当）", "", ""),
    ("1", "事前確認", "本番", "ap-prd-01", "現在の設定値を確認",
     "grep max_connections /etc/myapp/app.conf", "max_connections = 200 であること"),
    ("2", "設定変更", "本番", "ap-prd-01", "app.conf の max_connections を変更",
     "sed -i 's/max_connections = 200/max_connections = 300/' /etc/myapp/app.conf",
     "grep で max_connections = 300 を確認"),
    ("3", "サービス起動", "本番", "ap-prd-01", "myapp-web を起動",
     "systemctl start myapp-web", "systemctl status myapp-web が active であること"),
    ("4", "サービス再起動", "本番", "web-prd-01", "nginx を再起動",
     "systemctl restart nginx", "systemctl status nginx が active であること"),
    ("#", "", "", "", "★DB サーバ作業（メンテナンス枠内で実施）", "", ""),
    ("5", "バックアップ", "検証", "db-stg-01", "DB バックアップを取得",
     "pg_dump myappdb > /backup/myappdb_$(date +%Y%m%d).sql", "バックアップファイルの存在確認"),
    ("6", "パッチ適用", "検証", "db-stg-01", "patch-99.9.0.sql を適用",
     "psql myappdb < /patch/patch-99.9.0.sql", "適用ログにエラーが無いこと"),
]


def main():
    wb = Workbook()
    ws = wb.active
    ws.title = "作業手順"
    ws.append(["No", "作業区分", "対象環境", "対象サーバ", "作業内容", "コマンド", "確認方法"])
    for row in ROWS:
        ws.append(row)
    out = __file__.replace("make_sample.py", "sample_procedure.xlsx")
    wb.save(out)
    print(f"生成: {out}")


if __name__ == "__main__":
    main()
