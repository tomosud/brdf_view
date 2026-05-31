from __future__ import annotations

import argparse
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


class PagesHandler(SimpleHTTPRequestHandler):
    root: Path
    prefix: str

    def translate_path(self, path: str) -> str:
        parsed = urlparse(path)
        request_path = unquote(parsed.path)

        if request_path == self.prefix[:-1]:
            request_path = self.prefix

        if request_path.startswith(self.prefix):
            request_path = "/" + request_path[len(self.prefix) :]

        rel = request_path.lstrip("/")
        if not rel:
            rel = "index.html"

        target = (self.root / rel).resolve()
        try:
            target.relative_to(self.root)
        except ValueError:
            return str(self.root / "index.html")

        if target.is_dir():
            target = target / "index.html"

        return str(target)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--port", type=int, default=4173)
    parser.add_argument("--prefix", default="/brdf_view/")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    if not root.is_dir():
        raise SystemExit(f"root directory not found: {root}")

    prefix = args.prefix
    if not prefix.startswith("/"):
        prefix = "/" + prefix
    if not prefix.endswith("/"):
        prefix += "/"

    handler = type(
        "LocalPagesHandler",
        (PagesHandler,),
        {"root": root, "prefix": prefix},
    )

    os.chdir(root)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    print(f"Serving {root} at http://localhost:{args.port}{prefix}")
    print("Press Ctrl+C to stop.")
    server.serve_forever()


if __name__ == "__main__":
    main()
