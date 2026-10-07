from flask import Flask, request, jsonify, session, send_from_directory, send_file
from flask_cors import CORS
import os, sys, json, uuid, base64, io, requests as req_lib
from datetime import datetime
import pyotp
import qrcode

# When packaged as a .exe (PyInstaller): write data next to the .exe (persistent),
# and serve the static files from the bundled folder (read-only temp dir).
_FROZEN = getattr(sys, 'frozen', False)
if _FROZEN:
    os.chdir(os.path.dirname(sys.executable))
_BUNDLE = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(_BUNDLE, 'static')

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path='')
app.secret_key = 'rental_secret_key_2026_ultra'
CORS(app, supports_credentials=True, origins=[
    "http://127.0.0.1:5050","http://localhost:5050",
    "http://0.0.0.0:5050","null","file://"
], allow_headers=["Content-Type"], methods=["GET","POST","PUT","DELETE","OPTIONS"])

DATA_FILE   = 'data.json'
UPLOAD_DIR  = 'uploads'
PROFILE_DIR = 'profile_pics'
STORE_IMG   = 'store_images'
RECEIPT_DIR = 'receipts'

# Superadmin credentials. Override these with environment variables before
# exposing the app to a network — anyone who knows them has full access to every
# account. The defaults exist so a fresh clone runs out of the box.
#
#   Windows:  set TRI_ADMIN_USER=you  &&  set TRI_ADMIN_PASS=<strong-password>
#   macOS/Linux:  export TRI_ADMIN_USER=you TRI_ADMIN_PASS=<strong-password>
#
# The default below is public knowledge (it is in this repository), so treat it
# as "no password at all" the moment anyone else can reach the port.
_DEFAULT_ADMIN_PASS = '11645185'
ADMIN_USER  = os.environ.get('TRI_ADMIN_USER', 'mainAdmin')
ADMIN_PASS  = os.environ.get('TRI_ADMIN_PASS', _DEFAULT_ADMIN_PASS)
# Set to '1' to refuse the built-in default password (recommended in production).
ADMIN_STRICT = os.environ.get('TRI_ADMIN_STRICT', '') == '1'

NIM_URL     = 'https://integrate.api.nvidia.com/v1/chat/completions'
NIM_MODEL   = 'meta/llama-3.3-70b-instruct'

if ADMIN_STRICT and ADMIN_PASS == _DEFAULT_ADMIN_PASS:
    raise SystemExit(
        'TRI_ADMIN_STRICT=1 but TRI_ADMIN_PASS is still the built-in default.\n'
        'Set TRI_ADMIN_PASS to a strong password before serving over a network.')


# ── DATA ──────────────────────────────────────────────────────────────────────
def load_data():
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {"users": {}}

