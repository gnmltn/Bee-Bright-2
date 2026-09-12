# BeeBright Intent Classifier (Task 32)

A standalone Python/ML microservice — separate from the Node.js backend and separate
from phi/Ollama. It is an **intent-detection layer only**: given a user message, it
predicts `{intent, confidence}`. It never generates reply text and never touches the
database; the actual answer still comes from `aiResponseDatasets.js` or the existing
grounded DB lookups in `backend/controllers/aiController.js`, exactly as before. It runs
as an *additional signal* alongside the existing weighted-keyword matcher (Task 19/20),
with a fallback to that matcher whenever confidence is low or this service is down.

## Layout

```
intent-classifier/
  data/                          4 role-based training CSVs (Task 32 Part 1)
    public_users_expanded.csv
    student_parent_users_expanded.csv
    tutor_users_expanded.csv
    admin_users_expanded.csv
  notebooks/
    train_intent_classifier.ipynb   Part 2 — training notebook (run + saved with output)
    _build_notebook.py              generates the notebook above; not itself a deliverable
  models/                         Part 2 output, loaded by the Part 3 service
    vectorizer.pkl                 fitted TfidfVectorizer
    intent_classifier.pkl          fitted CalibratedClassifierCV(LinearSVC)
    metadata.json                  accuracy, chosen confidence threshold, label list
    class_balance.png / confusion_matrix.png / confidence_distribution.png
  app.py                          Part 3 — Flask microservice (POST /predict-intent)
  requirements.txt
```

## Part 2 result (see the notebook for full detail)

- Originally 2,538 raw training rows → 2,328 after removing exact cross-role duplicates
  (129 intents, 18–20 examples each). No label conflicts.
- **Retrained twice on 2026-09-12:**
  1. Task 36 follow-up: 10 named-child `parent_contact` examples added (e.g. "Can I
     contact Carlo's tutor?") after live testing found the classifier sometimes
     misrouted named-child phrasing to `contact_tutor` (the student-facing intent) — the
     original `parent_contact` rows were all generic "my child's tutor" phrasing, no
     names. This alone moved the safe confidence threshold from 0.55 to **0.65** (test
     coverage dropped from ~74% to ~46% — the new examples sit closer to
     `contact_tutor`'s decision boundary, pulling overall calibration down).
  2. Task 34 Batch 4: added a **new 130th intent**, `tutor_wellbeing_check` (18 examples,
     tutor asking an oversight question about a specific student's wellbeing/behavior —
     deliberately a different name/training set from `student_distress` /
     `distress_detection` / `student_discussion`, which stay reserved for Task 3's active
     safety-screening path). This retrain **recovered** the threshold back to 0.55 and
     coverage back to ~74% — a cleanly-separable new class improved overall calibration
     rather than hurting it. **Always re-check `metadata.json`'s `confidence_threshold`
     after any retrain and sync `backend/.env`'s `INTENT_CLASSIFIER_CONFIDENCE_THRESHOLD`
     to match — it is not guaranteed to move in the direction you'd expect.**
- Model shipped: `LinearSVC` wrapped in `CalibratedClassifierCV` (cv=5) — **97.9%**
  test accuracy (80/20 stratified split, 1,884 rows, 130 intents), with genuine
  `predict_proba` confidence scores (plain `LogisticRegression` alone reached ~91%).
- Confidence threshold: **0.55**, chosen as the lowest threshold with **zero** wrong
  predictions among "trusted" ones on the held-out test set (100% precision at that
  cutoff), covering ~74% of test traffic. See the notebook's threshold-sweep cell for
  the current full table.

## Reproducing / retraining

```
pip install -r requirements.txt
cd notebooks
python _build_notebook.py     # regenerates the notebook cells
jupyter nbconvert --to notebook --execute --inplace train_intent_classifier.ipynb
```

Or open `train_intent_classifier.ipynb` in Jupyter/VS Code and run all cells directly —
`_build_notebook.py` is only a convenience for regenerating it from source, not required
to read or re-run the delivered notebook.
