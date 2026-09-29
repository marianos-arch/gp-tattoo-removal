import os
import json
import string
import re
import requests
from functools import wraps
from datetime import datetime
from flask import Flask, render_template, jsonify, session, redirect, url_for, request
from werkzeug.middleware.proxy_fix import ProxyFix
from authlib.integrations.flask_client import OAuth
import gspread
from google.oauth2.service_account import Credentials
import time

# Simple in-memory cache for client roster
CLIENT_CACHE = {"names": [], "last_updated": 0}
CACHE_TTL_SECONDS = 300  # Refresh roster every 5 minutes

# Short-lived cache for the PUBLIC status data (protects Google Sheets API quota)
PUBLIC_CACHE = {"data": None, "last_updated": 0}
PUBLIC_CACHE_TTL_SECONDS = 15

def invalidate_public_cache():
    PUBLIC_CACHE["last_updated"] = 0

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "dev-secret-key-change-me")

ADMIN_EMAILS = [email.strip().lower() for email in os.environ.get("ADMIN_EMAILS", "marianos@gardenpathways.org").split(",") if email.strip()]

# Google OAuth Setup
oauth = OAuth(app)
google = oauth.register(
    name='google',
    client_id=os.environ.get("GOOGLE_CLIENT_ID"),
    client_secret=os.environ.get("GOOGLE_CLIENT_SECRET"),
    server_metadata_url='https://accounts.google.com/.well-known/openid-configuration',
    client_kwargs={'scope': 'openid email profile'}
)

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

def trigger_apps_script(row_index, name=None, action=None, placement=None):
    """Sends payload including Client Name to Apps Script to preserve identity across reindexes."""
    url = os.environ.get("APPS_SCRIPT_URL")
    if not url:
        print("Warning: APPS_SCRIPT_URL environment variable is not set.")
        return False

    payload = {
        "sheetName": "Waiting Room",
        "row_index": int(row_index) if row_index is not None and str(row_index).isdigit() else None,
        "name": str(name).strip() if name else None,
        "action": action,
        "placement": str(placement) if placement is not None else None
    }

    try:
        response = requests.post(url, json=payload, timeout=15, allow_redirects=True)
        if response.ok:
            res_data = response.json()
            if res_data.get("status") == "success":
                return True
            else:
                print(f"Apps Script Error Response: {res_data.get('message') or res_data.get('error')}")
                return False
        return False
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

@app.route("/api/placements")
def get_placements():
    """Public endpoint used by the live status page.
    Returns only [placement, action] pairs -- NO client names -- as a JSON array,
    which is the shape static/main.js expects."""
    now = time.time()
    if PUBLIC_CACHE["data"] is not None and (now - PUBLIC_CACHE["last_updated"]) < PUBLIC_CACHE_TTL_SECONDS:
        return jsonify(PUBLIC_CACHE["data"])

    try:
        gc = get_sheets_client()
        spreadsheet = gc.open_by_key(os.environ.get("SPREADSHEET_ID"))
        ws = spreadsheet.worksheet("Waiting Room")
        all_rows = ws.get_all_values()

        placements = []
        for row in all_rows[1:]:  # row 1 is the header
            name = row[1].strip() if len(row) > 1 else ""
            if not name:  # same rule as the admin queue: a row needs a name
                continue
            placement = row[3].strip() if len(row) > 3 else ""
            action = row[4].strip() if len(row) > 4 else ""
            placements.append([placement, action or "Pending"])

        PUBLIC_CACHE["data"] = placements
        PUBLIC_CACHE["last_updated"] = now
        return jsonify(placements)
    except Exception as e:
        print(f"Public placements error: {e}")
        # Serve slightly stale data rather than an error if we have any
        if PUBLIC_CACHE["data"] is not None:
            return jsonify(PUBLIC_CACHE["data"])
        return jsonify({"error": "Unable to load placement data"}), 500

def get_cached_client_names():
    now = time.time()
    if not CLIENT_CACHE["names"] or (now - CLIENT_CACHE["last_updated"]) > CACHE_TTL_SECONDS:
        try:
            gc = get_sheets_client()
            spreadsheet = gc.open_by_key(os.environ.get("SPREADSHEET_ID"))
            ranges = [f"'{letter}'!A3:A" for letter in string.ascii_uppercase]
            batch_response = spreadsheet.values_batch_get(ranges)
            value_ranges = batch_response.get("valueRanges", [])

            names_set = set()
            for vr in value_ranges:
                for row in vr.get("values", []):
                    if row and row[0].strip():
                        names_set.add(row[0].strip())

            CLIENT_CACHE["names"] = sorted(list(names_set))
            CLIENT_CACHE["last_updated"] = now
        except Exception as e:
            print(f"Error updating client cache: {e}")

    return CLIENT_CACHE["names"]

@app.route("/api/clients/search")
@admin_required
def search_clients():
    query = request.args.get("q", "").strip().lower()
    if not query:
        return jsonify({"results": []})

    query_parts = re.findall(r'\w+', query)
    if not query_parts:
        return jsonify({"results": []})

    try:
        all_names = get_cached_client_names()
        matches = []

        for raw_name in all_names:
            name_lower = raw_name.lower()
            if all(part in name_lower for part in query_parts):
                matches.append(raw_name)
                if len(matches) >= 15:
                    break

        return jsonify({"results": matches})

    except Exception as e:
        print(f"Search API Error: {e}")
        return jsonify({"error": str(e), "results": []}), 500


