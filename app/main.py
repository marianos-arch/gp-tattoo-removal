import os
import json
import string
from functools import wraps
from flask import Flask, render_template, jsonify, session, redirect, url_for, request
from werkzeug.middleware.proxy_fix import ProxyFix
from authlib.integrations.flask_client import OAuth
import gspread
from google.oauth2.service_account import Credentials

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "dev-secret-key-change-me")

ADMIN_EMAILS = [email.strip() for email in os.environ.get("ADMIN_EMAILS", "marianos@gardenpathways.org").split(",") if email.strip()]

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

# Protected API endpoint - existing placements check
@app.route("/api/placements")
@admin_required
def get_placements():
    try:
        gc = get_sheets_client()
        sheet = gc.open_by_key(os.environ.get("SPREADSHEET_ID")).sheet1
        
        records = sheet.get_all_records()
        return jsonify({"placements": records, "spots_left": len(records)})
    except Exception as e:
        return jsonify({"error": str(e), "placements": [], "spots_left": 0}), 500

# Dynamic search across Sheets A-Z for autocomplete
@app.route("/api/clients/search")
@admin_required
def search_clients():
    query = request.args.get("q", "").strip().lower()
    if not query or len(query) < 2:
        return jsonify({"results": []})

    try:
        gc = get_sheets_client()
        spreadsheet = gc.open_by_key(os.environ.get("SPREADSHEET_ID"))
        
        matches = []
        first_letter = query[0].upper()
        letters_to_check = [first_letter] if first_letter in string.ascii_uppercase else string.ascii_uppercase

        for letter in letters_to_check:
            try:
                ws = spreadsheet.worksheet(letter)
                names = ws.col_values(1)[1:]  # Read Column A (skipping header)
                for name in names:
                    if query in name.lower():
                        matches.append(name)
            except Exception:
                continue

        return jsonify({"results": matches[:15]})
    except Exception as e:
        return jsonify({"error": str(e), "results": []}), 500

# Fetch Active Waiting Room Queue
@app.route("/api/waiting-room", methods=["GET"])
@admin_required
def get_waiting_room():
    try:
        gc = get_sheets_client()
        spreadsheet = gc.open_by_key(os.environ.get("SPREADSHEET_ID"))
        ws = spreadsheet.worksheet("Waiting Room")
        
        records = ws.get_all_records()
        queue = []
        for idx, row in enumerate(records, start=2):  # Row 1 is header row
            # Strip key names to remove trailing spaces in Google Sheet headers
            row_clean = {str(k).strip(): v for k, v in row.items()}
            
            if row_clean.get("Name"):
                queue.append({
                    "row_index": idx,
                    "Name": row_clean.get("Name", ""),
                    "Placement": str(row_clean.get("Placement", "")),  # Coerce to string for JS match
                    "Action": row_clean.get("Action", "")
                })
        return jsonify({"queue": queue})
    except Exception as e:
        return jsonify({"error": str(e), "queue": []}), 500

# Append new client to Waiting Room
@app.route("/api/waiting-room/add", methods=["POST"])
@admin_required
def add_to_waiting_room():
    try:
        data = request.json or {}
        name = data.get("name")
        placement = data.get("placement", "")
        action = data.get("action", "Pending")

        if not name:
            return jsonify({"error": "Name is required"}), 400

        gc = get_sheets_client()
        spreadsheet = gc.open_by_key(os.environ.get("SPREADSHEET_ID"))
        ws = spreadsheet.worksheet("Waiting Room")

        # Append row format: [Row, Name, Date, Placement, Action]
        ws.append_row(["", name, "", placement, action])
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# Update existing Placement and Action values in Waiting Room
@app.route("/api/waiting-room/update", methods=["POST"])
@admin_required
def update_waiting_room():
    try:
        data = request.json or {}
        row_idx = data.get("row_index")
        
        if not row_idx:
            return jsonify({"error": "Row index is required"}), 400

        gc = get_sheets_client()
        spreadsheet = gc.open_by_key(os.environ.get("SPREADSHEET_ID"))
        ws = spreadsheet.worksheet("Waiting Room")
        
        # Column 4 = Placement, Column 5 = Action
        ws.update_cell(row_idx, 4, data.get("placement"))
        ws.update_cell(row_idx, 5, data.get("action"))
        
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# Delete row from Waiting Room
@app.route("/api/waiting-room/delete", methods=["POST"])
@admin_required
def delete_waiting_room_row():
    try:
        data = request.json or {}
        row_idx = data.get("row_index")
        
        if not row_idx:
            return jsonify({"error": "Row index is required"}), 400

        gc = get_sheets_client()
        spreadsheet = gc.open_by_key(os.environ.get("SPREADSHEET_ID"))
        ws = spreadsheet.worksheet("Waiting Room")
        
        ws.delete_rows(int(row_idx))
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

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
