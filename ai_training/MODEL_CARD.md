# Bee Bright AI Model Card

## Model Summary
- Model type: `TF-IDF intent classifier with keyword boosting`
- Runtime source: [chatIntentModel.js](/c:/BRIGHTBEE/beebright-ui-showcase/backend/utils/chatIntentModel.js)
- Metrics source: [model_metrics.json](/c:/BRIGHTBEE/beebright-ui-showcase/backend/ai_training/model_metrics.json)
- Deployment surfaces:
  - Public landing chatbot
  - Authenticated student/tutor/admin chat endpoints
  - Recommendation support for students and tutors

## Objective
The model is designed to answer Bee Bright-specific questions consistently, safely, and in a grounded way. It prioritizes:
- enrollment guidance
- payment guidance
- schedule and materials guidance
- tutor/admin support questions
- multilingual handling for English, Filipino, and Taglish users

## Inputs
- User message text
- Optional conversation history
- Optional grounded account context from the backend

## Outputs
- Intent label
- Confidence score
- Deterministic reply or grounded chatbot response

## Evaluation
- Cross-validation: `3-fold stratified cross-validation`
- Metrics tracked:
  - Accuracy
  - Precision
  - Recall
  - F1 Score
- Class-level metrics are stored in [model_metrics.json](/c:/BRIGHTBEE/beebright-ui-showcase/backend/ai_training/model_metrics.json)

## Interpretability
This model is explainable because:
- it uses tokenized text features
- keyword boosts are explicit per intent
- confidence and predicted intent are available at runtime
- reply generation is rule-guided instead of opaque end-to-end generation

## Decision Logic
1. Normalize and tokenize the user message.
2. Compute TF-IDF style similarity against known intent examples.
3. Add keyword boosts for intent-specific phrases.
4. Pick the highest-scoring intent if it passes confidence threshold.
5. Apply language profile handling.
6. Ground the reply with account or system context when available.

## Safety Boundaries
- System responses are scoped to Bee Bright topics.
- Grounded context prevents inventing account details.
- Chat rate limiting reduces abuse.
- Behavior benchmarks reject unsupported or policy-breaking response patterns.

## Known Limitations
- The model is domain-specific and not a general-purpose assistant.
- It depends on the quality of curated intents and examples.
- Full LLM behavior depends on Ollama availability when enabled.
