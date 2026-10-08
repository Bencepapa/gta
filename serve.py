# Local dev server for the game: like `python -m http.server`, but tells the
# browser not to cache, so a refresh always picks up edited files. It also
# lets the atlas editor (tools/atlas-editor.html) save its JSON into concept/.
#   python serve.py        -> http://localhost:5173
import functools
import http.server
import os
import re
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
ROOT = os.path.dirname(os.path.abspath(__file__))
# Only plain JSON files directly inside concept/ may be written.
WRITABLE = re.compile(r'^/concept/[A-Za-z0-9._-]+\.json$')


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_PUT(self):
        path = self.path.split('?')[0]
        if not WRITABLE.match(path) or '..' in path:
            self.send_error(403, 'Only concept/*.json can be saved')
            return
        length = int(self.headers.get('Content-Length', 0))
        if length > 20_000_000:
            self.send_error(413)
            return
        body = self.rfile.read(length)
        with open(os.path.join(ROOT, path.lstrip('/')), 'wb') as f:
            f.write(body)
        self.send_response(204)
        self.end_headers()


# Listen on localhost only: the PUT handler writes files.
handler = functools.partial(Handler, directory=ROOT)
print(f'Serving on http://localhost:{PORT}')
http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler).serve_forever()
