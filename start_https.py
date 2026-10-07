"""
Start Tripartite System over HTTPS, fast, with a *genuinely trusted* cert.

Uses cheroot (fast multithreaded TLS server) instead of Flask's slow dev server.

Certificates use the correct model (same as mkcert):
  * a local ROOT CA  (rootCA.pem)  -> you install THIS on each device once
  * a LEAF cert      (cert.pem)    -> the server presents this; it is signed by
                                      the root CA and lists localhost + your IP
Once the root CA is installed, Chrome shows "Connection is secure" (no warning)
and PWA install works (a cert error blocks installs, a trusted cert allows them).

With a single Windows admin prompt it also:
  * opens inbound firewall port 5050, and
  * installs the root CA into this PC's trust store.

Usage:
    pip install cryptography cheroot     (once)
    python start_https.py
"""
import os, sys, socket, subprocess, ctypes, time, hashlib

FW_RULE_NAME = "Tripartite System 5050"
PORT = 5050
HERE = os.path.dirname(os.path.abspath(__file__))
ROOTCA      = os.path.join(HERE, 'rootCA.pem')      # CA cert (install on devices)
ROOTCA_KEY  = os.path.join(HERE, 'rootCA-key.pem')  # CA private key
CERT = os.path.join(HERE, 'cert.pem')               # leaf cert (server presents)
KEY  = os.path.join(HERE, 'key.pem')                # leaf private key
TRUST_MARKER = os.path.join(HERE, '.cert_trusted')


# ── NETWORK ───────────────────────────────────────────────────────────────────
def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return '127.0.0.1'


