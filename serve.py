"""開発用のローカルサーバー。

ふつうの http.server はブラウザにキャッシュされてしまい、
ファイルを直したのに画面が変わらない、ということが起きるので、
キャッシュしないヘッダを付けて返すだけのもの。

    python serve.py 8123
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    print(f'http://localhost:{port}/ で待機中（Ctrl+C で終了）')
    ThreadingHTTPServer(('127.0.0.1', port), NoCacheHandler).serve_forever()
