"""
Tripartite launcher — starts the Flask server hidden (no console) and opens the
app in the default browser. A system-tray icon lets the user open it again or quit.
Packaged into a single .exe with PyInstaller (see build below).
"""
import sys, os, threading, time, webbrowser

import server  # importing also runs server.py's frozen path setup (chdir next to .exe)

PORT = 5050
URL = f'http://127.0.0.1:{PORT}/'


def run_server():
    # Production-friendly: no debugger, no reloader, threaded for the local browser.
    server.app.run(host='127.0.0.1', port=PORT, threaded=True, use_reloader=False, debug=False)


def main():
    threading.Thread(target=run_server, daemon=True).start()
    time.sleep(1.5)
    try:
        webbrowser.open(URL)
    except Exception:
        pass

    # System tray icon (so the hidden server can be reopened or quit)
    try:
        from PIL import Image
        import pystray
        bundle = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
        img = Image.open(os.path.join(bundle, 'static', 'icon-192.png'))

        def do_open(icon, item):
            try: webbrowser.open(URL)
            except Exception: pass

        def do_quit(icon, item):
            icon.stop()
            os._exit(0)

        menu = pystray.Menu(
            pystray.MenuItem('Open Tripartite', do_open, default=True),
            pystray.MenuItem('Quit', do_quit)
        )
        pystray.Icon('Tripartite', img, 'Tripartite (running)', menu).run()
    except Exception:
        # No tray available — just keep the process alive so the server runs.
        while True:
            time.sleep(3600)


if __name__ == '__main__':
    main()