def port_in_use(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(('0.0.0.0', port))
        return False
    except OSError:
        return True
    finally:
        s.close()


# ── CERTIFICATES (root CA + leaf) ─────────────────────────────────────────────
def certs_valid(local_ip):
    """Valid = root CA + leaf exist, leaf covers this IP, leaf is signed by the CA."""
    if not all(os.path.exists(p) for p in (ROOTCA, ROOTCA_KEY, CERT, KEY)):
        return False
    try:
        from cryptography import x509
        ca = x509.load_pem_x509_certificate(open(ROOTCA, 'rb').read())
        leaf = x509.load_pem_x509_certificate(open(CERT, 'rb').read())
        san = leaf.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        ips = [str(i) for i in san.get_values_for_type(x509.IPAddress)]
        bc = leaf.extensions.get_extension_for_class(x509.BasicConstraints).value
        return (local_ip in ips) and (not bc.ca) and (leaf.issuer == ca.subject)
    except Exception:
        return False


def generate_certs(local_ip):
    try:
        from cryptography import x509
        from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        import datetime, ipaddress

        now = datetime.datetime.utcnow()

        # 1) Root CA -------------------------------------------------------------
        ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Tripartite Local CA')])
        ca_cert = (
            x509.CertificateBuilder()
            .subject_name(ca_name).issuer_name(ca_name)
            .public_key(ca_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now).not_valid_after(now + datetime.timedelta(days=3650))
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(
                digital_signature=False, content_commitment=False, key_encipherment=False,
                data_encipherment=False, key_agreement=False, key_cert_sign=True,
                crl_sign=True, encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256())
        )

        # 2) Leaf (server) cert, signed by the root CA ---------------------------
        leaf_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        leaf_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, local_ip or 'localhost')])
        alt = [x509.DNSName('localhost'),
               x509.IPAddress(ipaddress.IPv4Address('127.0.0.1'))]
        if local_ip not in ('127.0.0.1', ''):
            alt.append(x509.IPAddress(ipaddress.IPv4Address(local_ip)))
        ca_ski = ca_cert.extensions.get_extension_for_class(x509.SubjectKeyIdentifier).value
        leaf_cert = (
            x509.CertificateBuilder()
            .subject_name(leaf_name).issuer_name(ca_cert.subject)
            .public_key(leaf_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now).not_valid_after(now + datetime.timedelta(days=825))
            .add_extension(x509.SubjectAlternativeName(alt), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(
                digital_signature=True, content_commitment=False, key_encipherment=True,
                data_encipherment=False, key_agreement=False, key_cert_sign=False,
                crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_subject_key_identifier(ca_ski), critical=False)
            .sign(ca_key, hashes.SHA256())
        )

        pem = serialization.Encoding.PEM
        with open(ROOTCA, 'wb') as f:
            f.write(ca_cert.public_bytes(pem))
        with open(ROOTCA_KEY, 'wb') as f:
            f.write(ca_key.private_bytes(pem, serialization.PrivateFormat.TraditionalOpenSSL,
                    serialization.NoEncryption()))
        with open(CERT, 'wb') as f:
            f.write(leaf_cert.public_bytes(pem))
        with open(KEY, 'wb') as f:
            f.write(leaf_key.private_bytes(pem, serialization.PrivateFormat.TraditionalOpenSSL,
                    serialization.NoEncryption()))
        if os.path.exists(TRUST_MARKER):
            os.remove(TRUST_MARKER)   # new CA -> must be re-trusted
        print(f'Certificate: created root CA + leaf (valid for localhost + {local_ip}).')
    except ImportError:
        print('ERROR: cryptography not installed.   Run:  pip install cryptography')
        sys.exit(1)


def ca_fingerprint():
    return hashlib.sha256(open(ROOTCA, 'rb').read()).hexdigest()


# ── ELEVATED SETUP (firewall + trust root CA on this PC) ──────────────────────
def firewall_rule_exists():
    try:
        out = subprocess.run(
            ['netsh', 'advfirewall', 'firewall', 'show', 'rule', f'name={FW_RULE_NAME}'],
            capture_output=True, text=True, timeout=10)
        return out.returncode == 0 and 'No rules match' not in out.stdout
    except Exception:
        return False


def pc_trusts_ca():
    return os.path.exists(TRUST_MARKER) and open(TRUST_MARKER).read().strip() == ca_fingerprint()


def elevated_setup():
    need_fw = not firewall_rule_exists()
    need_trust = not pc_trusts_ca()
    if not (need_fw or need_trust):
        print('Firewall + certificate trust: already set up.')
        return

    parts, actions = [], []
    if need_fw:
        parts.append(f'netsh advfirewall firewall add rule name="{FW_RULE_NAME}" '
                     f'dir=in action=allow protocol=TCP localport={PORT}')
        actions.append('open firewall port 5050')
    if need_trust:
        parts.append(f'certutil -addstore -f Root "{ROOTCA}"')
        actions.append('trust the certificate on this PC')

    print('Admin needed to ' + ' and '.join(actions) + ' -- click YES on the Windows prompt...')
    full = ' & '.join(parts)
    try:
        rc = ctypes.windll.shell32.ShellExecuteW(None, 'runas', 'cmd.exe', f'/c {full}', None, 0)
        if rc <= 32:
            raise OSError(f'ShellExecute returned {rc}')
        time.sleep(2.5)
        if need_trust:
            with open(TRUST_MARKER, 'w') as f:
                f.write(ca_fingerprint())
        if need_fw and not firewall_rule_exists():
            print('  (firewall rule not confirmed -- did you decline the prompt?)')
    except Exception as e:
        print('Could not finish elevated setup automatically:', e)
        print('  Run these ONCE in an Administrator PowerShell, then restart:')
        for p in parts:
            print('     ' + p)


# ── SERVE ─────────────────────────────────────────────────────────────────────
def serve():
    import server
    for d in ['static', server.UPLOAD_DIR, server.PROFILE_DIR, server.STORE_IMG, server.RECEIPT_DIR]:
        os.makedirs(d, exist_ok=True)
    try:
        from cheroot.wsgi import Server as WSGIServer
        from cheroot.ssl.builtin import BuiltinSSLAdapter
        httpd = WSGIServer(('0.0.0.0', PORT), server.app, numthreads=30, request_queue_size=50)
        httpd.ssl_adapter = BuiltinSSLAdapter(CERT, KEY)
        print('Server: cheroot (fast, multithreaded TLS). Press Ctrl+C to stop.\n')
        try:
            httpd.start()
        except KeyboardInterrupt:
            httpd.stop()
    except ImportError:
        print('Server: cheroot not installed -> falling back to slower Flask server.')
        print('        Run  pip install cheroot  for much better speed.\n')
        server.app.run(host='0.0.0.0', port=PORT, debug=False, threaded=True,
                       ssl_context=(CERT, KEY))


# ── MAIN ──────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    os.chdir(HERE)
    local_ip = get_local_ip()

    if port_in_use(PORT):
        print(f'ERROR: port {PORT} is already in use. Close the other server first.')
        sys.exit(1)

    if not certs_valid(local_ip):
        generate_certs(local_ip)
    else:
        print(f'Certificate: reusing existing root CA + leaf (valid for {local_ip}).')

    elevated_setup()

    url_local = f'https://localhost:{PORT}'
    url_net   = f'https://{local_ip}:{PORT}'
    print()
    print('=' * 64)
    print('  Tripartite System  -  HTTPS')
    print(f'  This PC:  {url_local}   (secure after the admin prompt above)')
    print(f'  Phone:    {url_net}')
    print('=' * 64)
    print('  To make the PHONE secure + allow Install (one time):')
    print(f'    1. On the phone open:  {url_net}/cert.pem')
    print('       (downloads the root CA)')
    print('    2. Android: Settings -> Security & privacy -> More security')
    print('       -> "Install a certificate" -> "CA certificate" -> pick it.')
    print('    3. Reopen the site -> it now shows secure -> Profile -> Install App.')
    print('=' * 64)
    print()

    try:
        import webbrowser
        webbrowser.open(url_local)
    except Exception:
        pass

    serve()
