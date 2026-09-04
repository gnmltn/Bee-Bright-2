const fs = require('fs');
const path = require('path');

const INTENTS_PATH = path.resolve(__dirname, '../ai_training/chat_intents.json');
const METRICS_PATH = path.resolve(__dirname, '../ai_training/model_metrics.json');
const MIN_CONFIDENCE = 0.34;
const KEYWORD_BOOST = 2.0;
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'am', 'was', 'were', 'be', 'been', 'being',
  'i', 'me', 'my', 'you', 'your', 'yours', 'we', 'our', 'ours',
  'to', 'of', 'for', 'in', 'on', 'at', 'by', 'with', 'and', 'or',
  'how', 'what', 'where', 'when', 'can', 'do', 'does', 'did', 'please'
]);

function readIntentDataset() {
  const raw = fs.readFileSync(INTENTS_PATH, 'utf8');
  const intents = JSON.parse(raw);
  if (!Array.isArray(intents) || intents.length === 0) {
    throw new Error('Chat intent dataset is empty or invalid.');
  }
  return intents;
}

function tokenize(text) {
  const baseTokens = normalizePlainText(text)
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !STOP_WORDS.has(token));

  const bigrams = [];
  for (let i = 0; i < baseTokens.length - 1; i += 1) {
    bigrams.push(`${baseTokens[i]}_${baseTokens[i + 1]}`);
  }

  return [...baseTokens, ...bigrams];
}

function normalizePlainText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsKeyword(text, keyword) {
  const normalizedText = normalizePlainText(text);
  const normalizedKeyword = normalizePlainText(keyword);

  if (!normalizedText || !normalizedKeyword) {
    return false;
  }

  const phrasePattern = new RegExp(
    `(^|\\s)${escapeRegex(normalizedKeyword).replace(/\s+/g, '\\s+')}($|\\s)`
  );

  return phrasePattern.test(normalizedText);
}

function buildExamples(intents) {
  return intents.flatMap((intent) =>
    (intent.examples || []).map((text, index) => ({
      intent: intent.intent,
      text,
      index
    }))
  );
}

function createCrossValidationFolds(intents, foldCount = 3) {
  const folds = Array.from({ length: foldCount }, () => []);
  for (const intent of intents) {
    const examples = (intent.examples || []).map((text) => ({ intent: intent.intent, text }));
    examples.forEach((example, index) => {
      folds[index % foldCount].push(example);
    });
  }
  return folds;
}

function trainModel(intents, trainExamples) {
  const documentFrequency = {};
  const preparedExamples = trainExamples.map((example) => {
    const tokens = tokenize(example.text);
    new Set(tokens).forEach((token) => {
      documentFrequency[token] = (documentFrequency[token] || 0) + 1;
    });
    return { intent: example.intent, text: example.text, tokens };
  });

  const idf = {};
  const totalDocs = trainExamples.length || 1;
  Object.entries(documentFrequency).forEach(([token, df]) => {
    idf[token] = Math.log((1 + totalDocs) / (1 + df)) + 1;
  });

  return {
    intents,
    trainExamples,
    idf,
    keywordsByIntent: Object.fromEntries(
      intents.map((intent) => [intent.intent, (intent.keywords || []).map((keyword) => String(keyword).toLowerCase())])
    ),
    trainingVectors: preparedExamples.map((example) => ({
      ...example,
      vector: vectorizeTokens(example.tokens, idf)
    }))
  };
}

function predictIntent(model, message) {
  const tokens = tokenize(message);
  if (tokens.length === 0) {
    return {
      intent: null,
      confidence: 0,
      probabilities: {}
    };
  }

  const scores = {};

  for (const intent of model.intents) {
    scores[intent.intent] = 0;
  }

  const queryVector = vectorizeTokens(tokens, model.idf);
  const normalizedMessage = normalizePlainText(message);
  for (const example of model.trainingVectors) {
    const similarity = cosineSimilarity(queryVector, example.vector);
    scores[example.intent] = Math.max(scores[example.intent], similarity);
  }

  for (const intent of model.intents) {
    const keywords = model.keywordsByIntent[intent.intent] || [];
    let keywordMatches = 0;
    for (const keyword of keywords) {
      if (containsKeyword(normalizedMessage, keyword)) {
        keywordMatches += 1;
      }
    }
    if (keywordMatches > 0) {
      const keywordBoost = (keywordMatches / keywords.length) * KEYWORD_BOOST;
      scores[intent.intent] += keywordBoost;
    }
  }

  const sumScores = Object.values(scores).reduce((sum, value) => sum + value, 0) || 1;
  const probabilities = Object.fromEntries(
    Object.entries(scores).map(([intent, value]) => [intent, value / sumScores])
  );
  const [bestIntent, confidence] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return {
    intent: bestIntent,
    confidence,
    probabilities
  };
}

function vectorizeTokens(tokens, idf) {
  const tf = {};
  tokens.forEach((token) => {
    if (idf[token]) {
      tf[token] = (tf[token] || 0) + 1;
    }
  });

  const totalTerms = Object.values(tf).reduce((sum, value) => sum + value, 0) || 1;
  const vector = {};
  Object.entries(tf).forEach(([token, count]) => {
    vector[token] = (count / totalTerms) * idf[token];
  });
  return vector;
}

