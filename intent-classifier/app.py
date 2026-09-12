"""
BeeBright Intent Classifier microservice (Task 32, Part 3).

Loads the vectorizer + classifier trained in notebooks/train_intent_classifier.ipynb
and exposes ONE endpoint:

    POST /predict-intent   { "message": "..." }  ->  { "success": true, "intent": "...", "confidence": 0.87 }

This is an intent-DETECTION layer only:
  - it never generates reply text,
  - it never touches any database,
  - it has no knowledge of a user's role or account data — it only sees the raw
    message text handed to it and returns a label + a confidence score.
The Node.js backend (Part 4) decides what to do with that label — including all
role/data-scope enforcement, which happens exactly as it does today regardless of
what this service predicts.

Run as its own process, separate from the Node backend and from Jupyter:
    python app.py
Binds to 127.0.0.1:5002 by default (backend-to-backend only, not internet-facing;
5001 is already the Node backend, 11434 is Ollama). Override with env vars
INTENT_CLASSIFIER_HOST / INTENT_CLASSIFIER_PORT if needed.
"""
import json
import logging
import os
from pathlib import Path

import joblib
from flask import Flask, jsonify, request

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("intent-classifier")

BASE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BASE_DIR / "models"
MAX_MESSAGE_LEN = 2000  # defensive cap; mirrors the snippet caps used elsewhere in the app

HOST = os.environ.get("INTENT_CLASSIFIER_HOST", "127.0.0.1")
PORT = int(os.environ.get("INTENT_CLASSIFIER_PORT", "5002"))

app = Flask(__name__)

# ── Load model artifacts once at startup ────────────────────────────────────
vectorizer = None
classifier = None
metadata = {}
load_error = None

try:
    vectorizer = joblib.load(MODELS_DIR / "vectorizer.pkl")
    classifier = joblib.load(MODELS_DIR / "intent_classifier.pkl")
    with open(MODELS_DIR / "metadata.json", "r", encoding="utf-8") as f:
        metadata = json.load(f)
    logger.info(
        "Loaded model: %s | %d intents | test_accuracy=%.4f | trained_at=%s",
        metadata.get("model", "unknown"),
        len(metadata.get("labels", [])),
        metadata.get("test_accuracy", float("nan")),
        metadata.get("trained_at", "unknown"),
    )
except Exception as exc:  # noqa: BLE001 - we want to keep the process alive and report this
    load_error = str(exc)
    logger.error("Failed to load model artifacts from %s: %s", MODELS_DIR, exc)


def model_ready() -> bool:
    return vectorizer is not None and classifier is not None


@app.get("/health")
def health():
    """Lets the Node backend (or a human) check this service is actually up and
    has a model loaded, without spending a prediction call on it."""
    return jsonify({
        "success": model_ready(),
        "model": metadata.get("model"),
        "n_intents": len(metadata.get("labels", [])),
        "test_accuracy": metadata.get("test_accuracy"),
        "confidence_threshold": metadata.get("confidence_threshold"),
        "trained_at": metadata.get("trained_at"),
        "error": load_error,
    }), (200 if model_ready() else 503)


@app.post("/predict-intent")
def predict_intent():
    if not model_ready():
        return jsonify({"success": False, "message": "Model not loaded.", "error": load_error}), 503

    body = request.get_json(silent=True) or {}
    message = body.get("message")

    if not isinstance(message, str) or not message.strip():
        return jsonify({"success": False, "message": "\"message\" (non-empty string) is required."}), 400

    text = message.strip()[:MAX_MESSAGE_LEN]

    try:
        features = vectorizer.transform([text])
        proba = classifier.predict_proba(features)[0]
        best_idx = proba.argmax()
        intent = classifier.classes_[best_idx]
        confidence = float(proba[best_idx])
    except Exception as exc:  # noqa: BLE001 - never let a bad input 500 the service silently
        logger.exception("Prediction failed for message: %r", text)
        return jsonify({"success": False, "message": "Prediction failed.", "error": str(exc)}), 500

    return jsonify({
        "success": True,
        "intent": intent,
        "confidence": round(confidence, 4),
    })


if __name__ == "__main__":
    if not model_ready():
        logger.warning(
            "Starting WITHOUT a loaded model (%s). /predict-intent will return 503 until "
            "models/vectorizer.pkl and models/intent_classifier.pkl exist — run the "
            "training notebook first.",
            load_error,
        )
    logger.info("BeeBright intent classifier listening on http://%s:%s", HOST, PORT)
    app.run(host=HOST, port=PORT)
