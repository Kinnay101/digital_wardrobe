"""Nimmt Dateien von tools/labels.html entgegen und legt sie in js/ ab (nur lokal, nur bekannte Namen).

Start:  python tools/receive.py   (lauscht auf 127.0.0.1:8001)
"""
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ALLOWED = {"attrs.json", "labels.json"}
TARGET = Path(__file__).resolve().parent.parent / "js"


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "http://localhost:8000")
        self.send_header("Access-Control-Allow-Methods", "POST")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        name = self.path.strip("/")
        if name not in ALLOWED:
            self.send_response(403)
            self._cors()
            self.end_headers()
            return
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        (TARGET / name).write_bytes(body)
        print(f"gespeichert: js/{name} ({len(body)} Bytes)")
        self.send_response(200)
        self._cors()
        self.end_headers()


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 8001), Handler).serve_forever()
