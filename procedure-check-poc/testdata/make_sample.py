#!/usr/bin/env python3
"""誤りを埋め込んだ模擬手順書 Excel を生成する。

sample_request.md（開発依頼）に対し、意図的に以下の誤りを仕込む:
  誤り1 (A2 反映漏れ・部分): ap-prd-02 の設定変更手順が無い（ap-prd-01 のみ）
  誤り2 (D2 停止忘れ):       myapp-web の停止手順が無く、いきなり設定変更
  誤り3 (B1 環境違い):       DB パッチの適用先が db-stg-01（検証）になっている
  誤り4 (D1 過剰手順):       依頼にない「Web サーバ nginx 再起動」が入っている
  正しい要素: バックアップ→パッチの順序、変更後の起動・確認手順（ap-prd-01 分）

期待検出: 上記4件（テスト仕様書の誤り埋め込みテストケース E-01〜E-04 に対応）
"""
from openpyxl import Workbook

ROWS = [
    # No, 作業区分, 対象環境, 対象サーバ, 作業内容, コマンド, 確認方法
    ("1", "事前確認", "本番", "ap-prd-01", "現在の設定値を確認",
     "grep max_connections /etc/myapp/app.conf", "max_connections = 200 であること"),
    ("2", "設定変更", "本番", "ap-prd-01", "app.conf の max_connections を変更",
     "sed -i 's/max_connections = 200/max_connections = 300/' /etc/myapp/app.conf",
     "grep で max_connections = 300 を確認"),
    ("3", "サービス起動", "本番", "ap-prd-01", "myapp-web を起動",
     "systemctl start myapp-web", "systemctl status myapp-web が active であること"),
    ("4", "サービス再起動", "本番", "web-prd-01", "nginx を再起動",
     "systemctl restart nginx", "systemctl status nginx が active であること"),
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
