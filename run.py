"""Start the IFC Merge web app:  python run.py [--host 127.0.0.1] [--port 8000]

If the port is already taken (e.g. by another app), the next free port is used.
"""
import argparse
import socket
import threading
import time
import webbrowser

import uvicorn


def port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def find_port(host: str, start: int) -> int:
    for port in range(start, start + 100):
        if port_free(host, port):
            return port
    raise SystemExit(f"No free port found between {start} and {start + 99}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="127.0.0.1",
                   help="use 0.0.0.0 to share on the network (anyone can then read server paths)")
    p.add_argument("--port", type=int, default=8000, help="preferred port; the next free one is used if taken")
    p.add_argument("--no-browser", action="store_true")
    a = p.parse_args()

    port = find_port(a.host, a.port)
    if port != a.port:
        print(f"Port {a.port} is in use, using {port} instead.", flush=True)
    url = f"http://{'localhost' if a.host in ('0.0.0.0', '127.0.0.1') else a.host}:{port}"

    server = uvicorn.Server(uvicorn.Config("app.main:app", host=a.host, port=port))

    def open_when_ready():
        while not server.started:
            if server.should_exit:
                return
            time.sleep(0.1)
        print(f"\n  IFC Merge is running at {url}\n", flush=True)
        if not a.no_browser:
            webbrowser.open(url)

    threading.Thread(target=open_when_ready, daemon=True).start()
    server.run()
