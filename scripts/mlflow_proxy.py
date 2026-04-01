#!/usr/bin/env python3
"""
Tiny proxy that forwards MLflow requests from external IPs,
rewriting the Host header to 'localhost' to bypass DNS rebinding check.
Runs on port 5001, forwards to port 5000.
"""
import http.server
import urllib.request
import urllib.error
import sys

BACKEND = "http://localhost:5000"
PORT = 5001

class ProxyHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # Suppress access logs

    def do_request(self):
        url = BACKEND + self.path
        headers = {k: v for k, v in self.headers.items()
                   if k.lower() not in ('host', 'content-length')}
        headers['Host'] = 'localhost'

        body = None
        if self.command in ('POST', 'PUT', 'PATCH'):
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length) if length > 0 else None

        req = urllib.request.Request(url, data=body, headers=headers, method=self.command)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                self.send_response(resp.status)
                for k, v in resp.headers.items():
                    if k.lower() not in ('transfer-encoding',):
                        self.send_header(k, v)
                self.end_headers()
                self.wfile.write(resp.read())
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.end_headers()
            self.wfile.write(e.read())
        except Exception as ex:
            self.send_response(502)
            self.end_headers()
            self.wfile.write(str(ex).encode())

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_request

if __name__ == '__main__':
    server = http.server.HTTPServer(('0.0.0.0', PORT), ProxyHandler)
    print(f"[MLflow Proxy] Listening on 0.0.0.0:{PORT} -> {BACKEND}", flush=True)
    server.serve_forever()
