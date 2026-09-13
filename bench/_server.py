"""Récepteur du banc : reçoit les résultats POSTés par la page de mesure.

Chaque POST est ajouté tel quel à /tmp/bench_posts.jsonl (une ligne = un message
JSON), ce qui permet de récupérer les résultats même si le navigateur est coupé.
"""
from http.server import BaseHTTPRequestHandler, HTTPServer

OUT = '/tmp/bench_posts.jsonl'


class H(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(n).decode('utf-8', 'replace')
        with open(OUT, 'a', encoding='utf-8') as f:
            f.write(body.replace('\n', ' ') + '\n')
        n_posts = sum(1 for _ in open(OUT, encoding='utf-8'))
        print(f'  [{n_posts}] {len(body)} octets reçus', flush=True)
        self.send_response(200)
        self._cors()
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    open(OUT, 'w').close()
    HTTPServer(('127.0.0.1', 5199), H).serve_forever()
