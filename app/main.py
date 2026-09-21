import os
import json
from functools import wraps
from flask import Flask, render_template, jsonify, session, redirect, url_for
from werkzeug.middleware.proxy_fix import ProxyFix
from authlib.integrations.flask_client import OAuth
import gspread
from google.oauth2.service_account import Credentials

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "dev-secret-key-change-me")

ADMIN_EMAILS = os.environ.get("ADMIN_EMAILS", "marianos@gardenpathways.org").split(",")

# Google OAuth Setup
oauth = OAuth(app)
google = oauth.register(
    name='google',
    client_id=os.environ.get("GOOGLE_CLIENT_ID"),
    client_secret=os.environ.get("GOOGLE_CLIENT_SECRET"),
    server_metadata_url='https://accounts.google.com/.well-known/openid-configuration',
    client_kwargs={'scope': 'openid email profile'}
)

# Helper function to get authenticated Google Sheets client
def get_sheets_client():
    raw_json = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not raw_json:
        raise ValueError("GOOGLE_SERVICE_ACCOUNT_JSON environment variable is not set")
    
    info = json.loads(raw_json)
    scopes = [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive'
    ]
    creds = Credentials.from_service_account_info(info, scopes=scopes)
    return gspread.authorize(creds)

def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        user = session.get('user')
        if not user or not user.get('is_admin'):
            return redirect(url_for('login_page'))
        return f(*args, **kwargs)
    return decorated

@app.route("/")
def index():
    return render_template("index.html")

# Protected API endpoint - only logged-in admin users can fetch sheet data
@app.route("/api/placements")
@admin_required
def get_placements():
    try:
        gc = get_sheets_client()
        sheet = gc.open_by_key("YOUR_SPREADSHEET_ID").sheet1
        
        records = sheet.get_all_records()
        return jsonify({"placements": records, "spots_left": len(records)})
    except Exception as e:
        return jsonify({"error": str(e), "placements": [], "spots_left": 0}), 500

@app.route("/admin/login")
def login_page():
    return render_template("login.html")

@app.route("/login/google")
def trigger_google_login():
    return google.authorize_redirect(url_for('auth_callback', _external=True))

@app.route("/auth/callback")
def auth_callback():
    try:
        token = google.authorize_access_token()
        email = token.get('userinfo', {}).get('email')
        is_admin = email in ADMIN_EMAILS if email else False
        session['user'] = {'email': email, 'is_admin': is_admin}
        
        if is_admin:
            return redirect(url_for('admin_dashboard'))
        return redirect(url_for('login_page', unauthorized=1))
    except Exception:
        return redirect(url_for('index'))

@app.route("/admin")
@admin_required
def admin_dashboard():
    return render_template("admin.html")

@app.route("/logout")
def logout():
    session.pop('user', None)
    return redirect(url_for('index'))

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=True)
