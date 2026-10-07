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

# "Waiting Room" has two header rows; data starts on row 3 (same as the Apps Script,
# which ignores anything above row 3). Change this if your layout ever changes.
WAITING_ROOM_FIRST_DATA_ROW = 3

# Stay under gunicorn's default 30s worker timeout. The Apps Script can legitimately
# take 5+ seconds (it sleeps between steps) and up to 45s if it has to wait for its lock.
APPS_SCRIPT_TIMEOUT_SECONDS = 25

def normalize_name(value):
    return str(value or "").strip().lower()

def parse_row_index(value):
    """Return a usable sheet row number, or None. Anything above the first data row is a header."""
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if n >= WAITING_ROOM_FIRST_DATA_ROW else None

def find_waiting_room_row(ws, row_idx, name):
    """Locate a client's CURRENT row. The NAME is the identity; row_idx is only a hint,
    because the sheet re-sorts and deletes rows whenever a status/placement changes.

    Returns (row_number, None) on success, or (None, (message, http_status))."""
    hint = parse_row_index(row_idx)
    target = normalize_name(name)

    if not target:
        # Nothing to verify against; fall back to trusting the row number
        if hint:
            return hint, None
        return None, ("Client row could not be located", 404)

    names_col = ws.col_values(2)  # index 0 == row 1
    matches = [
        row_no for row_no, value in enumerate(names_col, start=1)
        if row_no >= WAITING_ROOM_FIRST_DATA_ROW and normalize_name(value) == target
    ]

    if not matches:
        return None, ("Client is no longer in the waiting room", 404)
    if hint in matches:
        return hint, None
    if len(matches) == 1:
        return matches[0], None
    return None, ("More than one client has this name; edit it in the sheet", 409)

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
    """Sends payload including Client Name to Apps Script to preserve identity across reindexes.

    Returns one of:
      "success"      - the script ran and reported success
      "busy"         - the script is mid-way through another change; nothing was applied
      "unconfigured" - APPS_SCRIPT_URL is not set
      "error"        - the script could not be reached or reported a failure
      "timeout"      - we stopped waiting; the script MAY still be running or have finished
    """
    url = os.environ.get("APPS_SCRIPT_URL")
    if not url:
        print("Warning: APPS_SCRIPT_URL environment variable is not set.")
        return "unconfigured"

    payload = {
        "sheetName": "Waiting Room",
        "row_index": int(row_index) if row_index is not None and str(row_index).isdigit() else None,
        "name": str(name).strip() if name else None,
        "action": action,
        "placement": str(placement) if placement is not None else None
    }

    try:
        response = requests.post(url, json=payload, timeout=APPS_SCRIPT_TIMEOUT_SECONDS, allow_redirects=True)
        if response.ok:
            res_data = response.json()
            if res_data.get("status") == "success":
                return "success"
            if res_data.get("status") == "busy":
                return "busy"
            print(f"Apps Script Error Response: {res_data.get('message') or res_data.get('error')}")
            return "error"
        return "error"
    except requests.exceptions.ConnectTimeout:
        print("Apps Script connect timeout (request was never delivered)")
        return "error"
    except requests.exceptions.Timeout:
        print("Apps Script read timeout (outcome unknown)")
        return "timeout"
    except Exception as e:
        print(f"Failed to call Apps Script: {e}")
        return "error"

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
        for row in all_rows[WAITING_ROOM_FIRST_DATA_ROW - 1:]:  # rows 1-2 are headers
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
        if len(all_rows) < WAITING_ROOM_FIRST_DATA_ROW:
            return jsonify({"queue": []})

        queue = []
        for idx, row in enumerate(all_rows[WAITING_ROOM_FIRST_DATA_ROW - 1:], start=WAITING_ROOM_FIRST_DATA_ROW):
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

        # Preserve explicit surname-first names; otherwise use the final word
        # as the surname. Enter compound surnames explicitly as "Last, First".
        if "," in name:
            last_name, given_names = name.split(",", 1)
            name = f"{' '.join(last_name.split())}, {' '.join(given_names.split())}"
        else:
            name_parts = name.split()
            if len(name_parts) > 1:
                name = f"{name_parts[-1]}, {' '.join(name_parts[:-1])}"

        raw_phone = str(data.get("phone_number") or "").strip()
        phone_digits = re.sub(r"\D", "", raw_phone)
        if len(phone_digits) == 11 and phone_digits.startswith("1"):
            phone_digits = phone_digits[1:]
        if not re.fullmatch(r"[0-9()+.\s-]+", raw_phone) or not re.fullmatch(r"[0-9]{10}", phone_digits):
            return jsonify({"error": "Enter a complete 10-digit U.S. phone number."}), 400
        phone_number = f"+1{phone_digits}"

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
            routing_status,
            "Yes",          # G: SMS consent
            "'" + phone_number,   # H: Preserve +1 as text with USER_ENTERED
            ""              # I: SMS log
        ]

        ws.insert_row(
            row_payload,
            index=3,
            value_input_option="USER_ENTERED",
            inherit_from_before=False,
        )
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
        
        if not parse_row_index(row_idx) and not normalize_name(name):
            return jsonify({"error": "Row index or name is required"}), 400

        gc = get_sheets_client()
        spreadsheet = gc.open_by_key(os.environ.get("SPREADSHEET_ID"))
        ws = spreadsheet.worksheet("Waiting Room")

        # Identity check: find this client's CURRENT row by name. The row number the
        # browser sent may be stale because the sheet re-sorts / deletes rows on every change.
        target_row, err = find_waiting_room_row(ws, row_idx, name)
        if err:
            return jsonify({"error": err[0]}), err[1]

        # 1. Preferred path: the Apps Script (runs routing, logging and re-indexing)
        outcome = trigger_apps_script(target_row, name=name, action=action, placement=placement)

        if outcome == "success":
            invalidate_public_cache()
            return jsonify({"status": "success"})

        # 2a. The script is busy with another change and applied nothing. Do NOT write around
        #     it (a direct write would skip routing/logging); ask the admin to retry.
        if outcome == "busy":
            return jsonify({
                "error": "The sheet is busy processing another change. Please try again in a moment."
            }), 503

        # Never claim SMS/routing finished just because the action cell changed.
        # The script may still be running after a timeout; do not repeat its writes.
        if outcome == "timeout":
            invalidate_public_cache()
            return jsonify({
                "error": "The update could not be confirmed. Check the queue and column I in the sheet before retrying."
            }), 504

        if outcome == "unconfigured":
            return jsonify({"error": "APPS_SCRIPT_URL is not configured. No update was sent."}), 503

        # An Apps Script failure can happen after partial processing. A raw write
        # would hide the error and skip SMS, logging, and placement automation.
        invalidate_public_cache()
        return jsonify({
            "error": "Apps Script did not confirm this update. Check Apps Script Executions and the sheet before retrying."
        }), 502

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

        # Never delete by a remembered row number alone: confirm it is still this person
        target_row, err = find_waiting_room_row(ws, row_idx, name)
        if err:
            return jsonify({"error": err[0]}), err[1]

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
