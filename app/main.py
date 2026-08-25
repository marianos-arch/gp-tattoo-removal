import os
from flask import Flask, render_template, jsonify
import requests

app = Flask(__name__)

# Replace with your actual deployed Apps Script Web App URL
APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzMluI9ccaJ2uPdrdmKCrbeDr3rwF94YGiSrodvLjHhbgaon5aWMkbC69I0egRUQIqS/exec"

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

if __name__ == "__main__":
    # Standard local runs; Render will use Gunicorn
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
