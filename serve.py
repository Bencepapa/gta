# Local dev server for the game: like `python -m http.server`, but tells the
# browser not to cache, so a refresh always picks up edited files.
#   python serve.py        -> http://localhost:5173
import functools
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5173


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


handler = functools.partial(NoCacheHandler, directory=os.path.dirname(os.path.abspath(__file__)))
print(f'Serving on http://localhost:{PORT}')
http.server.ThreadingHTTPServer(('', PORT), handler).serve_forever()
