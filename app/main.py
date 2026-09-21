import os
import json
import string
import re
import requests
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

def trigger_apps_script(row_index, action=None, placement=None):
    """Sends payload to Apps Script doPost endpoint to trigger handleEdit automation."""
    url = os.environ.get("APPS_SCRIPT_URL")
    if not url:
        print("Warning: APPS_SCRIPT_URL environment variable is not set.")
        return False

    payload = {
        "row_index": row_index,
        "action": action,
        "placement": placement
    }

    try:
        # Calls the doPost function deployed in Google Apps Script
        response = requests.post(url, json=payload, timeout=10)
        return response.ok
    except Exception as e:
        print(f"Failed to call Apps Script: {e}")
        return False

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
        
        # Pull raw rows starting from row 1 (0-indexed)
        all_rows = ws.get_all_values()
        if len(all_rows) < 2:
            return jsonify({"queue": []})

        queue = []
        # Row 1 is header (index 0). Data starts at Row 2 (index 1) or Row 3
        for idx, row in enumerate(all_rows[1:], start=3):
            if not row or not any(row):
                continue
            
            # Map columns explicitly: Col B (idx 1) = Name, Col D (idx 3) = Placement, Col E (idx 4) = Action
            name = row[1].strip() if len(row) > 1 else ""
            placement_val = str(row[3]).strip() if len(row) > 3 else ""
            action_val = str(row[4]).strip() if len(row) > 4 else ""
            
            if name:
                queue.append({
                    "row_index": idx,
                    "Name": name,
                    "Placement": placement_val,
                    "Action": action_val
                })
        
        # Sort queue by numeric placement value (e.g. 1, 2, 3...) or string if text (e.g., "OVERFLOW")
        def parse_placement_sort(item):
            val = item["Placement"]
            nums = re.findall(r'\d+', val)
            if nums:
                return (0, int(nums[0]))
            return (1, val.lower())

        queue.sort(key=parse_placement_sort)

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
        action = data.get("action")
        placement = data.get("placement")
        
        if not row_idx:
            return jsonify({"error": "Row index is required"}), 400

        # Delegate execution to Apps Script's doPost handler
        success = trigger_apps_script(row_idx, action=action, placement=placement)

        if success:
            return jsonify({"status": "success"})
        else:
            # Fallback to direct gspread update if Apps Script call fails
            gc = get_sheets_client()
            spreadsheet = gc.open_by_key(os.environ.get("SPREADSHEET_ID"))
            ws = spreadsheet.worksheet("Waiting Room")
            
            if placement is not None:
                ws.update_cell(row_idx, 4, placement)
            if action is not None:
                ws.update_cell(row_idx, 5, action)
                
            return jsonify({"status": "success", "note": "Updated via gspread direct write"})

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

@app.route("/api/logs")
@admin_required
def get_logs():
    try:
        gc = get_sheets_client()
        spreadsheet_id = os.environ.get("SPREADSHEET_ID")
        
        if not spreadsheet_id:
            return jsonify({"error": "SPREADSHEET_ID environment variable is missing"}), 500

        spreadsheet = gc.open_by_key(spreadsheet_id)
        ws = spreadsheet.worksheet("Logs")
        
        # Get all raw rows from the sheet
        rows = ws.get_all_values()
        
        # We need at least 3 rows (Row 3 is the first data row)
        if len(rows) < 3:
            return jsonify({"logs": []})

        # Data rows start at Row 3 (0-based index 2)
        data_rows = rows[2:]

        logs = []
        for row in reversed(data_rows):
            # Skip empty rows
            if not any(row):
                continue

            # Directly map Column A through Column F based on index position
            record = {
                "Submission Time": row[0].strip() if len(row) > 0 else "",
                "Name": row[1].strip() if len(row) > 1 else "",
                "Tattoo Session Date": row[2].strip() if len(row) > 2 else "",
                "Status": row[3].strip() if len(row) > 3 else "",
                "Reviewed By": row[4].strip() if len(row) > 4 else "",
                "Reviewed At": row[5].strip() if len(row) > 5 else ""
            }

            # Only append rows that have content
            if record["Name"] or record["Submission Time"]:
                logs.append(record)
        
        return jsonify({"logs": logs})

    except Exception as e:
        return jsonify({"error": str(e), "logs": []}), 500

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