function cosineSimilarity(vectorA, vectorB) {
  const keys = new Set([...Object.keys(vectorA), ...Object.keys(vectorB)]);
  let dot = 0;
  let normA = 0;
  let normB = 0;

  keys.forEach((key) => {
    const a = vectorA[key] || 0;
    const b = vectorB[key] || 0;
    dot += a * b;
    normA += a * a;
    normB += b * b;
  });

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function summarizeMetrics(intents, evaluationResults, trainingSamples, testSamples) {
  const labels = intents.map((intent) => intent.intent);
  const perIntent = {};
  let correct = 0;

  labels.forEach((label) => {
    perIntent[label] = { tp: 0, fp: 0, fn: 0, support: 0 };
  });

  for (const result of evaluationResults) {
    const { actualLabel, predictedLabel } = result;
    perIntent[actualLabel].support += 1;
    if (predictedLabel === actualLabel) {
      correct += 1;
      perIntent[actualLabel].tp += 1;
    } else {
      perIntent[actualLabel].fn += 1;
      if (predictedLabel && perIntent[predictedLabel]) {
        perIntent[predictedLabel].fp += 1;
      }
    }
  }

  const classes = labels.map((label) => {
    const stats = perIntent[label];
    const precision = stats.tp + stats.fp === 0 ? 0 : stats.tp / (stats.tp + stats.fp);
    const recall = stats.tp + stats.fn === 0 ? 0 : stats.tp / (stats.tp + stats.fn);
    const f1Score = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

    return {
      intent: label,
      precision: Number(precision.toFixed(4)),
      recall: Number(recall.toFixed(4)),
      f1Score: Number(f1Score.toFixed(4)),
      support: stats.support
    };
  });

  const macroPrecision = classes.reduce((sum, item) => sum + item.precision, 0) / classes.length;
  const macroRecall = classes.reduce((sum, item) => sum + item.recall, 0) / classes.length;
  const macroF1 = classes.reduce((sum, item) => sum + item.f1Score, 0) / classes.length;
  const accuracy = correct / (evaluationResults.length || 1);

  return {
    modelType: 'TF-IDF intent classifier with keyword boosting',
    evaluationMethod: '3-fold stratified cross-validation',
    datasetSize: evaluationResults.length,
    trainingSamplesPerFold: trainingSamples,
    evaluationSamples: testSamples,
    accuracy: Number(accuracy.toFixed(4)),
    precision: Number(macroPrecision.toFixed(4)),
    recall: Number(macroRecall.toFixed(4)),
    f1Score: Number(macroF1.toFixed(4)),
    classes
  };
}

function computeMetrics(intents) {
  const folds = createCrossValidationFolds(intents, 3);
  const allExamples = buildExamples(intents);
  const evaluationResults = [];

  for (let i = 0; i < folds.length; i += 1) {
    const testExamples = folds[i];
    const trainExamples = folds
      .filter((_, foldIndex) => foldIndex !== i)
      .flat();
    const model = trainModel(intents, trainExamples);

    for (const example of testExamples) {
      const prediction = predictIntent(model, example.text);
      evaluationResults.push({
        actualLabel: example.intent,
        predictedLabel: prediction.intent
      });
    }
  }

  const averageTrainingSamples = Math.round(
    folds.reduce((sum, fold) => sum + (allExamples.length - fold.length), 0) / folds.length
  );

  return summarizeMetrics(intents, evaluationResults, averageTrainingSamples, allExamples.length);
}

function saveMetrics(metrics) {
  const nextContent = JSON.stringify(metrics, null, 2);
  if (fs.existsSync(METRICS_PATH)) {
    const currentContent = fs.readFileSync(METRICS_PATH, 'utf8');
    if (currentContent === nextContent) {
      return;
    }
  }
  fs.writeFileSync(METRICS_PATH, nextContent);
}

function initializeChatIntentModel() {
  const intents = readIntentDataset();
  const allExamples = buildExamples(intents);
  const model = trainModel(intents, allExamples);
  const metrics = computeMetrics(intents);
  saveMetrics(metrics);

  return {
    model,
    metrics,
    repliesByIntent: Object.fromEntries(intents.map((intent) => [intent.intent, intent.reply]))
  };
}

const runtime = initializeChatIntentModel();

function getIntentReply(message) {
  const prediction = predictIntent(runtime.model, message);
  if (!prediction.intent || prediction.confidence < MIN_CONFIDENCE) {
    return {
      reply: 'I can help with schedules, enrollment, payments, and learning materials. Try asking about one of those.',
      intent: 'fallback',
      confidence: prediction.confidence
    };
  }

  return {
    reply: runtime.repliesByIntent[prediction.intent],
    intent: prediction.intent,
    confidence: Number(prediction.confidence.toFixed(4))
  };
}

function getChatModelMetrics() {
  return runtime.metrics;
}

module.exports = {
  getIntentReply,
  getChatModelMetrics
};