@app.route("/api/waiting-room", methods=["GET"])
@admin_required
def get_waiting_room():
    try:
        gc = get_sheets_client()
        spreadsheet = gc.open_by_key(os.environ.get("SPREADSHEET_ID"))
        ws = spreadsheet.worksheet("Waiting Room")
        
        all_rows = ws.get_all_values()
        if len(all_rows) < 2:
            return jsonify({"queue": []})

        queue = []
        for idx, row in enumerate(all_rows[1:], start=2):
            if not row or not any(row):
                continue
            
            name = row[1].strip() if len(row) > 1 else ""
            placement_val = str(row[3]).strip() if len(row) > 3 else ""
            action_val = str(row[4]).strip() if len(row) > 4 else ""
            routing_val = str(row[5]).strip() if len(row) > 5 else ""
            
            if name:
                queue.append({
                    "row_index": idx,
                    "Timestamp": row[0].strip() if len(row) > 0 else "",
                    "Name": name,
                    "SessionDate": row[2].strip() if len(row) > 2 else "",
                    "Placement": placement_val,
                    "Action": action_val,
                    "RoutingStatus": routing_val
                })
        
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

@app.route("/api/waiting-room/add", methods=["POST"])
@admin_required
def add_to_waiting_room():
    try:
        data = request.json or {}
        name = data.get("name", "").strip()
        placement = str(data.get("placement", "")).strip()
        action = data.get("action", "Pending").strip()
        routing_status = data.get("routing_status", "Pending").strip()

        if not name:
            return jsonify({"error": "Name is required"}), 400

        now = datetime.now()
        timestamp_str = now.strftime("%m/%d/%Y %H:%M:%S")
        session_date_str = now.strftime("%m/%d/%Y")

        gc = get_sheets_client()
        spreadsheet = gc.open_by_key(os.environ.get("SPREADSHEET_ID"))
        ws = spreadsheet.worksheet("Waiting Room")

        row_payload = [
            timestamp_str,
            name,
            session_date_str,
            placement,
            action,
            routing_status
        ]

        ws.append_row(row_payload, value_input_option="USER_ENTERED")
        invalidate_public_cache()
        return jsonify({"status": "success", "added_row": row_payload})

    except Exception as e:
        print(f"Error adding to waiting room: {e}")
        return jsonify({"error": str(e)}), 500

@app.route("/api/waiting-room/update", methods=["POST"])
@admin_required
def update_waiting_room():
    try:
        data = request.json or {}
        row_idx = data.get("row_index")
        name = data.get("name")
        action = data.get("action")
        placement = data.get("placement")
        
        if not row_idx and not name:
            return jsonify({"error": "Row index or name is required"}), 400

        # 1. Attempt update via Apps Script passing Name + Row Index
        success = trigger_apps_script(row_idx, name=name, action=action, placement=placement)

        # 2. Fallback direct write to Google Sheet if Apps Script fails or is unconfigured
        if not success:
            gc = get_sheets_client()
            spreadsheet = gc.open_by_key(os.environ.get("SPREADSHEET_ID"))
            ws = spreadsheet.worksheet("Waiting Room")
            
            target_row = int(row_idx) if row_idx and str(row_idx).isdigit() else None
            
            # Find client row dynamically by Name if row index isn't directly valid
            if not target_row and name:
                names_col = ws.col_values(2)
                name_clean = str(name).strip().lower()
                for i, col_val in enumerate(names_col[1:], start=2):
                    if str(col_val).strip().lower() == name_clean:
                        target_row = i
                        break

            if not target_row:
                return jsonify({"error": "Client row could not be located"}), 404
            
            # Write Action FIRST, then Placement
            if action is not None:
                ws.update_cell(target_row, 5, str(action))
            if placement is not None:
                ws.update_cell(target_row, 4, str(placement))
                
            invalidate_public_cache()
            return jsonify({"status": "success", "note": "Updated via gspread direct write"})

        invalidate_public_cache()
        return jsonify({"status": "success"})

    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/waiting-room/delete", methods=["POST"])
@admin_required
def delete_waiting_room_row():
    try:
        data = request.json or {}
        row_idx = data.get("row_index")
        name = data.get("name")

        gc = get_sheets_client()
        spreadsheet = gc.open_by_key(os.environ.get("SPREADSHEET_ID"))
        ws = spreadsheet.worksheet("Waiting Room")

        target_row = int(row_idx) if row_idx and str(row_idx).isdigit() else None
        if not target_row and name:
            names_col = ws.col_values(2)
            name_clean = str(name).strip().lower()
            for i, col_val in enumerate(names_col[1:], start=2):
                if str(col_val).strip().lower() == name_clean:
                    target_row = i
                    break

        if not target_row:
            return jsonify({"error": "Client row not found for deletion"}), 404

        ws.delete_rows(target_row)
        invalidate_public_cache()
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
        
        rows = ws.get_all_values()
        
        if len(rows) < 3:
            return jsonify({"logs": []})

        data_rows = rows[2:]

        logs = []
        for row in reversed(data_rows):
            if not any(row):
                continue

            record = {
                "Submission Time": row[0].strip() if len(row) > 0 else "",
                "Name": row[1].strip() if len(row) > 1 else "",
                "Tattoo Session Date": row[2].strip() if len(row) > 2 else "",
                "Status": row[3].strip() if len(row) > 3 else "",
                "Reviewed By": row[4].strip() if len(row) > 4 else "",
                "Reviewed At": row[5].strip() if len(row) > 5 else ""
            }

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
        user_info = token.get('userinfo') or google.parse_id_token(token, nonce=None)
        email = user_info.get('email', '').lower() if user_info else ''
        
        is_admin = email in ADMIN_EMAILS if email else False
        session['user'] = {'email': email, 'is_admin': is_admin}
        
        if is_admin:
            return redirect(url_for('admin_dashboard'))
        return redirect(url_for('login_page', unauthorized=1))
    except Exception as e:
        print(f"OAuth Callback Error: {e}")
        return redirect(url_for('login_page'))

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
