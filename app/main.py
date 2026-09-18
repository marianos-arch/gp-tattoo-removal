import os
from functools import wraps
from flask import Flask, render_template, jsonify, session, redirect, url_for, request
from authlib.integrations.flask_client import OAuth
import requests

app = Flask(__name__)

# Secret key required for session management
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "dev-secret-key-change-me")

# List of Google emails authorized to access the admin shell
ADMIN_EMAILS = os.environ.get("ADMIN_EMAILS", "admin@gardenpathways.org").split(",")

# Google OAuth Setup
oauth = OAuth(app)
google = oauth.register(
    name='google',
    client_id=os.environ.get("GOOGLE_CLIENT_ID"),
    client_secret=os.environ.get("GOOGLE_CLIENT_SECRET"),
    server_metadata_url='https://accounts.google.com/.well-known/openid-configuration',
    client_kwargs={'scope': 'openid email profile'}
)

APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzMluI9ccaJ2uPdrdmKCrbeDr3rwF94YGiSrodvLjHhbgaon5aWMkbC69I0egRUQIqS/exec"

def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        user = session.get('user')
        # If user is not logged in or not an authorized admin, show the login page
        if not user or not user.get('is_admin'):
            return redirect(url_for('login_page'))
        return f(*args, **kwargs)
    return decorated_function


# --- PUBLIC ROUTES ---

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/placements")
def get_placements():
    """Proxies the request to Apps Script to protect your web app URL if needed."""
    try:
        response = requests.get(APPS_SCRIPT_URL, timeout=10)
        response.raise_for_status()
        return jsonify(response.json())
    except Exception as e:
        return jsonify({"error": str(e), "placements": [], "spots_left": 0}), 500


# --- ADMIN & AUTHENTICATION ROUTES ---

@app.route("/admin/login")
def login_page():
    """Displays the public notice explaining that login is required for admin access."""
    return render_template("login.html")

@app.route("/login/google")
def trigger_google_login():
    """Initiates the Google OAuth login flow."""
    redirect_uri = url_for('auth_callback', _external=True)
    return google.authorize_redirect(redirect_uri)

@app.route("/auth/callback")
def auth_callback():
    """Handles callback from Google OAuth."""
    try:
        token = google.authorize_access_token()
        user_info = token.get('userinfo')
        
        if user_info:
            email = user_info.get('email')
            is_admin = email in ADMIN_EMAILS
            
            session['user'] = {
                'email': email,
                'is_admin': is_admin
            }
            
            if is_admin:
                return redirect(url_for('admin_dashboard'))
            
            # If logged in but not an authorized admin, bounce to login page with a parameter
            return redirect(url_for('login_page', unauthorized=1))
    except Exception:
        pass
        
    return redirect(url_for('index'))

@app.route("/admin")
@admin_required
def admin_dashboard():
    """Protected Admin Shell page."""
    return render_template("admin.html")

@app.route("/logout")
def logout():
    session.pop('user', None)
    return redirect(url_for('index'))


if __name__ == "__main__":
    # Standard local runs; Render will use Gunicorn
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
