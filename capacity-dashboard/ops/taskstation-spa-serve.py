import http.server, os

class H(http.server.SimpleHTTPRequestHandler):
    # 切断クライアントへの書き込みで永久ブロックしない
    timeout = 30
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

os.chdir("/home/neo/apps/office-work/capacity-dashboard")
# ThreadingHTTPServer: 1クライアントのストールが他を塞がない（旧TCPServer単線が7010ハングの原因）
with http.server.ThreadingHTTPServer(("0.0.0.0", 7010), H) as s:
    s.daemon_threads = True
    s.serve_forever()