def save_data(data):
    with open(DATA_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def get_user():
    uid = session.get('user_id')
    if not uid: return None
    return load_data()['users'].get(uid)

def get_nim_key():
    """NVIDIA NIM key stored per-account (server-side) so it follows the user
    across devices. Admin's key lives in a reserved top-level slot."""
    data = load_data()
    if is_admin(): return data.get('_admin_nim_key', '')
    uid = session.get('user_id')
    if not uid: return ''
    return data['users'].get(uid, {}).get('nim_api_key', '')

def is_admin():
    return session.get('is_superadmin', False)

def require_auth():
    if is_admin(): return {"id":"__admin__","full_name":"Super Admin"}, None, None
    u = get_user()
    if not u: return None, jsonify({"error":"Unauthorized"}), 401
    return u, None, None

def get_target_uid():
    """Admin can impersonate any user via ?as=uid query param"""
    if is_admin() and request.args.get('as'):
        return request.args.get('as')
    u = get_user()
    return u['id'] if u else None

# ── STATIC ────────────────────────────────────────────────────────────────────
@app.route('/')
def index(): return send_from_directory(STATIC_DIR,'login.html')

@app.route('/sw.js')
def sw(): return send_from_directory(STATIC_DIR,'sw.js')

@app.route('/manifest.json')
def manifest(): return send_from_directory(STATIC_DIR,'manifest.json')

@app.route('/cert.pem')
def cert_download():
    # Serves the local ROOT CA so a phone can install it as trusted -> connection
    # shows "secure" and PWA install becomes available.
    base = os.path.dirname(os.path.abspath(__file__))
    p = os.path.join(base, 'rootCA.pem')
    if not os.path.exists(p):  # fallback for older single-cert setups
        p = os.path.join(base, 'cert.pem')
    if not os.path.exists(p): return "No certificate found", 404
    return send_file(p, mimetype='application/x-x509-ca-cert', as_attachment=True, download_name='tripartite-ca.crt')

# ── AUTH ──────────────────────────────────────────────────────────────────────
@app.route('/api/me')
def me():
    if is_admin():
        return jsonify({"id":"__admin__","full_name":"Main Admin","is_superadmin":True,"totp_enabled":False,
                        "nim_api_key":load_data().get('_admin_nim_key','')})
    u = get_user()
    if not u: return jsonify({"error":"Not logged in"}),401
    return jsonify({"id":u['id'],"full_name":u['full_name'],
                    "profile_pic":u.get('profile_pic'),"totp_enabled":u.get('totp_enabled',False),
                    "nim_api_key":u.get('nim_api_key','')})

@app.route('/api/login', methods=['POST'])
def login():
    d = request.json
    uname = d.get('username','').strip()
    pwd   = d.get('password','')
    # Super admin check
    if uname == ADMIN_USER and pwd == ADMIN_PASS:
        session['is_superadmin'] = True
        session['user_id'] = ADMIN_USER
        return jsonify({"id":"__admin__","full_name":"Main Admin","is_superadmin":True})
    data = load_data()
    u = data['users'].get(uname)
    if not u or u['password'] != pwd:
        return jsonify({"error":"Invalid credentials"}),401
    if u.get('totp_enabled') and u.get('totp_secret'):
        session['pending_user'] = uname
        return jsonify({"totp_required":True}),200
    session['user_id'] = uname
    return jsonify({"id":u['id'],"full_name":u['full_name'],
                    "profile_pic":u.get('profile_pic'),"totp_enabled":u.get('totp_enabled',False)})

@app.route('/api/login/totp', methods=['POST'])
def login_totp():
    d = request.json
    pending = session.get('pending_user')
    if not pending: return jsonify({"error":"No pending login"}),400
    data = load_data()
    u = data['users'].get(pending)
    if not u: return jsonify({"error":"User not found"}),404
    totp = pyotp.TOTP(u['totp_secret'])
    if not totp.verify(d.get('code','').replace(' ','')):
        return jsonify({"error":"Invalid code"}),401
    session.pop('pending_user',None)
    session['user_id'] = pending
    return jsonify({"id":u['id'],"full_name":u['full_name'],
                    "profile_pic":u.get('profile_pic'),"totp_enabled":True})

@app.route('/api/register', methods=['POST'])
def register():
    d = request.json
    data = load_data()
    uname     = d.get('username','').strip()
    pwd       = d.get('password','')
    full_name = d.get('full_name', uname)
    if not uname or not pwd: return jsonify({"error":"Username and password required"}),400
    if uname == ADMIN_USER:  return jsonify({"error":"Username not available"}),409
    if uname in data['users']: return jsonify({"error":"Username already exists"}),409
    data['users'][uname] = {
        "id":uname,"password":pwd,"full_name":full_name,
        "profile_pic":None,"totp_secret":None,"totp_enabled":False,
        "created_at":datetime.now().isoformat(),
        "units":[],"next_id":1,
        "store_items":[],"store_next_id":1,
        "farms":[],"farm_next_id":1
    }
    save_data(data)
    session['user_id'] = uname
    return jsonify({"id":uname,"full_name":full_name}),201

@app.route('/api/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({"message":"Logged out"})

# ── ADMIN PANEL ───────────────────────────────────────────────────────────────
@app.route('/api/admin/users', methods=['GET'])
def admin_list_users():
    if not is_admin(): return jsonify({"error":"Forbidden"}),403
    data = load_data()
    out = []
    for uid, u in data['users'].items():
        out.append({
            "id": uid,
            "username": uid,
            "full_name": u['full_name'],
            "totp_enabled": u.get('totp_enabled', False),
            "is_superadmin": False,
            "created_at": u.get('created_at'),
            "units": len(u.get('units', [])),
            "store_items": len(u.get('store_items', [])),
            "farms": len(u.get('farms', []))
        })
    return jsonify(out)

@app.route('/api/admin/users', methods=['POST'])
def admin_create_user():
    if not is_admin(): return jsonify({"error":"Forbidden"}),403
    data = load_data(); d = request.json
    uname     = (d.get('username') or '').strip()
    full_name = (d.get('full_name') or '').strip()
    pwd       = d.get('password', '')
    if not uname or not pwd or not full_name:
        return jsonify({"error":"Username, full name and password are required"}),400
    if uname == ADMIN_USER:
        return jsonify({"error":"Username not available"}),409
    if uname in data['users']:
        return jsonify({"error":"Username already exists"}),409
    data['users'][uname] = {
        "id": uname, "password": pwd, "full_name": full_name,
        "profile_pic": None, "totp_secret": None, "totp_enabled": False,
        "created_at": datetime.now().isoformat(),
        "units": [], "next_id": 1,
        "store_items": [], "store_next_id": 1,
        "farms": [], "farm_next_id": 1
    }
    save_data(data)
    return jsonify({"id": uname, "full_name": full_name}), 201

@app.route('/api/admin/impersonate/<uid>', methods=['POST'])
def admin_impersonate(uid):
    if not is_admin(): return jsonify({"error":"Forbidden"}),403
    data = load_data()
    if uid not in data['users']: return jsonify({"error":"User not found"}),404
    u = data['users'][uid]
    return jsonify({"id":u['id'],"full_name":u['full_name'],
                    "profile_pic":u.get('profile_pic'),"totp_enabled":u.get('totp_enabled',False)})

@app.route('/api/admin/users/<uid>/disable-totp', methods=['POST'])
def admin_disable_totp(uid):
    if not is_admin(): return jsonify({"error":"Forbidden"}),403
    data = load_data()
    if uid not in data['users']: return jsonify({"error":"User not found"}),404
    data['users'][uid]['totp_enabled'] = False
    data['users'][uid]['totp_secret']  = None
    save_data(data)
    return jsonify({"ok": True})

@app.route('/api/admin/users/<uid>', methods=['PUT'])
def admin_update_user(uid):
    if not is_admin(): return jsonify({"error":"Forbidden"}),403
    data = load_data()
    if uid not in data['users']: return jsonify({"error":"User not found"}),404
    d = request.json
    if 'full_name' in d and d['full_name'].strip():
        data['users'][uid]['full_name'] = d['full_name'].strip()
    if 'password' in d and d['password']:
        data['users'][uid]['password'] = d['password']
    new_username = (d.get('username') or '').strip()
    if new_username and new_username != uid:
        if new_username == ADMIN_USER or new_username in data['users']:
            return jsonify({"error":"Username already taken"}),409
        user_data = data['users'].pop(uid)
        user_data['id'] = new_username
        data['users'][new_username] = user_data
    save_data(data)
    return jsonify({"ok": True})

@app.route('/api/admin/users/<uid>', methods=['DELETE'])
def admin_delete_user(uid):
    if not is_admin(): return jsonify({"error":"Forbidden"}),403
    data = load_data()
    if uid not in data['users']: return jsonify({"error":"User not found"}),404
    del data['users'][uid]
    save_data(data)
    return jsonify({"ok":True})

# ── PROFILE ───────────────────────────────────────────────────────────────────
@app.route('/api/profile', methods=['PUT'])
def update_profile():
    u, err, code = require_auth()
    if err: return err, code
    d = request.json; data = load_data()
    uid = get_target_uid()
    if not uid: return jsonify({"error":"No user"}),400
    if 'full_name' in d and d['full_name'].strip():
        data['users'][uid]['full_name'] = d['full_name'].strip()
    if 'password' in d and d.get('current_password'):
        if data['users'][uid]['password'] != d['current_password']:
            return jsonify({"error":"Current password incorrect"}),400
        data['users'][uid]['password'] = d['password']
    save_data(data)
    u2 = data['users'][uid]
    return jsonify({"id":u2['id'],"full_name":u2['full_name'],
                    "profile_pic":u2.get('profile_pic'),"totp_enabled":u2.get('totp_enabled',False)})

@app.route('/api/profile/picture', methods=['POST'])
def upload_profile_pic():
    u, err, code = require_auth()
    if err: return err, code
    file = request.files.get('file')
    if not file: return jsonify({"error":"No file"}),400
    os.makedirs(PROFILE_DIR, exist_ok=True)
    uid = get_target_uid()
    ext = os.path.splitext(file.filename)[1].lower()
    filename = uid+'_'+str(uuid.uuid4())[:8]+ext
    file.save(os.path.join(PROFILE_DIR, filename))
    data = load_data()
    old = data['users'][uid].get('profile_pic')
    if old:
        try: os.remove(os.path.join(PROFILE_DIR, old))
        except: pass
    data['users'][uid]['profile_pic'] = filename
    save_data(data)
    return jsonify({"profile_pic":filename})

@app.route('/api/profile/picture/<filename>')
def serve_profile_pic(filename):
    return send_from_directory(os.path.abspath(PROFILE_DIR), filename)

# ── TOTP ──────────────────────────────────────────────────────────────────────
@app.route('/api/totp/setup', methods=['POST'])
def totp_setup():
    u, err, code = require_auth()
    if err: return err, code
    secret = pyotp.random_base32()
    totp   = pyotp.TOTP(secret)
    uri    = totp.provisioning_uri(name=u['id'], issuer_name='TripartiteSystem')
    img    = qrcode.make(uri)
    buf    = io.BytesIO(); img.save(buf,'PNG')
    qr_b64 = base64.b64encode(buf.getvalue()).decode()
    data = load_data()
    data['users'][u['id']]['totp_secret'] = secret
    save_data(data)
    return jsonify({"secret":secret,"qr":qr_b64})

@app.route('/api/totp/verify', methods=['POST'])
def totp_verify():
    u, err, code = require_auth()
    if err: return err, code
    d = request.json; data = load_data(); uid = u['id']
    secret = data['users'][uid].get('totp_secret')
    if not secret: return jsonify({"error":"No secret set"}),400
    if pyotp.TOTP(secret).verify(d.get('code','').replace(' ','')):
        data['users'][uid]['totp_enabled'] = True
        save_data(data)
        return jsonify({"success":True})
    return jsonify({"error":"Invalid code"}),400

@app.route('/api/totp/disable', methods=['POST'])
def totp_disable():
    u, err, code = require_auth()
    if err: return err, code
    d = request.json; data = load_data(); uid = u['id']
    secret = data['users'][uid].get('totp_secret')
    if secret and not pyotp.TOTP(secret).verify(d.get('code','').replace(' ','')):
        return jsonify({"error":"Invalid code"}),400
    data['users'][uid]['totp_enabled'] = False
    data['users'][uid]['totp_secret']  = None
    save_data(data); return jsonify({"success":True})

# ── RENTAL UNITS ──────────────────────────────────────────────────────────────
def get_units_for(uid):
    data = load_data()
    return data['users'].get(uid,{}).get('units',[])

@app.route('/api/units', methods=['GET'])
def get_units():
    u, err, code = require_auth()
    if err: return err, code
    uid = get_target_uid()
    return jsonify(get_units_for(uid))

@app.route('/api/units', methods=['POST'])
def create_unit():
    u, err, code = require_auth()
    if err: return err, code
    data = load_data(); uid = get_target_uid(); d = request.json
    d['id']        = data['users'][uid]['next_id']
    d['documents'] = []
    data['users'][uid]['units'].append(d)
    data['users'][uid]['next_id'] += 1
    save_data(data); return jsonify(d),201

@app.route('/api/units/<int:unit_id>', methods=['GET'])
def get_unit(unit_id):
    u, err, code = require_auth()
    if err: return err, code
    uid = get_target_uid()
    for unit in get_units_for(uid):
        if unit['id']==unit_id: return jsonify(unit)
    return jsonify({"error":"Not found"}),404

@app.route('/api/units/<int:unit_id>', methods=['PUT'])
def update_unit(unit_id):
    u, err, code = require_auth()
    if err: return err, code
    data = load_data(); uid = get_target_uid(); d = request.json
    for i, unit in enumerate(data['users'][uid]['units']):
        if unit['id']==unit_id:
            d['id']        = unit_id
            d['documents'] = unit.get('documents',[])
            data['users'][uid]['units'][i] = d
            save_data(data); return jsonify(d)
    return jsonify({"error":"Not found"}),404

@app.route('/api/units/<int:unit_id>', methods=['DELETE'])
def delete_unit(unit_id):
    u, err, code = require_auth()
    if err: return err, code
    data = load_data(); uid = get_target_uid()
    data['users'][uid]['units'] = [x for x in data['users'][uid]['units'] if x['id']!=unit_id]
    save_data(data); return jsonify({"message":"Deleted"})

@app.route('/api/units/<int:unit_id>/documents', methods=['POST'])
def upload_doc(unit_id):
    u, err, code = require_auth()
    if err: return err, code
    data = load_data(); uid = get_target_uid()
    file     = request.files.get('file')
    doc_type = request.form.get('doc_type','other')
    if not file: return jsonify({"error":"No file"}),400
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    doc_id   = str(uuid.uuid4())
    filename = file.filename
    save_path= os.path.join(UPLOAD_DIR, doc_id+'_'+filename)
    file.save(save_path)
    for unit in data['users'][uid]['units']:
        if unit['id']==unit_id:
            doc = {"id":doc_id,"filename":filename,"doc_type":doc_type,
                   "uploaded_at":datetime.now().isoformat(),"path":save_path}
            unit['documents'].append(doc)
            save_data(data); return jsonify(doc),201
    return jsonify({"error":"Unit not found"}),404

@app.route('/api/documents/<doc_id>', methods=['DELETE'])
def delete_doc(doc_id):
    u, err, code = require_auth()
    if err: return err, code
    data = load_data(); uid = get_target_uid()
    for unit in data['users'][uid]['units']:
        for d in unit['documents']:
            if d['id']==doc_id:
                try:
                    if os.path.exists(d['path']): os.remove(d['path'])
                except: pass
        unit['documents'] = [d for d in unit['documents'] if d['id']!=doc_id]
    save_data(data); return jsonify({"message":"Deleted"})

@app.route('/api/documents/<doc_id>', methods=['GET'])
def get_doc(doc_id):
    u, err, code = require_auth()
    if err: return err, code
    uid = get_target_uid()
    data = load_data()
    for unit in data['users'].get(uid,{}).get('units',[]):
        for d in unit.get('documents',[]):
            if d['id']==doc_id:
                return send_from_directory(os.path.abspath(os.path.dirname(d['path'])), os.path.basename(d['path']))
    return jsonify({"error":"Not found"}),404

# ── STORE ─────────────────────────────────────────────────────────────────────
@app.route('/api/store/items', methods=['GET'])
def get_store_items():
    u, err, code = require_auth()
    if err: return err, code
    uid  = get_target_uid(); data = load_data()
    return jsonify(data['users'].get(uid,{}).get('store_items',[]))

@app.route('/api/store/items', methods=['POST'])
def create_store_item():
    u, err, code = require_auth()
    if err: return err, code
    data = load_data(); uid = get_target_uid(); d = request.json
    item_id = data['users'][uid].get('store_next_id',1)
    item = {"id":item_id,"name":d.get('name',''),"description":d.get('description',''),
            "quantity":int(d.get('quantity',0)),"buy_price":float(d.get('buy_price',0)),
            "sell_price":float(d.get('sell_price',0)),"image":d.get('image',None),
            "created_at":datetime.now().isoformat(),"sales":[]}
    data['users'][uid].setdefault('store_items',[]).append(item)
    data['users'][uid]['store_next_id'] = item_id+1
    save_data(data); return jsonify(item),201

@app.route('/api/store/items/<int:item_id>', methods=['PUT'])
def update_store_item(item_id):
    u, err, code = require_auth()
    if err: return err, code
    data = load_data(); uid = get_target_uid(); d = request.json
    for i, item in enumerate(data['users'][uid].get('store_items',[])):
        if item['id']==item_id:
            item['name']        = d.get('name',item['name'])
            item['description'] = d.get('description',item['description'])
            item['quantity']    = int(d.get('quantity',item['quantity']))
            item['buy_price']   = float(d.get('buy_price',item['buy_price']))
            item['sell_price']  = float(d.get('sell_price',item['sell_price']))
            if d.get('image'): item['image'] = d['image']
            data['users'][uid]['store_items'][i] = item
            save_data(data); return jsonify(item)
    return jsonify({"error":"Not found"}),404

@app.route('/api/store/items/<int:item_id>', methods=['DELETE'])
def delete_store_item(item_id):
    u, err, code = require_auth()
    if err: return err, code
    data = load_data(); uid = get_target_uid()
    data['users'][uid]['store_items'] = [x for x in data['users'][uid].get('store_items',[]) if x['id']!=item_id]
    save_data(data); return jsonify({"message":"Deleted"})

@app.route('/api/store/items/<int:item_id>/image', methods=['POST'])
def upload_item_image(item_id):
    u, err, code = require_auth()
    if err: return err, code
    data = load_data(); uid = get_target_uid()
    file = request.files.get('file')
    if not file: return jsonify({"error":"No file"}),400
    os.makedirs(STORE_IMG, exist_ok=True)
    ext      = os.path.splitext(file.filename)[1].lower()
    filename = f'item_{item_id}_{uuid.uuid4().hex[:8]}{ext}'
    file.save(os.path.join(STORE_IMG, filename))
    for item in data['users'][uid].get('store_items',[]):
        if item['id']==item_id:
            item['image'] = filename
            save_data(data); return jsonify({"image":filename})
    return jsonify({"error":"Not found"}),404

@app.route('/api/store/images/<filename>')
def serve_store_image(filename):
    return send_from_directory(os.path.abspath(STORE_IMG), filename)

@app.route('/api/store/items/<int:item_id>/sell', methods=['POST'])
def sell_item(item_id):
    u, err, code = require_auth()
    if err: return err, code
    data = load_data(); uid = get_target_uid(); d = request.json
    qty  = int(d.get('quantity',1))
    paid = float(d.get('amount_paid',0))
    for item in data['users'][uid].get('store_items',[]):
        if item['id']==item_id:
            if item['quantity']<qty: return jsonify({"error":"Not enough stock"}),400
            discount_pct = max(0, min(100, float(d.get('discount_pct', 0))))
            total  = round(item['sell_price']*qty*(1-discount_pct/100), 2)
            status = 'sold' if paid>=total else 'installments'
            sale   = {
                "id":str(uuid.uuid4())[:8],"quantity":qty,"total_price":total,
                "discount_pct":discount_pct,
                "amount_paid":paid,"remaining":max(0,total-paid),"status":status,
                "buyer_fname":d.get('buyer_fname',''),"buyer_lname":d.get('buyer_lname',''),
                "buyer_cin":d.get('buyer_cin',''),"buyer_phone":d.get('buyer_phone',''),
                "quick":bool(d.get('quick',False)),
                "date":datetime.now().isoformat(),
                "receipt":None,
                "payments":[{"amount":paid,"date":datetime.now().isoformat()}] if paid>0 else []
            }
            item['quantity'] -= qty
            item.setdefault('sales',[]).append(sale)
            save_data(data); return jsonify({"item":item,"sale":sale}),201
    return jsonify({"error":"Not found"}),404

@app.route('/api/store/sales/<item_id>/<sale_id>/payment', methods=['POST'])
def add_payment(item_id, sale_id):
    u, err, code = require_auth()
    if err: return err, code
    data = load_data(); uid = get_target_uid(); d = request.json
    amount = float(d.get('amount',0))
    for item in data['users'][uid].get('store_items',[]):
        if str(item['id'])==str(item_id):
            for sale in item.get('sales',[]):
                if sale['id']==sale_id:
                    sale['amount_paid'] += amount
                    sale['remaining']    = max(0,sale['total_price']-sale['amount_paid'])
                    sale['payments'].append({"amount":amount,"date":datetime.now().isoformat()})
                    force_complete = bool(d.get('force_complete', False))
                    if sale['remaining']<=0 or force_complete:
                        sale['status']='sold'; sale['remaining']=0
                    save_data(data); return jsonify(sale)
    return jsonify({"error":"Not found"}),404

@app.route('/api/store/sales/<item_id>/<sale_id>/receipt', methods=['POST'])
def upload_receipt(item_id, sale_id):
    u, err, code = require_auth()
    if err: return err, code
    data = load_data(); uid = get_target_uid()
    file = request.files.get('file')
    if not file: return jsonify({"error":"No file"}),400
    os.makedirs(RECEIPT_DIR, exist_ok=True)
    ext      = os.path.splitext(file.filename)[1].lower()
    filename = f'rcpt_{sale_id}_{uuid.uuid4().hex[:6]}{ext}'
    file.save(os.path.join(RECEIPT_DIR, filename))
    for item in data['users'][uid].get('store_items',[]):
        if str(item['id'])==str(item_id):
            for sale in item.get('sales',[]):
                if sale['id']==sale_id:
                    sale['receipt'] = filename
                    save_data(data); return jsonify({"receipt":filename})
    return jsonify({"error":"Not found"}),404

@app.route('/api/receipts/<filename>')
def serve_receipt(filename):
    return send_from_directory(os.path.abspath(RECEIPT_DIR), filename)

# ── AGRICULTURE ───────────────────────────────────────────────────────────────
@app.route('/api/farms', methods=['GET'])
def get_farms():
    u, err, code = require_auth()
    if err: return err, code
    uid = get_target_uid(); data = load_data()
    return jsonify(data['users'].get(uid,{}).get('farms',[]))

@app.route('/api/farms', methods=['POST'])
def create_farm():
    u, err, code = require_auth()
    if err: return err, code
    data = load_data(); uid = get_target_uid(); d = request.json
    farm_id = data['users'][uid].get('farm_next_id',1)
    farm = {"id":farm_id,"name":d.get('name',''),"location":d.get('location',''),
            "size_hectares":float(d.get('size_hectares',0)),
            "has_solar":bool(d.get('has_solar',False)),"has_well":bool(d.get('has_well',False)),
            "trees":d.get('trees',[]),"workers":[],"harvest_projections":[],
            "created_at":datetime.now().isoformat()}
    data['users'][uid].setdefault('farms',[]).append(farm)
    data['users'][uid]['farm_next_id'] = farm_id+1
    save_data(data); return jsonify(farm),201

@app.route('/api/farms/<int:farm_id>', methods=['PUT'])
def update_farm(farm_id):
    u, err, code = require_auth()
    if err: return err, code
    data = load_data(); uid = get_target_uid(); d = request.json
    for i, farm in enumerate(data['users'][uid].get('farms',[])):
        if farm['id']==farm_id:
            farm['name']          = d.get('name',farm['name'])
            farm['location']      = d.get('location',farm['location'])
            farm['size_hectares'] = float(d.get('size_hectares',farm['size_hectares']))
            farm['has_solar']     = bool(d.get('has_solar',farm['has_solar']))
            farm['has_well']      = bool(d.get('has_well',farm['has_well']))
            farm['trees']         = d.get('trees',farm['trees'])
            data['users'][uid]['farms'][i] = farm
            save_data(data); return jsonify(farm)
    return jsonify({"error":"Not found"}),404

@app.route('/api/farms/<int:farm_id>', methods=['DELETE'])
def delete_farm(farm_id):
    u, err, code = require_auth()
    if err: return err, code
    data = load_data(); uid = get_target_uid()
    data['users'][uid]['farms'] = [f for f in data['users'][uid].get('farms',[]) if f['id']!=farm_id]
    save_data(data); return jsonify({"message":"Deleted"})

@app.route('/api/farms/<int:farm_id>/workers', methods=['POST'])
def add_worker(farm_id):
    u, err, code = require_auth()
    if err: return err, code
    data = load_data(); uid = get_target_uid(); d = request.json
    for farm in data['users'][uid].get('farms',[]):
        if farm['id']==farm_id:
            worker = {"id":str(uuid.uuid4())[:8],"name":d.get('name',''),
                      "task":d.get('task',''),"daily_cost":float(d.get('daily_cost',0)),
                      "days":int(d.get('days',1)),"date":d.get('date',datetime.now().strftime('%Y-%m-%d'))}
            farm.setdefault('workers',[]).append(worker)
            save_data(data); return jsonify(worker),201
    return jsonify({"error":"Not found"}),404

@app.route('/api/farms/<int:farm_id>/workers/<worker_id>', methods=['DELETE'])
def delete_worker(farm_id, worker_id):
    u, err, code = require_auth()
    if err: return err, code
    data = load_data(); uid = get_target_uid()
    for farm in data['users'][uid].get('farms',[]):
        if farm['id']==farm_id:
            farm['workers'] = [w for w in farm.get('workers',[]) if w['id']!=worker_id]
            save_data(data); return jsonify({"message":"Deleted"})
    return jsonify({"error":"Not found"}),404

@app.route('/api/farms/<int:farm_id>/projections', methods=['POST'])
def add_projection(farm_id):
    u, err, code = require_auth()
    if err: return err, code
    data = load_data(); uid = get_target_uid(); d = request.json
    for farm in data['users'][uid].get('farms',[]):
        if farm['id']==farm_id:
            proj = {"id":str(uuid.uuid4())[:8],"tree_type":d.get('tree_type',''),
                    "expected_kg":float(d.get('expected_kg',0)),"price_per_kg":float(d.get('price_per_kg',0)),
                    "harvest_date":d.get('harvest_date',''),"frequency":d.get('frequency','yearly'),
                    "buyer":d.get('buyer',''),"notes":d.get('notes','')}
            farm.setdefault('harvest_projections',[]).append(proj)
            save_data(data); return jsonify(proj),201
    return jsonify({"error":"Not found"}),404

@app.route('/api/farms/<int:farm_id>/projections/<proj_id>', methods=['DELETE'])
def delete_projection(farm_id, proj_id):
    u, err, code = require_auth()
    if err: return err, code
    data = load_data(); uid = get_target_uid()
    for farm in data['users'][uid].get('farms',[]):
        if farm['id']==farm_id:
            farm['harvest_projections'] = [p for p in farm.get('harvest_projections',[]) if p['id']!=proj_id]
            save_data(data); return jsonify({"message":"Deleted"})
    return jsonify({"error":"Not found"}),404

# ── AI CHAT (NVIDIA NIM) ──────────────────────────────────────────────────────
@app.route('/api/nim-key', methods=['POST'])
def save_nim_key():
    u, err, code = require_auth()
    if err: return err, code
    key = ((request.json or {}).get('api_key') or '').strip()
    data = load_data()
    if is_admin():
        data['_admin_nim_key'] = key
    else:
        uid = session.get('user_id')
        if not uid or uid not in data['users']: return jsonify({"error":"No user"}),400
        data['users'][uid]['nim_api_key'] = key
    save_data(data)
    return jsonify({"ok": True})

@app.route('/api/ai/chat', methods=['POST'])
def ai_chat():
    u, err, code = require_auth()
    if err: return err, code
    d        = request.json
    messages = d.get('messages',[])
    api_key  = d.get('api_key','') or get_nim_key()   # fall back to the account's stored key
    if not api_key:
        return jsonify({"error": "No API key provided. Please add your NVIDIA NIM API key in Profile → API Keys."}), 400
    try:
        resp = req_lib.post(NIM_URL, json={
            "model": NIM_MODEL,
            "messages": messages,
            "max_tokens": 1024,
            "stream": False
        }, headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}, timeout=60)
        if resp.status_code != 200:
            return jsonify({"error": f"NIM API error {resp.status_code}: {resp.text[:200]}"}), 502
        data_out = resp.json()
        reply = data_out.get('choices',[{}])[0].get('message',{}).get('content','...')
        return jsonify({"reply": reply})
    except Exception as e:
        return jsonify({"error": f"Could not reach NVIDIA NIM: {str(e)}"}), 503

# ── SYNC (PWA) ────────────────────────────────────────────────────────────────
@app.route('/api/sync', methods=['POST'])
def sync_from_mobile():
    """Apply a batch of offline ops (units / store / farms, incl. store 'sell')
    in order, then return the fresh full state. Temp client ids created earlier
    in the same batch are remapped to their real server ids."""
    u, err, code = require_auth()
    if err: return err, code
    uid = get_target_uid(); data = load_data()
    if not uid or uid not in data['users']: return jsonify({"error":"No user"}),400
    user = data['users'][uid]
    user.setdefault('units', []); user.setdefault('store_items', []); user.setdefault('farms', [])
    user.setdefault('next_id', 1); user.setdefault('store_next_id', 1); user.setdefault('farm_next_id', 1)

    CFG = {'units': ('units','next_id'), 'store': ('store_items','store_next_id'), 'farms': ('farms','farm_next_id')}
    idmap = {'units': {}, 'store': {}, 'farms': {}}

    for op in (request.json or {}).get('ops', []):
        dom = op.get('domain')
        if dom not in CFG: continue
        listkey, nextkey = CFG[dom]
        lst = user[listkey]
        action = op.get('action')
        rec = op.get('data') or {}
        rid = idmap[dom].get(op.get('id'), op.get('id'))
        try:
            if action == 'create':
                new_id = user[nextkey]; user[nextkey] = new_id + 1
                rec['id'] = new_id
                if dom == 'units': rec.setdefault('documents', [])
                elif dom == 'store':
                    rec.setdefault('sales', []); rec.setdefault('created_at', datetime.now().isoformat())
                elif dom == 'farms':
                    rec.setdefault('workers', []); rec.setdefault('harvest_projections', [])
                    rec.setdefault('trees', rec.get('trees', [])); rec.setdefault('created_at', datetime.now().isoformat())
                lst.append(rec)
                if op.get('client_id') is not None: idmap[dom][op['client_id']] = new_id
            elif action == 'update':
                for i, x in enumerate(lst):
                    if x.get('id') == rid:
                        rec['id'] = rid
                        if dom == 'units': rec['documents'] = x.get('documents', [])
                        elif dom == 'store': rec.setdefault('sales', x.get('sales', []))
                        elif dom == 'farms':
                            rec.setdefault('workers', x.get('workers', []))
                            rec.setdefault('harvest_projections', x.get('harvest_projections', []))
                        lst[i] = rec
                        break
            elif action == 'delete':
                user[listkey] = [x for x in lst if x.get('id') != rid]
            elif action == 'sell' and dom == 'store':
                qty = int(rec.get('quantity', 1)); paid = float(rec.get('amount_paid', 0))
                for item in lst:
                    if item.get('id') == rid:
                        if item.get('quantity', 0) < qty: break
                        disc  = max(0, min(100, float(rec.get('discount_pct', 0))))
                        total = round(item.get('sell_price', 0) * qty * (1 - disc / 100), 2)
                        item['quantity'] -= qty
                        item.setdefault('sales', []).append({
                            "id": str(uuid.uuid4())[:8], "quantity": qty, "total_price": total, "discount_pct": disc,
                            "amount_paid": paid, "remaining": max(0, total - paid),
                            "status": 'sold' if paid >= total else 'installments',
                            "buyer_fname": rec.get('buyer_fname', ''), "buyer_lname": rec.get('buyer_lname', ''),
                            "buyer_cin": rec.get('buyer_cin', ''), "buyer_phone": rec.get('buyer_phone', ''),
                            "date": datetime.now().isoformat(), "receipt": None,
                            "payments": [{"amount": paid, "date": datetime.now().isoformat()}] if paid > 0 else []
                        })
                        break
        except Exception:
            pass

    save_data(data)
    return jsonify({"units": user['units'], "store_items": user['store_items'],
                    "farms": user['farms'], "ts": datetime.now().isoformat()})

@app.route('/api/ping')
def ping():
    return jsonify({"ok":True,"time":datetime.now().isoformat()})

# ── MONTHLY RESET ─────────────────────────────────────────────────────────────
@app.route('/api/units/monthly_reset', methods=['POST'])
def monthly_reset():
    """Reset rent_status to unpaid for all units. Called client-side at month start."""
    u, err, code = require_auth()
    if err: return err, code
    data = load_data(); uid = get_target_uid()
    if not uid or uid not in data.get('users', {}):
        # Admin browsing without ?as=<user> has no unit list of their own.
        return jsonify({"ok": True, "reset": 0})
    for unit in data['users'].get(uid, {}).get('units', []):
        unit['rent_status'] = 'unpaid'
        unit['water'] = unit.get('water', 0)
        unit['electric'] = unit.get('electric', 0)
    save_data(data)
    return jsonify({"ok": True, "reset": len(data['users'][uid].get('units', []))})

# ── MAIN ──────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    import webbrowser, sys
    if getattr(sys,'frozen',False): os.chdir(os.path.dirname(sys.executable))
    for d in ['static',UPLOAD_DIR,PROFILE_DIR,STORE_IMG,RECEIPT_DIR]: os.makedirs(d,exist_ok=True)
    print("="*55)
    print("  Tripartite System Beta 0.4  -  http://127.0.0.1:5050")
    print("  Admin login:  mainAdmin / 11645185")
    print("  AI:    NVIDIA NIM (set API key in Profile -> API Keys)")
    print("="*55)
    webbrowser.open('http://127.0.0.1:5050')
    app.run(host='0.0.0.0', port=5050, debug=False, threaded=True)
