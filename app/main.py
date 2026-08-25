import os
import requests
from flask import Flask, render_template, jsonify

app = Flask(__name__)

# Replace this with your deployed Google Apps Script Web App URL
APPS_SCRIPT_URL = os.environ.get("APPS_SCRIPT_URL", "YOUR_APPS_SCRIPT_WEB_APP_URL_HERE")

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/placement-data")
def get_placement_data():
    """Proxy route to fetch Google Apps Script data securely."""
    try:
        response = requests.get(APPS_SCRIPT_URL, timeout=10)
        response.raise_for_status()
        return jsonify(response.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
